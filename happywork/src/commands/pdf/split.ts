/**
 * happywork pdf split —— 拆分 PDF 并产出 manifest（capability: happywork/pdf-split）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { argStr, flagBool, flagInt, flagStr, type CommandDef, type RunContext } from "../../core/command.ts";
import { inputError } from "../../core/errors.ts";
import { guardOutDir } from "../../core/fs.ts";
import { block, bytes as measuredBytes, entry, record, type Doc, type Entry } from "../../core/render.ts";
import { readPdfMetaAsync } from "../../infra/pdf/meta.ts";
import { planSplit, type Chapter, type ChunkPlan, type SplitPlan } from "../../infra/pdf/plan.ts";
import { chunkFileName, defaultOutDir, writeSplit } from "../../infra/pdf/split.ts";

/** 读取并粗校验章节表文件；细校验（页码范围等）在 planSplit 内完成 */
function readChapters(path: string): Chapter[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw inputError("invalid-chapters", `章节表文件不存在或无法读取：${path}`, { file: path });
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw inputError("invalid-chapters", `章节表不是合法 JSON：${path}`, { file: path });
  }
  if (!Array.isArray(data)) {
    throw inputError("invalid-chapters", `章节表必须是数组`, { file: path });
  }
  return data as Chapter[];
}

function printedRange(c: ChunkPlan): string | null {
  if (c.printedStart === null || c.printedEnd === null) return null;
  return `${c.printedStart}-${c.printedEnd}`;
}

/** 把方案渲染为分片记录块；files 为各分片的（预测或实际）文件名 */
function chunkRecords(plan: SplitPlan, files: string[]): Doc {
  return plan.chunks.map((c, i) =>
    record("chunk", c.index, [
      entry("file", files[i] ?? null),
      entry("srcRange", `${c.srcStart}-${c.srcEnd}`),
      entry("printedRange", printedRange(c)),
      entry("pages", c.pages),
      entry("overlap", c.overlapPages),
      entry("estBytes", measuredBytes(c.estBytes)),
    ]),
  );
}

const command: CommandDef = {
  domain: "pdf",
  action: "split",
  summary: "按页数与体积上限拆分 PDF，产出各分片与记录页码映射的 manifest.json",
  args: [
    { name: "input", type: "path", required: true, summary: "待拆分的 PDF 文件" },
  ],
  flags: [
    { name: "out-dir", type: "path", alias: "o", summary: "输出目录，默认为 <输入文件名>_split/" },
    { name: "max-pages", type: "int", default: 200, summary: "每个分片的最大页数" },
    { name: "max-bytes", type: "bytes", default: "190mb", summary: "每个分片的最大字节数" },
    { name: "align-chapters", type: "path", summary: "章节表 JSON，使拆分点落在章首" },
    { name: "overlap", type: "int", default: 0, summary: "相邻分片向前重叠的页数" },
    { name: "dry-run", type: "bool", summary: "只输出拆分方案，不写入任何文件" },
    { name: "force", type: "bool", summary: "允许覆盖已存在且非空的输出目录" },
  ],
  async run(ctx: RunContext): Promise<Doc> {
    const input = argStr(ctx, "input");
    const alignPath = flagStr(ctx, "align-chapters");
    const dryRun = flagBool(ctx, "dry-run");
    const outDir = flagStr(ctx, "out-dir") ?? defaultOutDir(input);

    const meta = await readPdfMetaAsync(input);
    const opts = {
      maxPages: flagInt(ctx, "max-pages"),
      maxBytes: flagInt(ctx, "max-bytes"),
      overlap: flagInt(ctx, "overlap"),
      chapters: alignPath ? readChapters(alignPath) : undefined,
    };

    const plan = planSplit(meta, opts);
    const stem = input.slice(input.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    const files = plan.chunks.map((c) =>
      chunkFileName(stem, c.index, plan.chunks.length, c.srcStart, c.srcEnd),
    );

    const head: Entry[] = [
      entry("input", meta.path),
      entry("outDir", outDir),
      entry("mode", alignPath ? "align-chapters" : "size"),
      entry("chunks", plan.chunks.length),
      entry("totalPages", meta.pages),
      entry("dryRun", dryRun),
    ];

    const warningsBlock: Doc =
      plan.warnings.length > 0
        ? [block("WARNINGS", plan.warnings.map((w, i) => entry(String(i + 1), w)))]
        : [];

    // 预演：只渲染方案，绝不写盘
    if (dryRun) {
      return [block("SPLIT-PLAN", head), ...warningsBlock, ...chunkRecords(plan, files)];
    }

    // 实跑：先做覆盖保护，再写盘
    guardOutDir(outDir, flagBool(ctx, "force"));
    const manifest = await writeSplit(meta, plan, { ...opts, alignChapters: alignPath ?? null }, outDir);

    const doc: Doc = [
      block("SPLIT", [...head, entry("manifest", join(outDir, "manifest.json"))]),
      ...warningsBlock,
    ];
    for (const c of manifest.chunks) {
      doc.push(
        record("chunk", c.index, [
          entry("file", c.file),
          entry("srcRange", `${c.srcStart}-${c.srcEnd}`),
          entry(
            "printedRange",
            c.printedStart === null || c.printedEnd === null ? null : `${c.printedStart}-${c.printedEnd}`,
          ),
          entry("pages", c.pages),
          entry("overlap", c.overlapPages),
          entry("bytes", measuredBytes(c.bytes)),
        ]),
      );
    }
    return doc;
  },
};

export default command;
