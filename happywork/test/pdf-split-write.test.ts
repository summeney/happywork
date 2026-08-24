import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ExitCode, HappyworkError } from "../src/core/errors.ts";
import { guardOutDir } from "../src/core/fs.ts";
import { readPdfMetaAsync } from "../src/infra/pdf/meta.ts";
import { planSplit, type Chapter } from "../src/infra/pdf/plan.ts";
import { chunkFileName, sanitizeBaseName, writeSplit } from "../src/infra/pdf/split.ts";

const BOOK = resolve(
  import.meta.dir,
  "../../documents/books/《投资的护城河-晨星公司解密巴菲特股市投资法则》+[希瑟].pdf",
);
const hasBook = existsSync(BOOK);

const CHAPTERS: Chapter[] = [
  { title: "1", printedStart: 1 },
  { title: "2", printedStart: 13 },
  { title: "3", printedStart: 37 },
  { title: "4", printedStart: 65 },
  { title: "5", printedStart: 89 },
  { title: "6", printedStart: 103 },
  { title: "7", printedStart: 125 },
  { title: "8", printedStart: 135 },
  { title: "9", printedStart: 147 },
  { title: "10", printedStart: 159 },
  { title: "11", printedStart: 175 },
];

describe("分片文件名", () => {
  test("零填充序号 + 1 基源页区间，按名称升序即原书顺序", () => {
    expect(chunkFileName("book", 1, 2, 0, 141)).toBe("book_01_p0001-0142.pdf");
    expect(chunkFileName("book", 2, 2, 142, 265)).toBe("book_02_p0143-0266.pdf");
    expect(chunkFileName("book", 1, 2, 0, 141) < chunkFileName("book", 2, 2, 142, 265)).toBe(true);
  });

  test("文件系统敏感字符被替换，中文书名号保留", () => {
    expect(sanitizeBaseName("a/b:c*?")).toBe("a_b_c__");
    expect(sanitizeBaseName("《投资的护城河》+[希瑟]")).toBe("《投资的护城河》+[希瑟]");
  });
});

describe("--force 覆盖保护", () => {
  test("目录非空且无 --force：以 output-dir-not-empty 拒绝，退出码 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-split-"));
    writeFileSync(join(dir, "x.txt"), "x");
    try {
      let err: HappyworkError | undefined;
      try {
        guardOutDir(dir, false);
      } catch (e) {
        err = e as HappyworkError;
      }
      expect(err?.code).toBe("output-dir-not-empty");
      expect(err?.exitCode).toBe(ExitCode.INPUT);
      expect(() => guardOutDir(dir, true)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.if(hasBook)("实跑拆分样本书（章节对齐）", () => {
  test("分片数、页数与体积未超限、页数之和 266、manifest 第二分片印刷页 [135,258]", async () => {
    const meta = await readPdfMetaAsync(BOOK);
    const opts = { maxPages: 200, maxBytes: 190_000_000, overlap: 0, chapters: CHAPTERS };
    const plan = planSplit(meta, opts);
    const dir = mkdtempSync(join(tmpdir(), "hw-split-out-"));
    try {
      const manifest = await writeSplit(meta, plan, { ...opts, alignChapters: BOOK }, dir);

      expect(manifest.chunks).toHaveLength(2);
      for (const c of manifest.chunks) {
        expect(c.pages).toBeLessThanOrEqual(200);
        expect(c.bytes).toBeLessThanOrEqual(190_000_000);
        expect(existsSync(join(dir, c.file))).toBe(true);
      }
      expect(manifest.chunks.reduce((s, c) => s + c.pages, 0)).toBe(266);

      expect(manifest.chunks[1]!.printedStart).toBe(135);
      expect(manifest.chunks[1]!.printedEnd).toBe(258);

      // manifest 从磁盘读回也应一致，且含源文件指纹与选项
      const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      expect(onDisk.source.pages).toBe(266);
      expect(onDisk.source.sha256).toBe(meta.sha256);
      expect(onDisk.pageLabels.offset).toBe(7);
      expect(onDisk.options.maxPages).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
