/**
 * 拆分方案计算（design 决策 6：计算与写盘彻底分离）
 *
 * planSplit 是纯函数，不碰文件系统。--dry-run 就是只跑它并渲染结果，
 * 因此「预演输出与实际拆分一致」由构造保证，而非靠测试守护。
 *
 * 求解顺序：把输入切成「原子」（无章节表时一页一个原子，有章节表时一章一个原子），
 * 再贪心地把原子装进分片，装的过程中同时受页数与体积两个上限约束，
 * 重叠页在装箱时即计入 —— 因为它同样占用下游的页数与体积额度。
 */
import { inputError } from "../../core/errors.ts";
import { toPrinted, type PdfMeta } from "./meta.ts";

export interface Chapter {
  /** 章号，可选，仅用于提示 */
  number?: number;
  title: string;
  /** 该章起始的印刷页码（作者按目录抄写的形式） */
  printedStart?: number;
  /** 该章起始的 PDF 页序号（0 基），与 printedStart 二选一 */
  srcStart?: number;
}

export interface PlanOptions {
  maxPages: number;
  maxBytes: number;
  overlap: number;
  chapters?: Chapter[];
}

export interface ChunkPlan {
  /** 1 基序号 */
  index: number;
  /** 实际起始页（含重叠部分） */
  srcStart: number;
  srcEnd: number;
  /** 不含重叠的基准起始页；各分片的 [baseStart, srcEnd] 恰好无重不漏地覆盖全书 */
  baseStart: number;
  overlapPages: number;
  pages: number;
  estBytes: number;
  printedStart: number | null;
  printedEnd: number | null;
}

export interface SplitPlan {
  chunks: ChunkPlan[];
  warnings: string[];
  totalPages: number;
  options: PlanOptions;
}

/** 一个不可再分的页面区间 */
interface Atom {
  start: number;
  end: number;
  bytes: number;
  /** 该原子来自哪一章，仅用于警告信息 */
  chapter?: string;
}

function pageBytes(meta: PdfMeta, i: number): number {
  return meta.pageMetas[i]?.bytes ?? 0;
}

function rangeBytes(meta: PdfMeta, a: number, b: number): number {
  let s = 0;
  for (let i = a; i <= b; i++) s += pageBytes(meta, i);
  return s;
}

/** 把章节表换算为源页序号并校验 */
export function resolveChapters(chapters: Chapter[], meta: PdfMeta): { srcStart: number; title: string }[] {
  if (chapters.length === 0) {
    throw inputError("invalid-chapters", "章节表为空", {});
  }
  const out = chapters.map((c, i) => {
    let src: number;
    if (typeof c.srcStart === "number") {
      src = c.srcStart;
    } else if (typeof c.printedStart === "number") {
      if (meta.offset === null) {
        throw inputError(
          "invalid-chapters",
          `章节表使用 printedStart，但该 PDF 无 /PageLabels，无法换算为页序号；请改用 srcStart`,
          { chapter: c.title },
        );
      }
      src = c.printedStart + meta.offset;
    } else {
      throw inputError(
        "invalid-chapters",
        `第 ${i + 1} 项缺少 printedStart 或 srcStart`,
        { chapter: c.title ?? String(i + 1) },
      );
    }
    if (!Number.isInteger(src) || src < 0 || src >= meta.pages) {
      throw inputError(
        "invalid-chapters",
        `章「${c.title}」的起始页 ${src} 超出范围 0..${meta.pages - 1}`,
        { chapter: c.title, srcStart: String(src), pages: String(meta.pages) },
      );
    }
    return { srcStart: src, title: c.title };
  });
  out.sort((a, b) => a.srcStart - b.srcStart);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.srcStart === out[i - 1]!.srcStart) {
      throw inputError("invalid-chapters", `两章起始于同一页：${out[i]!.title}`, {
        chapter: out[i]!.title,
        srcStart: String(out[i]!.srcStart),
      });
    }
  }
  return out;
}

/**
 * 把全书切成原子。
 * 无章节表：一页一个原子。
 * 有章节表：一章一个原子；单章超过上限时在章内退让为按页切分并产出警告。
 */
function buildAtoms(meta: PdfMeta, opts: PlanOptions, warnings: string[]): Atom[] {
  if (!opts.chapters || opts.chapters.length === 0) {
    return Array.from({ length: meta.pages }, (_, i) => ({
      start: i,
      end: i,
      bytes: pageBytes(meta, i),
    }));
  }

  const resolved = resolveChapters(opts.chapters, meta);
  const atoms: Atom[] = [];

  // 第一章之前的前置页（封面、版权、目录）自成一个原子块，按页切分以便灵活装箱
  const firstStart = resolved[0]!.srcStart;
  for (let i = 0; i < firstStart; i++) {
    atoms.push({ start: i, end: i, bytes: pageBytes(meta, i), chapter: "front-matter" });
  }

  resolved.forEach((ch, i) => {
    const start = ch.srcStart;
    const end = (resolved[i + 1]?.srcStart ?? meta.pages) - 1;
    const pages = end - start + 1;
    const bytes = rangeBytes(meta, start, end);
    if (pages > opts.maxPages || bytes > opts.maxBytes) {
      warnings.push(
        `章「${ch.title}」自身 ${pages} 页 / ${bytes} 字节已超过上限，该章内部退让为按页切分`,
      );
      for (let p = start; p <= end; p++) {
        atoms.push({ start: p, end: p, bytes: pageBytes(meta, p), chapter: ch.title });
      }
    } else {
      atoms.push({ start, end, bytes, chapter: ch.title });
    }
  });

  return atoms;
}

