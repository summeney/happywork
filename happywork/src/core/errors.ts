/** 退出码：机器判定失败类型的唯一依据（cli-core spec：语义化退出码） */
export const ExitCode = {
  /** 成功 */
  OK: 0,
  /** 调用方错误：参数非法、命令不存在 */
  USAGE: 1,
  /** 输入错误：文件不存在、无法读取、格式不受支持 */
  INPUT: 2,
  /** 内部错误 */
  INTERNAL: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * 带机器可读错误码的失败。
 * 错误码是稳定契约，调用方据此分支；message 的文案可变。
 */
export class HappyworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCodeValue = ExitCode.INPUT,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HappyworkError";
  }
}

/** 调用方错误（参数非法、命令不存在） */
export function usageError(
  code: string,
  message: string,
  details: Record<string, string> = {},
): HappyworkError {
  return new HappyworkError(code, message, ExitCode.USAGE, details);
}

/** 输入错误（文件不存在、无法读取、格式不受支持） */
export function inputError(
  code: string,
  message: string,
  details: Record<string, string> = {},
): HappyworkError {
  return new HappyworkError(code, message, ExitCode.INPUT, details);
}
