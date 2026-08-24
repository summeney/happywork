/**
 * happywork pdf info —— 只读侦察一个 PDF（capability: happywork/pdf-info）
 */
import { argStr, flagBool, flagInt, type CommandDef, type RunContext } from "../../core/command.ts";
import { block, bytes as measuredBytes, entry, type Doc, type Entry } from "../../core/render.ts";
import { adviseSplit } from "../../infra/pdf/advice.ts";
import { readPdfMetaAsync, styleName, toPrinted, type PdfMeta } from "../../infra/pdf/meta.ts";

function sourceBlock(meta: PdfMeta) {
  return block("SOURCE", [
    entry("path", meta.path),
    entry("sha256", meta.sha256),
    entry("bytes", measuredBytes(meta.bytes)),
    entry("pages", meta.pages),
  ]);
}

function textLayerBlock(meta: PdfMeta) {
  const t = meta.textLayer;
  return block("TEXT-LAYER", [
    entry("present", t.present),
    entry("fonts", t.fonts),
    entry("toUnicode", t.toUnicode),
    entry("imagePages", `${t.imagePages}/${meta.pages}`),
    entry(
      "verdict",
      t.present
        ? "含可提取文字层，可直接抽取文本"
        : "无文字层（扫描件），需 OCR 才能取得文本",
    ),
  ]);
}

function pageLabelsBlock(meta: PdfMeta) {
  const entries: Entry[] = meta.labels.map((l) =>
    entry("segment", `${l.startPage} ${styleName(l.style)} start=${l.start}`),
  );
  entries.push(entry("offset", meta.offset));
  if (meta.offset !== null) {
    const first = toPrinted(meta.offset + 1, meta.offset);
    const last = toPrinted(meta.pages - 1, meta.offset);
    entries.push(entry("printedRange", first !== null && last !== null ? `${first}-${last}` : null));
  }
  return block("PAGE-LABELS", entries);
}

function pagesBlock(meta: PdfMeta) {
  return block(
    "PAGES",
    meta.pageMetas.map((p) => {
      const printed = toPrinted(p.index, meta.offset);
      const imgs =
        p.images.length === 0
          ? "images=0"
          : `images=${p.images.length} ${p.images
              .map((i) => `${i.width}x${i.height} ${i.filter}`)
              .join(" ")}`;
      return entry(
        String(p.index),
        `printed=${printed ?? "-"} ${imgs} fonts=${p.fonts} bytes=${p.bytes}`,
      );
    }),
  );
}

const command: CommandDef = {
  domain: "pdf",
  action: "info",
  summary: "侦察 PDF：页数、体积、有无文字层、印刷页码 offset、逐页图像信息",
  args: [{ name: "input", type: "path", required: true, summary: "待侦察的 PDF 文件" }],
  flags: [
    { name: "pages", type: "bool", alias: "p", summary: "额外输出逐页图像元信息" },
    { name: "max-pages", type: "int", default: 200, summary: "拆分建议所用的页数上限" },
    { name: "max-bytes", type: "bytes", default: "190mb", summary: "拆分建议所用的体积上限" },
  ],
  async run(ctx: RunContext): Promise<Doc> {
    const meta = await readPdfMetaAsync(argStr(ctx, "input"));
    const advice = adviseSplit(meta, flagInt(ctx, "max-pages"), flagInt(ctx, "max-bytes"));

    const doc: Doc = [sourceBlock(meta), textLayerBlock(meta), pageLabelsBlock(meta)];
    doc.push(
      block("SPLIT-ADVICE", [
        entry("needsSplit", advice.needsSplit),
        entry("reason", advice.reasons.length > 0 ? advice.reasons.join("; ") : null),
        entry("maxPages", advice.maxPages),
        entry("maxBytes", measuredBytes(advice.maxBytes)),
      ]),
    );
    if (flagBool(ctx, "pages")) doc.push(pagesBlock(meta));
    return doc;
  },
};

export default command;
