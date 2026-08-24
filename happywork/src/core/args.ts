/**
 * 参数校验与类型转换（cli-core spec：声明与实际行为一致）
 *
 * 分词交给 citty 的 parseArgs；但 citty 只分词、不做以下事情，全部由本层补齐，
 * 以产出符合 spec 的行为与中文错误：
 *   - 必填位置参数缺失 → missing-argument（citty 默认抛英文 EARG，故声明侧一律 optional）
 *   - 未知选项 → invalid-flag（citty 默认静默接受）
 *   - int / bytes / path 的类型转换与校验（citty 眼里它们都是 string）
 */
import { isAbsolute, resolve } from "node:path";
import { parseArgs as cittyParse } from "citty";
import type { ArgSpec, CommandDef, FlagSpec, RunContext } from "./command.ts";
import { usageError } from "./errors.ts";
import { toCittyArgs } from "./citty.ts";

/** 十进制字节字面量：`190mb` `1.5gb` `4096` */
export function parseBytes(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(raw.trim());
  if (!m) throw new Error(`无法解析为字节数：${raw}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9 }[unit] ?? 1;
  return Math.round(n * mult);
}

function toCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** 该命令允许出现在解析结果中的全部键（含 citty 产出的 kebab/camel/别名变体） */
function allowedKeys(cmd: CommandDef): Set<string> {
  const keys = new Set<string>(["_"]);
  for (const a of cmd.args) {
    keys.add(a.name);
    keys.add(toCamel(a.name));
  }
  for (const f of cmd.flags) {
    keys.add(f.name);
    keys.add(toCamel(f.name));
    if (f.alias) keys.add(f.alias);
  }
  return keys;
}

function coerceFlag(spec: FlagSpec, raw: string | boolean): string | number | boolean {
  switch (spec.type) {
    case "bool":
      return raw === true || raw === "true";
    case "int": {
      const s = String(raw);
      if (!/^-?\d+$/.test(s.trim())) {
        throw usageError("invalid-flag-value", `选项 --${spec.name} 需要一个整数，收到 ${s}`, {
          flag: `--${spec.name}`,
          value: s,
          expected: "int",
        });
      }
      return Number(s);
    }
    case "bytes": {
      const s = String(raw);
      try {
        return parseBytes(s);
      } catch {
        throw usageError(
          "invalid-flag-value",
          `选项 --${spec.name} 需要一个字节数（如 190mb），收到 ${s}`,
          { flag: `--${spec.name}`, value: s, expected: "bytes" },
        );
      }
    }
    case "path": {
      const s = String(raw);
      return isAbsolute(s) ? s : resolve(process.cwd(), s);
    }
    case "enum": {
      const s = String(raw);
      if (spec.options && !spec.options.includes(s)) {
        throw usageError(
          "invalid-flag-value",
          `选项 --${spec.name} 只接受 ${spec.options.join(" | ")}，收到 ${s}`,
          { flag: `--${spec.name}`, value: s, expected: spec.options.join("|") },
        );
      }
      return s;
    }
    case "string":
      return String(raw);
  }
}

export interface ParsedInvocation {
  ctx: RunContext;
}

/**
 * 按命令声明分词、校验并转换实参。
 * @param cmd  目标命令
 * @param argv 已剥去 `<领域> <动作>` 的剩余实参
 */
export function parseInvocation(cmd: CommandDef, argv: string[]): ParsedInvocation {
  let parsed: Record<string, unknown>;
  try {
    parsed = cittyParse(argv, toCittyArgs(cmd)) as Record<string, unknown>;
  } catch (e) {
    throw usageError("invalid-flag", (e as Error).message.split("\n")[0], {
      command: `${cmd.domain} ${cmd.action}`,
    });
  }

  // 未知选项：citty 会静默接受，此处显式拒绝（spec：声明与实际行为一致）
  const allowed = allowedKeys(cmd);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      throw usageError("invalid-flag", `未知选项：--${key}`, {
        command: `${cmd.domain} ${cmd.action}`,
        flag: `--${key}`,
      });
    }
  }

  // 位置参数
  const positionals = (parsed._ as string[]) ?? [];
  const args: Record<string, string> = {};
  cmd.args.forEach((spec: ArgSpec, i: number) => {
    const raw = positionals[i];
    if (raw === undefined) {
      if (spec.required) {
        throw usageError("missing-argument", `缺少必需的位置参数 <${spec.name}>`, {
          command: `${cmd.domain} ${cmd.action}`,
          argument: spec.name,
        });
      }
      return;
    }
    args[spec.name] = spec.type === "path" ? resolve(process.cwd(), raw) : raw;
  });

  if (positionals.length > cmd.args.length) {
    const extra = positionals.slice(cmd.args.length).join(" ");
    throw usageError("unexpected-argument", `多余的位置参数：${extra}`, {
      command: `${cmd.domain} ${cmd.action}`,
      extra,
    });
  }

  // 选项：先填默认值，再覆盖实参
  const flags: Record<string, string | number | boolean> = {};
  for (const spec of cmd.flags) {
    if (spec.default !== undefined) {
      flags[spec.name] =
        spec.type === "bytes" && typeof spec.default === "string"
          ? parseBytes(spec.default)
          : spec.default;
    } else if (spec.type === "bool") {
      flags[spec.name] = false;
    }
    const raw = parsed[spec.name];
    if (raw !== undefined) flags[spec.name] = coerceFlag(spec, raw as string | boolean);
  }

  return { ctx: { args, flags, cwd: process.cwd() } };
}
