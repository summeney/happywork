/**
 * 非交互约束下的文件系统守卫（cli-core spec：非交互执行）
 *
 * CLI 永不阻塞等待输入，因此「要不要覆盖」不能问人 ——
 * 默认拒绝，由调用方显式传 --force。
 */
import { existsSync, readdirSync } from "node:fs";
import { inputError } from "./errors.ts";

/**
 * 输出目录已存在且非空时，未加 --force 则拒绝，且不写入任何文件。
 */
export function guardOutDir(dir: string, force: boolean): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  if (entries.length === 0) return;
  if (force) return;
  throw inputError(
    "output-dir-not-empty",
    `输出目录已存在且非空：${dir}。加 --force 覆盖。`,
    { dir, entries: String(entries.length) },
  );
}
