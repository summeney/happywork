/**
 * PDF 元信息读取 —— pdf-info 与 pdf-split 的公共底座（design 决策 7）
 *
 * info 是它的渲染器，split 是它的消费者。因此当拆分结果可疑时，
 * `pdf info --pages` 给出的正是拆分决策所依据的同一份数据。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString } from "pdf-lib";
import { inputError } from "../../core/errors.ts";

/** 一页上的一张图像 */
export interface ImageMeta {
  width: number;
  height: number;
  /** 压缩方式，如 DCTDecode */
  filter: string;
  /** 该图像流的字节数 */
  bytes: number;
}

export interface PageMeta {
  /** 0 基的 PDF 页序号 */
  index: number;
  images: ImageMeta[];
  /** 该页的字体数量 */
  fonts: number;
  /** 该页占用的估算字节数（其图像流长度之和 + 内容流长度） */
  bytes: number;
}

/** `/PageLabels` 中的一个编号段 */
export interface LabelSegment {
  /** 该段起始的 PDF 页序号（0 基） */
  startPage: number;
  /** 编号样式：D=阿拉伯 R/r=罗马 A/a=字母 */
  style: string;
  /** 该段的起始编号，默认 1 */
  start: number;
  prefix?: string;
}

export interface TextLayer {
  present: boolean;
  fonts: number;
  toUnicode: number;
  /** 整版图像页数 / 总页数 */
  imagePages: number;
}

export interface PdfMeta {
  path: string;
  sha256: string;
  bytes: number;
  pages: number;
  textLayer: TextLayer;
  labels: LabelSegment[];
  /** PDF 页序号 → 印刷页码的差值：printed = index - offset。无阿拉伯数字段时为 null */
  offset: number | null;
  pageMetas: PageMeta[];
}

const STYLE_NAMES: Record<string, string> = {
  D: "decimal",
  R: "roman-upper",
  r: "roman",
  A: "letters-upper",
  a: "letters",
};

export function styleName(style: string): string {
  return STYLE_NAMES[style] ?? style;
}

function nameOf(v: unknown): string {
  if (v instanceof PDFName) return v.asString().replace(/^\//, "");
  return String(v);
}

/** 取出该页 Resources 下某个子字典 */
function subDict(res: PDFDict | undefined, key: string): PDFDict | undefined {
  if (!res) return undefined;
  const d = res.lookup(PDFName.of(key));
  return d instanceof PDFDict ? d : undefined;
}

function readPageMeta(doc: PDFDocument, index: number): PageMeta {
  const page = doc.getPage(index);
  const res = page.node.Resources();
  const images: ImageMeta[] = [];
  let bytes = 0;

  const xobjects = subDict(res, "XObject");
  if (xobjects) {
    for (const [, ref] of xobjects.entries()) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const d = stream.dict;
      if (nameOf(d.get(PDFName.of("Subtype"))) !== "Image") continue;
      const w = d.get(PDFName.of("Width"));
      const h = d.get(PDFName.of("Height"));
      const filterRaw = d.get(PDFName.of("Filter"));
      const filter =
        filterRaw instanceof PDFArray
          ? filterRaw.asArray().map(nameOf).join("+")
          : nameOf(filterRaw);
      const len = stream.contents.length;
      images.push({
        width: w instanceof PDFNumber ? w.asNumber() : 0,
        height: h instanceof PDFNumber ? h.asNumber() : 0,
        filter,
        bytes: len,
      });
      bytes += len;
    }
  }

  const fontDict = subDict(res, "Font");
  const fonts = fontDict ? fontDict.entries().length : 0;

  // 内容流长度也计入，扫描件里这部分很小但不为零
  const contents = page.node.Contents();
  if (contents instanceof PDFRawStream) bytes += contents.contents.length;

  return { index, images, fonts, bytes };
}

