/**
 * 唯一的结构化文本渲染层（cli-core spec：结构化文本输出语法）
 *
 * 语法约定：
 *   - 标量分组：全大写区块名单独成行，条目缩进两格
 *   - 集合项：  `[<名称> <序号>]` 单独成行，条目缩进两格
 *   - 键值：    `<键>: <值>`，值延伸至行尾（值含空格/中文/括号均不转义）
 *   - 数值：    先原始值，再括号内人类友好形式 —— `bytes: 43099648  (41.1 MB)`
 *   - 缺失值：  `-`
 *   - 区块间以空行分隔；任何条目都不折行
 */

/** 带量纲的数值：机器读 raw，人读 human */
export type Measured = { raw: number; human: string };

export type Value = string | number | boolean | null | undefined | Measured;

export type Entry = { key: string; value: Value };

export type Block =
  /** 标量分组，如 SOURCE */
  | { kind: "block"; name: string; entries: Entry[] }
  /** 集合中的一项，如 [chunk 1] */
  | { kind: "record"; name: string; index: number; entries: Entry[] }
  /** 单行标题，如 `PLAN  2 chunks (...)` */
  | { kind: "heading"; text: string };

/** 一条命令的完整结果 */
export type Doc = Block[];

const INDENT = "  ";

function isMeasured(v: Value): v is Measured {
  return typeof v === "object" && v !== null && "raw" in v && "human" in v;
}

/** 渲染单个值。缺失一律为 `-`，绝不留空。 */
export function renderValue(v: Value): string {
  if (v === null || v === undefined) return "-";
  if (isMeasured(v)) return `${v.raw}  (${v.human})`;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  const s = String(v);
  // 空字符串同样视为缺失，避免产生 `key: ` 这种无值行
  if (s.length === 0) return "-";
  // 不折行：把内部换行压成空格，保证「一行一个事实」
  return s.replace(/\r?\n/g, " ");
}

function renderEntries(entries: Entry[]): string[] {
  if (entries.length === 0) return [];
  const width = Math.max(...entries.map((e) => e.key.length));
  return entries.map(
    (e) => `${INDENT}${(e.key + ":").padEnd(width + 1)} ${renderValue(e.value)}`,
  );
}

/** 把 Doc 渲染成最终输出文本 */
export function render(doc: Doc): string {
  const chunks: string[] = [];
  for (const block of doc) {
    const lines: string[] = [];
    if (block.kind === "heading") {
      lines.push(block.text);
    } else if (block.kind === "block") {
      lines.push(block.name);
      lines.push(...renderEntries(block.entries));
    } else {
      lines.push(`[${block.name} ${block.index}]`);
      lines.push(...renderEntries(block.entries));
    }
    chunks.push(lines.join("\n"));
  }
  return chunks.join("\n\n");
}

// ── 构造辅助 ────────────────────────────────────────────────

export function block(name: string, entries: Entry[]): Block {
  return { kind: "block", name, entries };
}

export function record(name: string, index: number, entries: Entry[]): Block {
  return { kind: "record", name, index, entries };
}

export function heading(text: string): Block {
  return { kind: "heading", text };
}

export function entry(key: string, value: Value): Entry {
  return { key, value };
}

/** 字节数 → Measured，人类形式用十进制单位 */
export function bytes(n: number): Measured {
  return { raw: n, human: humanBytes(n) };
}

export function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** 毫秒 → Measured */
export function millis(n: number): Measured {
  return { raw: n, human: n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s` };
}
