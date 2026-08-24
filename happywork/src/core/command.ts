/**
 * 命令定义 —— 唯一真相来源（design 决策 1）
 *
 * 每个动作导出一个 CommandDef。参数解析与帮助/命令目录都由它派生，
 * 因此「帮助与实现漂移」在结构上不可能发生。
 *
 * run() 返回 Doc 而非自行打印：命令在类型上就无法向 stdout 写入，
 * 输出格式由渲染层独占（cli-core spec：结构化文本输出语法）。
 */
import type { Doc } from "./render.ts";

export type ArgType = "string" | "path";
export type FlagType = "string" | "int" | "bool" | "bytes" | "path" | "enum";

export interface ArgSpec {
  /** 位置参数名，用于帮助与错误信息 */
  readonly name: string;
  readonly type: ArgType;
  readonly required: boolean;
  readonly summary: string;
}

export interface FlagSpec {
  /** 选项名，不含前导 `--` */
  readonly name: string;
  readonly type: FlagType;
  /** 单字符短别名，不含前导 `-`（如 `o` 对应 `-o`） */
  readonly alias?: string;
  /** 未传入时采用的值；bool 型省略即视为 false */
  readonly default?: string | number | boolean;
  /** enum 型的候选值 */
  readonly options?: readonly string[];
  readonly summary: string;
}

/** 解析并校验后的调用上下文 */
export interface RunContext {
  /** 位置参数，按 ArgSpec.name 索引；path 型已转为绝对路径 */
  readonly args: Readonly<Record<string, string>>;
  /** 选项，按 FlagSpec.name 索引；已按声明的类型转换 */
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  readonly cwd: string;
}

export interface CommandDef {
  /** 领域（名词），如 `pdf` */
  readonly domain: string;
  /** 动作（动词），如 `split` */
  readonly action: string;
  readonly summary: string;
  readonly args: readonly ArgSpec[];
  readonly flags: readonly FlagSpec[];
  run(ctx: RunContext): Doc | Promise<Doc>;
}

/** 供命令实现取值的类型化辅助 */
export function argStr(ctx: RunContext, name: string): string {
  const v = ctx.args[name];
  if (v === undefined) throw new Error(`内部错误：位置参数 ${name} 未解析`);
  return v;
}

export function flagInt(ctx: RunContext, name: string): number {
  return Number(ctx.flags[name]);
}

export function flagBool(ctx: RunContext, name: string): boolean {
  return ctx.flags[name] === true;
}

export function flagStr(ctx: RunContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return v === undefined || v === "" ? undefined : String(v);
}
