/**
 * citty 桥接层（design 决策 1）
 *
 * citty 在本项目里只承担三件事：
 *   1. 把 CommandDef 的声明翻译成 citty 的 ArgsDef（供 parseArgs 分词与 tab 读取）；
 *   2. 组装 `happywork <领域> <动作>` 的命令树，交给 @bomb.sh/tab 生成补全；
 *   3. 通过注入的 `complete` 子命令派发补全请求。
 *
 * 校验、必填强制、未知选项拒绝、错误文案、退出码与结果渲染一律不交给 citty
 * —— 那些是 cli-core spec 写死的契约，见 args.ts 与 cli.ts。
 */
import { readFileSync } from "node:fs";
import { defineCommand, renderUsage, type ArgsDef, type CommandDef as CittyCommandDef } from "citty";
import type { CommandDef } from "./command.ts";
import { COMMANDS, DOMAIN_SUMMARIES, domains, actionsOf } from "./registry.ts";

/** 读取本包版本号（bin 入口相对 src/core 上溯两级） */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/**
 * 把一个命令的声明翻译成 citty ArgsDef。
 * 位置参数一律 `required: false` —— 必填由 args.ts 的 coerce 强制，
 * 以产出符合 spec 的中文错误，而非 citty 的英文 EARG。
 * 自定义类型（int/bytes/path）在 citty 眼里都是 string，转换同样归 coerce。
 *
 * `omitPositionals`：供 @bomb.sh/tab 补全消费的树省去位置参数。tab 的 citty
 * 适配器在生成 `--选项` 候选时不区分参数类别，会把位置参数（如 `input`）也
 * 登记成 `--input` 幻影（design Risks / 任务 8.2）。补全不需要位置参数（文件名
 * 由 shell 原生补全），故这棵树直接不含它们；帮助树仍保留位置参数以渲染 `<input>`。
 */
export function toCittyArgs(cmd: CommandDef, opts: { omitPositionals?: boolean } = {}): ArgsDef {
  const def: ArgsDef = {};
  if (!opts.omitPositionals) {
    for (const a of cmd.args) {
      def[a.name] = { type: "positional", description: a.summary, required: false, valueHint: a.type };
    }
  }
  for (const f of cmd.flags) {
    // valueHint 让原生帮助显示类型（--max-bytes=<bytes>）；default 让其显示 (Default: 190mb)
    const shown = f.default !== undefined ? { default: String(f.default) } : {};
    if (f.type === "bool") {
      def[f.name] = { type: "boolean", description: f.summary, ...(f.alias ? { alias: f.alias } : {}) };
    } else if (f.type === "enum") {
      def[f.name] = {
        type: "enum",
        options: [...(f.options ?? [])],
        description: f.summary,
        valueHint: "enum",
        ...shown,
        ...(f.alias ? { alias: f.alias } : {}),
      };
    } else {
      def[f.name] = {
        type: "string",
        description: f.summary,
        valueHint: f.type,
        ...shown,
        ...(f.alias ? { alias: f.alias } : {}),
      };
    }
  }
  return def;
}

/** 渲染 citty 原生帮助；非 TTY 时剥掉 ANSI 颜色码（citty 只按 NO_COLOR/CI 剥色，不看 isTTY） */
async function renderHelp(cmd: CittyCommandDef, parent?: CittyCommandDef): Promise<string> {
  const out = await renderUsage(cmd, parent);
  return process.stdout.isTTY ? out : out.replace(/\x1b\[[0-9;]*m/g, "");
}

function sub(cmd: CittyCommandDef, name: string): CittyCommandDef {
  return (cmd.subCommands as Record<string, CittyCommandDef>)[name];
}

/** 顶层帮助：列出全部领域（drill-down 第一层） */
export function topHelpText(): Promise<string> {
  return renderHelp(buildMain());
}

/** 领域帮助：列出该领域全部动作 */
export function domainHelpText(domain: string): Promise<string> {
  const main = buildMain();
  return renderHelp(sub(main, domain), main);
}

/** 动作帮助：单个动作的位置参数与选项（含类型与默认值） */
export function actionHelpText(domain: string, action: string): Promise<string> {
  const main = buildMain();
  const d = sub(main, domain);
  return renderHelp(sub(d, action), d);
}

/**
 * 组装完整命令树：happywork → 领域 → 动作。
 * `forCompletion` 时省去位置参数，避免 tab 把它们列成 `--选项`（见 toCittyArgs）。
 * 帮助渲染用默认（含位置参数）；tab 补全用 `forCompletion: true`。
 */
export function buildMain(opts: { forCompletion?: boolean } = {}): CittyCommandDef {
  const argOpts = { omitPositionals: opts.forCompletion === true };
  const subCommands: Record<string, CittyCommandDef> = {};
  for (const d of domains()) {
    const actions: Record<string, CittyCommandDef> = {};
    for (const cmd of actionsOf(d)) {
      actions[cmd.action] = defineCommand({
        meta: { name: cmd.action, description: cmd.summary },
        args: toCittyArgs(cmd, argOpts),
      });
    }
    subCommands[d] = defineCommand({
      meta: { name: d, description: DOMAIN_SUMMARIES[d] ?? "-" },
      subCommands: actions,
    });
  }
  return defineCommand({
    meta: { name: "happywork", version: readVersion(), description: "个人实用命令行工具集" },
    subCommands,
  });
}

/** 供 tab 补全的完成器配置：文件类参数回落 shell 原生文件补全，不在进程内计算 */
export { COMMANDS };
