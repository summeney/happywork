#!/usr/bin/env bun
/**
 * happywork —— 个人实用命令行工具集
 *
 * happywork <领域> <动作> [位置参数] [--选项]
 *
 * 本文件只做三件事：路由、渲染结果、渲染错误。
 * 输出格式集中在渲染层，命令自身返回 Doc，无法直接写 stdout。
 */
import { runCommand } from "citty";
import tab from "@bomb.sh/tab/citty";
import { parseInvocation } from "./core/args.ts";
import { actionHelpText, buildMain, domainHelpText, readVersion, topHelpText } from "./core/citty.ts";
import { ExitCode, HappyworkError, type ExitCodeValue } from "./core/errors.ts";
import { writeDiagnostic, writeResult } from "./core/io.ts";
import { render } from "./core/render.ts";
import { hasDomain, resolve as resolveCommand } from "./core/registry.ts";

function renderError(err: HappyworkError): string {
  const details: Record<string, string> = { ...err.details, message: err.message };
  const width = Math.max(...Object.keys(details).map((k) => k.length));
  const lines = [`ERROR ${err.code}`];
  for (const [k, v] of Object.entries(details)) {
    lines.push(`  ${(k + ":").padEnd(width + 1)} ${v}`);
  }
  return lines.join("\n");
}

function isHelpFlag(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

async function main(argv: string[]): Promise<ExitCodeValue> {
  const first = argv[0];

  // happywork --version / -v → 版本号
  if (first === "--version" || first === "-v") {
    writeResult(readVersion());
    return ExitCode.OK;
  }

  // happywork complete [shell] / complete -- <words> → 交给 @bomb.sh/tab
  // completion 作为等价别名，改写为 complete 后同样派发
  if (first === "complete" || first === "completion") {
    // 补全专用树：省去位置参数，避免 tab 把 input 列成 --input 幻影（任务 8.2）
    const cittyMain = buildMain({ forCompletion: true });
    await tab(cittyMain);
    const rawArgs = first === "completion" ? ["complete", ...argv.slice(1)] : argv;
    await runCommand(cittyMain, { rawArgs, showUsage: false });
    return ExitCode.OK;
  }

  // happywork / help / --help → citty 原生顶层帮助（列出领域）
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    writeResult(await topHelpText());
    return ExitCode.OK;
  }

  const second = argv[1];

  // happywork <领域> [help|--help] → citty 原生领域帮助（列出该领域动作）
  if (hasDomain(first) && (second === undefined || second === "help" || isHelpFlag([second]))) {
    writeResult(await domainHelpText(first));
    return ExitCode.OK;
  }

  if (second === undefined) {
    // 领域不存在且没有第二个词：交给 resolve 产出带可用项清单的错误
    resolveCommand(first, "");
    return ExitCode.USAGE;
  }

  const cmd = resolveCommand(first, second);
  const rest = argv.slice(2);

  // happywork <领域> <动作> --help → citty 原生动作帮助
  if (isHelpFlag(rest)) {
    writeResult(await actionHelpText(first, second));
    return ExitCode.OK;
  }

  const { ctx } = parseInvocation(cmd, rest);
  const doc = await cmd.run(ctx);
  writeResult(render(doc));
  return ExitCode.OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof HappyworkError) {
    writeDiagnostic(renderError(e));
    process.exitCode = e.exitCode;
  } else {
    const err = e as Error;
    writeDiagnostic(
      renderError(
        new HappyworkError("internal-error", err.message, ExitCode.INTERNAL, {
          stack: (err.stack ?? "").split("\n").slice(0, 3).join(" | "),
        }),
      ),
    );
    process.exitCode = ExitCode.INTERNAL;
  }
}
