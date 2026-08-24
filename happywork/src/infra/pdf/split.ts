/**
 * 拆分写盘与 manifest（capability: happywork/pdf-split）
 *
 * planSplit 只算方案（design 决策 6），本模块负责把方案落成分片 PDF 与
 * 一份 manifest.json。`/PageLabels` 不随 copyPages 继承（主流库都会丢），
 * 因此页码映射只写进 manifest（design 决策 4），下游据此还原原始位置。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { toPrinted, type PdfMeta } from "./meta.ts";
import type { PlanOptions, SplitPlan } from "./plan.ts";

export interface ManifestChunk {
  index: number;
  file: string;
  /** 实际源页区间（含重叠），0 基闭区间 */
  srcStart: number;
  srcEnd: number;
  /** 印刷页区间；无 /PageLabels 时为 null */
  printedStart: number | null;
  printedEnd: number | null;
  pages: number;
  bytes: number;
  overlapPages: number;
}

export interface Manifest {
  source: { path: string; sha256: string; bytes: number; pages: number };
  pageLabels: {
    segments: { startPage: number; style: string; start: number }[];
    offset: number | null;
  };
  options: {
    maxPages: number;
    maxBytes: number;
    overlap: number;
    alignChapters: string | null;
  };
  chunks: ManifestChunk[];
}

/** 文件系统敏感字符 → 下划线；保留中文书名号等安全字符 */
export function sanitizeBaseName(name: string): string {
  return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").trim();
}

/**
 * 分片文件名：`<书名>_<零填充序号>_p<起页>-<止页>.pdf`（源页为 1 基）。
 * 按名称升序即原书顺序。
 */
export function chunkFileName(
  baseName: string,
  index: number,
  total: number,
  srcStart: number,
  srcEnd: number,
): string {
  const idxWidth = Math.max(2, String(total).length);
  const seq = String(index).padStart(idxWidth, "0");
  const from = String(srcStart + 1).padStart(4, "0");
  const to = String(srcEnd + 1).padStart(4, "0");
  return `${sanitizeBaseName(baseName)}_${seq}_p${from}-${to}.pdf`;
}

/** 默认输出目录：与输入同级的 `<输入名去扩展>_split/` */
export function defaultOutDir(inputPath: string): string {
  const dir = inputPath.slice(0, inputPath.length - basename(inputPath).length);
  const stem = basename(inputPath, extname(inputPath));
  return join(dir, `${stem}_split`);
}

/**
 * 按方案抽页写出各分片 PDF 与 manifest.json。返回写好的 manifest。
 * 调用方需已完成 --force 覆盖保护与目录守卫。
 */
export async function writeSplit(
  meta: PdfMeta,
  plan: SplitPlan,
  opts: PlanOptions & { alignChapters?: string | null },
  outDir: string,
): Promise<Manifest> {
  mkdirSync(outDir, { recursive: true });

  const src = await PDFDocument.load(await Bun.file(meta.path).arrayBuffer());
  const stem = basename(meta.path, extname(meta.path));
  const total = plan.chunks.length;
  const chunks: ManifestChunk[] = [];

  for (const c of plan.chunks) {
    const file = chunkFileName(stem, c.index, total, c.srcStart, c.srcEnd);
    const out = await PDFDocument.create();
    const indices = Array.from({ length: c.srcEnd - c.srcStart + 1 }, (_, i) => c.srcStart + i);
    const copied = await out.copyPages(src, indices);
    for (const p of copied) out.addPage(p);
    const outBytes = await out.save();
    writeFileSync(join(outDir, file), outBytes);

    chunks.push({
      index: c.index,
      file,
      srcStart: c.srcStart,
      srcEnd: c.srcEnd,
      printedStart: toPrinted(c.srcStart, meta.offset),
      printedEnd: toPrinted(c.srcEnd, meta.offset),
      pages: c.pages,
      bytes: outBytes.length,
      overlapPages: c.overlapPages,
    });
  }

  const manifest: Manifest = {
    source: { path: meta.path, sha256: meta.sha256, bytes: meta.bytes, pages: meta.pages },
    pageLabels: {
      segments: meta.labels.map((l) => ({ startPage: l.startPage, style: l.style, start: l.start })),
      offset: meta.offset,
    },
    options: {
      maxPages: opts.maxPages,
      maxBytes: opts.maxBytes,
      overlap: opts.overlap,
      alignChapters: opts.alignChapters ?? null,
    },
    chunks,
  };

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
