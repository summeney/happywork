import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";

import { ExitCode } from "../src/core/errors.ts";
import { adviseSplit } from "../src/infra/pdf/advice.ts";
import { computeOffset, readPdfMetaAsync, toPrinted } from "../src/infra/pdf/meta.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const BOOK = resolve(
  import.meta.dir,
  "../../documents/books/《投资的护城河-晨星公司解密巴菲特股市投资法则》+[希瑟].pdf",
);
const hasBook = existsSync(BOOK);

async function run(...argv: string[]) {
  const p = Bun.spawn(["bun", CLI, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await p.exited };
}

function parseEntries(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("  ")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    m.set(line.slice(0, i).trim(), line.slice(i + 1).trimStart());
  }
  return m;
}

describe.skipIf(!hasBook)("样本书侦察（266 页扫描版）", () => {
  test("基础元信息：266 页、字节数、sha256", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    expect(meta.pages).toBe(266);
    expect(meta.bytes).toBe(43_099_648);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.path).toBe(BOOK);
  });

  test("文字层判定：无文字层，依据为 fonts=0 且逐页整版图像", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    expect(meta.textLayer.present).toBe(false);
    expect(meta.textLayer.fonts).toBe(0);
    expect(meta.textLayer.toUnicode).toBe(0);
    expect(meta.textLayer.imagePages).toBe(266);
  });

  test("PageLabels 解析出三段，offset 为 7", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    expect(meta.labels.map((l) => [l.startPage, l.style])).toEqual([
      [0, "A"],
      [3, "r"],
      [8, "D"],
    ]);
    expect(meta.offset).toBe(7);
  });

  test("印刷页换算与实读页面一致", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    // 探索阶段实读：PDF idx30 页脚为「第2章…23」，idx150 为「第8章…143」
    expect(toPrinted(8, meta.offset)).toBe(1);
    expect(toPrinted(30, meta.offset)).toBe(23);
    expect(toPrinted(150, meta.offset)).toBe(143);
    expect(toPrinted(3, meta.offset)).toBeNull();
  });

  test("逐页图像元信息", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    const p30 = meta.pageMetas[30]!;
    expect(p30.images).toHaveLength(1);
    expect(p30.images[0]!.filter).toBe("DCTDecode");
    expect(p30.images[0]!.width).toBe(1760);
    expect(p30.images[0]!.height).toBe(2768);
  });

  test("逐页字节估算足以支撑体积拆分（覆盖率 > 95%）", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    const sum = meta.pageMetas.reduce((s, p) => s + p.bytes, 0);
    expect(sum / meta.bytes).toBeGreaterThan(0.95);
    expect(sum).toBeLessThanOrEqual(meta.bytes);
  });

  test("拆分建议：超过页数上限", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    const a = adviseSplit(meta, 200, 190_000_000);
    expect(a.needsSplit).toBe(true);
    expect(a.reasons.join()).toContain("pages 266 > maxPages 200");
    expect(a.reasons.join()).not.toContain("bytes");
  });

  test("未超限时 needsSplit 为 false", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    expect(adviseSplit(meta, 300, 190_000_000).needsSplit).toBe(false);
  });

  test("命令输出符合语法且含四个区块", async () => {
    const r = await run("pdf", "info", BOOK);
    expect(r.exitCode).toBe(ExitCode.OK);
    for (const b of ["SOURCE", "TEXT-LAYER", "PAGE-LABELS", "SPLIT-ADVICE"]) {
      expect(r.stdout).toContain(b);
    }
    const e = parseEntries(r.stdout);
    expect(e.get("pages")).toBe("266");
    expect(e.get("present")).toBe("no");
    expect(e.get("offset")).toBe("7");
    expect(e.get("needsSplit")).toBe("yes");
    // 含空格与中文书名号的路径原样取回
    expect(e.get("path")).toBe(BOOK);
  });

  test("--pages 输出逐页条目，默认不输出", async () => {
    const withPages = await run("pdf", "info", BOOK, "--pages");
    expect(withPages.stdout).toContain("PAGES");
    expect(withPages.stdout).toContain("DCTDecode");
    const without = await run("pdf", "info", BOOK);
    expect(without.stdout).not.toContain("PAGES");
    expect(without.stdout).not.toContain("DCTDecode");
  });
});

describe("边界情形", () => {
  test("文件不存在：退出码 2，错误码 input-not-found", async () => {
    const r = await run("pdf", "info", "/definitely/missing/x.pdf");
    expect(r.exitCode).toBe(ExitCode.INPUT);
    expect(r.stderr.split("\n")[0]).toBe("ERROR input-not-found");
    expect(r.stdout).toBe("");
  });

  test("不是合法 PDF：退出码 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const bad = join(dir, "bad.pdf");
    writeFileSync(bad, "这不是 PDF");
    try {
      const r = await run("pdf", "info", bad);
      expect(r.exitCode).toBe(ExitCode.INPUT);
      expect(r.stderr).toContain("ERROR input-not-a-pdf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("无 PageLabels 的 PDF：offset 渲染为 -，不报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "plain.pdf");
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    writeFileSync(f, await doc.save());
    try {
      const meta = await readPdfMetaAsync(f);
      expect(meta.labels).toEqual([]);
      expect(meta.offset).toBeNull();
      const r = await run("pdf", "info", f);
      expect(r.exitCode).toBe(ExitCode.OK);
      expect(parseEntries(r.stdout).get("offset")).toBe("-");
      expect(r.stdout).not.toContain("null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("computeOffset 在无阿拉伯数字段时返回 null", () => {
    expect(computeOffset([{ startPage: 0, style: "r", start: 1 }])).toBeNull();
    expect(computeOffset([{ startPage: 8, style: "D", start: 1 }])).toBe(7);
    expect(computeOffset([{ startPage: 10, style: "D", start: 3 }])).toBe(7);
  });
});
