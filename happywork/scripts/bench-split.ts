/**
 * 一次性选型基准（任务 1.2–1.4）
 *
 * 对同一本书用 pdf-lib 与 mupdf 各拆一次，量三个数：
 *   1. 耗时  2. 峰值 RSS  3. 各分片字节数之和 / 原文件字节数（膨胀比，选型硬约束）
 * 同时验证两者能否读出 /PageLabels。
 *
 * 用法: bun scripts/bench-split.ts <pdf> [切点]
 */
import { mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = process.argv[2] ? resolve(process.argv[2]) : "";
const cut = Number(process.argv[3] ?? 142);
const outDir = resolve(".bench");

if (!src) {
  console.error("用法: bun scripts/bench-split.ts <pdf> [切点]");
  process.exit(1);
}

const srcBytes = statSync(src).size;
const srcBuf = readFileSync(src);

type Result = {
  lib: string;
  ok: boolean;
  ms: number;
  peakRssMb: number;
  outBytes: number;
  ratio: number;
  chunks: { pages: number; bytes: number }[];
  pageLabels: string;
  error?: string;
};

async function measure(fn: () => Promise<void>): Promise<{ ms: number; peak: number }> {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    const r = process.memoryUsage.rss();
    if (r > peak) peak = r;
  }, 20);
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  clearInterval(timer);
  return { ms, peak };
}

async function benchPdfLib(): Promise<Result> {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const chunks: { pages: number; bytes: number }[] = [];
  let pageLabels = "-";
  const { ms, peak } = await measure(async () => {
    const doc = await PDFDocument.load(srcBuf, { updateMetadata: false });
    const total = doc.getPageCount();
    const ranges: [number, number][] = [[0, cut - 1], [cut, total - 1]];
    for (const [a, b] of ranges) {
      const out = await PDFDocument.create();
      const idx = Array.from({ length: b - a + 1 }, (_, i) => a + i);
      const copied = await out.copyPages(doc, idx);
      copied.forEach((p) => out.addPage(p));
      const bytes = await out.save();
      writeFileSync(join(outDir, `pdflib_${a}-${b}.pdf`), bytes);
      chunks.push({ pages: idx.length, bytes: bytes.byteLength });
    }
    try {
      const pl = (doc as any).catalog.get(PDFName.of("PageLabels"));
      pageLabels = pl ? `catalog 中存在: ${String(pl).slice(0, 80)}` : "catalog 中不存在";
    } catch (e) {
      pageLabels = `读取失败: ${(e as Error).message}`;
    }
  });
  const outBytes = chunks.reduce((s, c) => s + c.bytes, 0);
  return { lib: "pdf-lib", ok: true, ms, peakRssMb: peak / 1048576, outBytes, ratio: outBytes / srcBytes, chunks, pageLabels };
}

async function benchMupdf(): Promise<Result> {
  const mupdf: any = await import("mupdf");
  const chunks: { pages: number; bytes: number }[] = [];
  let pageLabels = "-";
  const { ms, peak } = await measure(async () => {
    const doc = mupdf.PDFDocument.openDocument(srcBuf, "application/pdf");
    const total = doc.countPages();
    const ranges: [number, number][] = [[0, cut - 1], [cut, total - 1]];
    for (const [a, b] of ranges) {
      const out = new mupdf.PDFDocument();
      for (let i = a; i <= b; i++) out.graftPage(-1, doc, i);
      const bytes = out.saveToBuffer("compress").asUint8Array();
      writeFileSync(join(outDir, `mupdf_${a}-${b}.pdf`), bytes);
      chunks.push({ pages: b - a + 1, bytes: bytes.byteLength });
    }
    try {
      const root = doc.getTrailer().get("Root");
      const pl = root.get("PageLabels");
      pageLabels = pl && !pl.isNull() ? `可读: ${String(pl).slice(0, 80)}` : "Root 中无 /PageLabels";
    } catch (e) {
      pageLabels = `读取失败: ${(e as Error).message}`;
    }
  });
  const outBytes = chunks.reduce((s, c) => s + c.bytes, 0);
  return { lib: "mupdf", ok: true, ms, peakRssMb: peak / 1048576, outBytes, ratio: outBytes / srcBytes, chunks, pageLabels };
}

const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`源文件: ${src}`);
console.log(`大小:   ${srcBytes} (${mb(srcBytes)})`);
console.log(`切点:   页 ${cut}（0 基）\n`);

const results: Result[] = [];
for (const [name, fn] of [["pdf-lib", benchPdfLib], ["mupdf", benchMupdf]] as const) {
  try {
    results.push(await fn());
  } catch (e) {
    results.push({ lib: name, ok: false, ms: 0, peakRssMb: 0, outBytes: 0, ratio: 0, chunks: [], pageLabels: "-", error: (e as Error).stack ?? (e as Error).message });
  }
}

for (const r of results) {
  console.log(`── ${r.lib} ${"─".repeat(44)}`);
  if (!r.ok) {
    console.log(`  失败: ${r.error}\n`);
    continue;
  }
  console.log(`  耗时:       ${r.ms.toFixed(0)} ms`);
  console.log(`  峰值 RSS:   ${r.peakRssMb.toFixed(0)} MB`);
  console.log(`  分片:       ${r.chunks.map((c) => `${c.pages}页/${mb(c.bytes)}`).join("   ")}`);
  console.log(`  产出合计:   ${r.outBytes} (${mb(r.outBytes)})`);
  console.log(`  膨胀比:     ${r.ratio.toFixed(3)}×  ${r.ratio > 1.1 ? "⚠️ 超 1.1" : "✅"}`);
  console.log(`  PageLabels: ${r.pageLabels}`);
  console.log();
}