/** 计算拆分方案。纯函数：只读 meta 与 opts，不产生任何副作用。 */
export function planSplit(meta: PdfMeta, opts: PlanOptions): SplitPlan {
  if (opts.maxPages < 1) {
    throw inputError("invalid-option", `--max-pages 必须 ≥ 1，收到 ${opts.maxPages}`, {});
  }
  if (opts.overlap < 0) {
    throw inputError("invalid-option", `--overlap 不能为负，收到 ${opts.overlap}`, {});
  }
  if (opts.overlap >= opts.maxPages) {
    throw inputError(
      "invalid-option",
      `--overlap (${opts.overlap}) 必须小于 --max-pages (${opts.maxPages})`,
      {},
    );
  }

  // 单页即超过体积上限 —— 无论怎么切都无法满足，直接报错并指出页号
  for (let i = 0; i < meta.pages; i++) {
    const b = pageBytes(meta, i);
    if (b > opts.maxBytes) {
      throw inputError(
        "page-exceeds-max-bytes",
        `第 ${i} 页单页即占 ${b} 字节，超过 --max-bytes ${opts.maxBytes}，无法满足该上限`,
        { page: String(i), pageBytes: String(b), maxBytes: String(opts.maxBytes) },
      );
    }
  }

  const warnings: string[] = [];
  const atoms = buildAtoms(meta, opts, warnings);

  // 装箱：把原子贪心装进分片。target 为每片的软目标页数——累计达到即收口，
  // 用于章节对齐时把分片摊匀；无章节时 target = Infinity，退化为纯贪心塞满。
  // maxPages / maxBytes 始终是硬约束。
  const pack = (target: number): ChunkPlan[] => {
    const chunks: ChunkPlan[] = [];
    let ai = 0;
    while (ai < atoms.length) {
      const isFirst = chunks.length === 0;
      const baseStart = atoms[ai]!.start;
      const overlapPages = isFirst ? 0 : Math.min(opts.overlap, baseStart);
      const srcStart = baseStart - overlapPages;

      // 重叠页同样占额度，先计入
      let pages = overlapPages;
      let bytes = overlapPages > 0 ? rangeBytes(meta, srcStart, baseStart - 1) : 0;
      let end = baseStart - 1;

      while (ai < atoms.length) {
        if (end >= baseStart && pages >= target) break; // 已达软目标，在章界收口
        const a = atoms[ai]!;
        const aPages = a.end - a.start + 1;
        const fits = pages + aPages <= opts.maxPages && bytes + a.bytes <= opts.maxBytes;
        if (!fits && end >= baseStart) break; // 已装进至少一个原子，收口
        if (!fits && end < baseStart) {
          // 首个原子就装不下（且不是单页超限，已在上面排除）：说明是重叠占满了额度
          throw inputError(
            "cannot-satisfy-limits",
            `分片 ${chunks.length + 1} 在 --overlap ${opts.overlap} 下无法容纳起始于第 ${a.start} 页的内容`,
            { chunk: String(chunks.length + 1), page: String(a.start) },
          );
        }
        pages += aPages;
        bytes += a.bytes;
        end = a.end;
        ai++;
      }

      chunks.push({
        index: chunks.length + 1,
        srcStart,
        srcEnd: end,
        baseStart,
        overlapPages,
        pages,
        estBytes: bytes,
        printedStart: toPrinted(baseStart, meta.offset),
        printedEnd: toPrinted(end, meta.offset),
      });
    }
    return chunks;
  };

  // 无章节：贪心塞满，尽量少的分片（[200,1] 而非摊匀）。
  // 有章节：先贪心探出最少片数，再以 ⌈总页 / 片数⌉ 为目标重排，把分片摊匀，
  //         从而在满足上限的前提下让拆分点落到更靠前的章首（spec：拆分点落在章首）。
  const hasChapters = !!(opts.chapters && opts.chapters.length > 0);
  let chunks: ChunkPlan[];
  if (hasChapters) {
    const numChunks = pack(Infinity).length;
    const target = Math.ceil(meta.pages / numChunks);
    chunks = pack(target);
  } else {
    chunks = pack(Infinity);
  }

  return { chunks, warnings, totalPages: meta.pages, options: opts };
}
