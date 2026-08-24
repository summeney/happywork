/**
 * 命令注册表（cli-core spec：两级命令路由）
 *
 * 加一个命令 = 加一个文件并在此登记一次。
 * 路由、帮助、命令目录全部读同一份注册表，不存在第二处需要同步的地方。
 */
import type { CommandDef } from "./command.ts";
import { usageError } from "./errors.ts";

import pdfInfo from "../commands/pdf/info.ts";
import pdfSplit from "../commands/pdf/split.ts";

/** 全部已注册命令 */
export const COMMANDS: readonly CommandDef[] = [pdfInfo, pdfSplit];

/** 领域说明，用于顶层帮助 */
export const DOMAIN_SUMMARIES: Readonly<Record<string, string>> = {
  pdf: "PDF 侦察与拆分",
};

/** 全部领域名，按字母序 */
export function domains(): string[] {
  return [...new Set(COMMANDS.map((c) => c.domain))].sort();
}

/** 某领域下的全部动作 */
export function actionsOf(domain: string): CommandDef[] {
  return COMMANDS.filter((c) => c.domain === domain).sort((a, b) =>
    a.action.localeCompare(b.action),
  );
}

export function hasDomain(domain: string): boolean {
  return COMMANDS.some((c) => c.domain === domain);
}

/** 按 `<领域> <动作>` 查找；找不到时抛出带可用项清单的调用方错误 */
export function resolve(domain: string, action: string): CommandDef {
  if (!hasDomain(domain)) {
    throw usageError("unknown-domain", `未知领域：${domain}`, {
      domain,
      available: domains().join(" "),
    });
  }
  const cmd = COMMANDS.find((c) => c.domain === domain && c.action === action);
  if (!cmd) {
    throw usageError("unknown-action", `领域 ${domain} 下没有动作：${action}`, {
      domain,
      action,
      available: actionsOf(domain).map((c) => c.action).join(" "),
    });
  }
  return cmd;
}