/** 统计整本书的字体与 ToUnicode 数量，用于文字层判定 */
function readTextLayer(doc: PDFDocument, pageMetas: PageMeta[]): TextLayer {
  let fonts = 0;
  let toUnicode = 0;
  for (let i = 0; i < doc.getPageCount(); i++) {
    const res = doc.getPage(i).node.Resources();
    const fontDict = subDict(res, "Font");
    if (!fontDict) continue;
    for (const [, ref] of fontDict.entries()) {
      fonts++;
      const f = doc.context.lookup(ref);
      if (f instanceof PDFDict && f.get(PDFName.of("ToUnicode")) !== undefined) toUnicode++;
    }
  }
  const imagePages = pageMetas.filter((p) => p.images.length > 0).length;
  return { present: fonts > 0 && toUnicode > 0, fonts, toUnicode, imagePages };
}

/** 解析 /PageLabels 的 /Nums 数组 */
function readLabels(doc: PDFDocument): LabelSegment[] {
  const catalog = doc.catalog;
  const pl = catalog.lookup(PDFName.of("PageLabels"));
  if (!(pl instanceof PDFDict)) return [];
  const nums = pl.lookup(PDFName.of("Nums"));
  if (!(nums instanceof PDFArray)) return [];

  const segments: LabelSegment[] = [];
  const arr = nums.asArray();
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const key = doc.context.lookupMaybe(arr[i]!, PDFNumber);
    const valRaw = arr[i + 1]!;
    const val = valRaw instanceof PDFDict ? valRaw : doc.context.lookupMaybe(valRaw, PDFDict);
    if (!key || !val) continue;
    const style = nameOf(val.get(PDFName.of("S")) ?? "");
    const stRaw = val.get(PDFName.of("St"));
    const prefixRaw = val.get(PDFName.of("P"));
    segments.push({
      startPage: key.asNumber(),
      style: style === "undefined" ? "" : style,
      start: stRaw instanceof PDFNumber ? stRaw.asNumber() : 1,
      ...(prefixRaw instanceof PDFString ? { prefix: prefixRaw.asString() } : {}),
    });
  }
  return segments.sort((a, b) => a.startPage - b.startPage);
}

/**
 * 由编号段算出印刷页 offset：取第一个阿拉伯数字段。
 * printed = pdfIndex - offset，其中 offset = startPage - start。
 */
export function computeOffset(labels: LabelSegment[]): number | null {
  const decimal = labels.find((l) => l.style === "D");
  if (!decimal) return null;
  return decimal.startPage - decimal.start;
}

/** 把 PDF 页序号换算为印刷页码；无 offset 或落在正文前时返回 null */
export function toPrinted(index: number, offset: number | null): number | null {
  if (offset === null) return null;
  const p = index - offset;
  return p >= 1 ? p : null;
}

/** 读取一个 PDF 的全部元信息 */
export function readPdfMeta(path: string): PdfMeta {
  if (!existsSync(path)) {
    throw inputError("input-not-found", `文件不存在：${path}`, { path });
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw inputError("input-not-a-file", `不是一个文件：${path}`, { path });
  }
  const buf = readFileSync(path);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  let doc: PDFDocument;
  try {
    doc = PDFDocument.load(buf, { updateMetadata: false, throwOnInvalidObject: false }) as never;
  } catch (e) {
    throw inputError("input-not-a-pdf", `无法解析为 PDF：${(e as Error).message}`, { path });
  }
  return finish(path, sha256, stat.size, doc);
}

/** 异步版本：pdf-lib 的 load 返回 Promise */
export async function readPdfMetaAsync(path: string): Promise<PdfMeta> {
  if (!existsSync(path)) {
    throw inputError("input-not-found", `文件不存在：${path}`, { path });
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw inputError("input-not-a-file", `不是一个文件：${path}`, { path });
  }
  const buf = readFileSync(path);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    throw inputError("input-not-a-pdf", `无法解析为 PDF：${(e as Error).message}`, { path });
  }
  return finish(path, sha256, stat.size, doc);
}

function finish(path: string, sha256: string, bytes: number, doc: PDFDocument): PdfMeta {
  const pages = doc.getPageCount();
  const pageMetas: PageMeta[] = [];
  for (let i = 0; i < pages; i++) pageMetas.push(readPageMeta(doc, i));
  const labels = readLabels(doc);
  return {
    path,
    sha256,
    bytes,
    pages,
    textLayer: readTextLayer(doc, pageMetas),
    labels,
    offset: computeOffset(labels),
    pageMetas,
  };
}
