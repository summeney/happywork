/**
 * 拆分建议（capability: happywork/pdf-info —— 拆分建议）
 */
import type { PdfMeta } from "./meta.ts";

export interface SplitAdvice {
  needsSplit: boolean;
  /** 触发的上限，空数组表示未超限 */
  reasons: string[];
  maxPages: number;
  maxBytes: number;
}

export function adviseSplit(meta: PdfMeta, maxPages: number, maxBytes: number): SplitAdvice {
  const reasons: string[] = [];
  if (meta.pages > maxPages) reasons.push(`pages ${meta.pages} > maxPages ${maxPages}`);
  if (meta.bytes > maxBytes) reasons.push(`bytes ${meta.bytes} > maxBytes ${maxBytes}`);
  return { needsSplit: reasons.length > 0, reasons, maxPages, maxBytes };
}
