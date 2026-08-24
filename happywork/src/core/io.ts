/**
 * 流分离（cli-core spec：流分离）
 *
 * stdout 只承载命令结果；进度、警告、诊断一律走 stderr。
 * 命令代码不得直接调用 console.log —— 结果通过返回 Doc 交由渲染层输出。
 */

/** 写入命令结果（stdout） */
export function writeResult(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

/** 写入诊断信息（stderr） */
export function writeDiagnostic(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : text + "\n");
}

/** 进度提示（stderr） */
export function progress(message: string): void {
  writeDiagnostic(message);
}

/** 警告（stderr） */
export function warn(message: string): void {
  writeDiagnostic(`WARN  ${message}`);
}
