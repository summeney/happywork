import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseInvocation, parseBytes } from "../src/core/args.ts";
import { ExitCode, HappyworkError } from "../src/core/errors.ts";
import { guardOutDir } from "../src/core/fs.ts";
import { COMMANDS, actionsOf, domains, resolve as resolveCommand } from "../src/core/registry.ts";
import { block, bytes, entry, record, render, renderValue } from "../src/core/render.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

async function run(...argv: string[]) {
  const p = Bun.spawn(["bun", CLI, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await p.exited };
}

/** 按输出语法把一段文本解析回键值对：冒号后至行尾 */
function parseEntries(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("  ")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    m.set(line.slice(0, i).trim(), line.slice(i + 1).trimStart());
  }
  return m;
}

describe("两级命令路由", () => {
  test("正常调用路由到目标命令", () => {
    const cmd = resolveCommand("pdf", "info");
    expect(cmd.domain).toBe("pdf");
    expect(cmd.action).toBe("info");
  });

  test("领域不存在：报错、列出可用领域、退出码 1", async () => {
    const r = await run("foo", "bar");
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.stdout).toBe("");
    expect(r.stderr.split("\n")[0]).toBe("ERROR unknown-domain");
    expect(parseEntries(r.stderr).get("available")).toBe(domains().join(" "));
  });

  test("动作不存在：报错、列出该领域可用动作、退出码 1", async () => {
    const r = await run("pdf", "nonexistent");
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.stderr.split("\n")[0]).toBe("ERROR unknown-action");
    expect(parseEntries(r.stderr).get("available")).toBe(
      actionsOf("pdf").map((c) => c.action).join(" "),
    );
  });
});

describe("命令目录与帮助（citty 原生 drill-down）", () => {
  test("顶层帮助列出全部领域，退出码 0", async () => {
    const r = await run("--help");
    expect(r.exitCode).toBe(ExitCode.OK);
    for (const d of domains()) expect(r.stdout).toContain(d);
  });

  test("领域帮助列出该领域全部动作（新增命令自动出现）", async () => {
    const r = await run("pdf", "--help");
    expect(r.exitCode).toBe(ExitCode.OK);
    for (const cmd of actionsOf("pdf")) expect(r.stdout).toContain(cmd.action);
  });

  test("动作帮助列出摘要、位置参数、选项类型与默认值", async () => {
    const r = await run("pdf", "split", "--help");
    expect(r.exitCode).toBe(ExitCode.OK);
    const cmd = resolveCommand("pdf", "split");
    expect(r.stdout).toContain(cmd.summary);
    for (const a of cmd.args) expect(r.stdout).toContain(a.name.toUpperCase());
    for (const f of cmd.flags) expect(r.stdout).toContain(`--${f.name}`);
    expect(r.stdout).toContain("<bytes>"); // 类型（valueHint）
    expect(r.stdout).toContain("Default: 200"); // 默认值
  });

  test("非 TTY 帮助不含 ANSI 颜色码", async () => {
    const r = await run("pdf", "info", "--help");
    expect(r.stdout).not.toContain("\x1b[");
  });
});

describe("帮助声明与实际行为一致", () => {
  test("声明的每个选项都被实际接受", () => {
    for (const cmd of COMMANDS) {
      for (const f of cmd.flags) {
        const argv = ["/tmp/x.pdf"];
        if (f.type === "bool") argv.push(`--${f.name}`);
        else if (f.type === "int") argv.push(`--${f.name}`, "1");
        else if (f.type === "bytes") argv.push(`--${f.name}`, "1mb");
        else argv.push(`--${f.name}`, "/tmp/y");
        expect(() => parseInvocation(cmd, argv)).not.toThrow();
      }
    }
  });

  test("int 型选项拒绝非整数，退出码 1", async () => {
    const r = await run("pdf", "info", "/tmp/x.pdf", "--max-pages", "abc");
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.stderr.split("\n")[0]).toBe("ERROR invalid-flag-value");
  });

  test("缺少必需位置参数，退出码 1", async () => {
    const r = await run("pdf", "info");
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.stderr.split("\n")[0]).toBe("ERROR missing-argument");
  });

  test("默认值按声明填入，bytes 字面量被解析", () => {
    const cmd = resolveCommand("pdf", "split");
    const { ctx } = parseInvocation(cmd, ["/tmp/x.pdf"]);
    expect(ctx.flags["max-pages"]).toBe(200);
    expect(ctx.flags["max-bytes"]).toBe(190_000_000);
    expect(ctx.flags["overlap"]).toBe(0);
    expect(ctx.flags["dry-run"]).toBe(false);
  });

  test("path 型参数被转为绝对路径", () => {
    const cmd = resolveCommand("pdf", "info");
    const { ctx } = parseInvocation(cmd, ["./rel.pdf"]);
    expect(ctx.args["input"]).toBe(resolve(process.cwd(), "./rel.pdf"));
  });

  test("parseBytes 支持 b/kb/mb/gb", () => {
    expect(parseBytes("4096")).toBe(4096);
    expect(parseBytes("190mb")).toBe(190_000_000);
    expect(parseBytes("1.5gb")).toBe(1_500_000_000);
  });
});

describe("结构化文本输出语法", () => {
  test("值含空格、中文书名号与方括号仍可原样取回", () => {
    const path = "/Users/mac/《投资的护城河-晨星公司》 +[希瑟].pdf";
    const text = render([block("SOURCE", [entry("path", path), entry("pages", 266)])]);
    expect(parseEntries(text).get("path")).toBe(path);
  });

  test("缺失值渲染为 -，不留空、不输出 null", () => {
    const text = render([block("X", [entry("offset", null), entry("other", undefined)])]);
    expect(parseEntries(text).get("offset")).toBe("-");
    expect(parseEntries(text).get("other")).toBe("-");
    expect(text).not.toContain("null");
  });

  test("数值先原始值、再括号内人类形式", () => {
    expect(renderValue(bytes(43_099_648))).toBe("43099648  (43.1 MB)");
  });

  test("一行一个事实：内部换行被压平，不折行", () => {
    const text = render([block("X", [entry("k", "第一行\n第二行")])]);
    expect(text.split("\n").filter((l) => l.includes("第二行"))).toHaveLength(1);
    expect(parseEntries(text).get("k")).toBe("第一行 第二行");
  });

  test("记录块用 [名称 序号] 起头，区块间以空行分隔", () => {
    const text = render([
      block("SOURCE", [entry("pages", 266)]),
      record("chunk", 1, [entry("file", "a.pdf")]),
      record("chunk", 2, [entry("file", "b.pdf")]),
    ]);
    expect(text).toContain("[chunk 1]");
    expect(text).toContain("[chunk 2]");
    expect(text).toContain("\n\n");
  });
});

describe("错误输出语法与退出码", () => {
  test("首行为 ERROR <错误码>，其后含 message", async () => {
    const r = await run("pdf", "info", "/definitely/missing/file.pdf");
    expect(r.stderr.split("\n")[0]).toMatch(/^ERROR [a-z-]+$/);
    expect(parseEntries(r.stderr).has("message")).toBe(true);
  });

  test("错误码稳定：同一类失败重复得到相同错误码", async () => {
    const a = await run("foo", "bar");
    const b = await run("baz", "qux");
    expect(a.stderr.split("\n")[0]).toBe(b.stderr.split("\n")[0]);
  });

  test("退出码分档：输入错误为 2", () => {
    const e = new HappyworkError("x", "y", ExitCode.INPUT);
    expect(e.exitCode).toBe(2);
  });
});

describe("流分离", () => {
  test("结果只走 stdout，失败时 stdout 为空", async () => {
    const ok = await run("help");
    expect(ok.stdout.length).toBeGreaterThan(0);
    expect(ok.stderr).toBe("");
    const bad = await run("foo", "bar");
    expect(bad.stdout).toBe("");
    expect(bad.stderr.length).toBeGreaterThan(0);
  });
});

describe("非交互执行与 --force 覆盖保护", () => {
  test("输出目录非空且无 --force：拒绝，退出码 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    writeFileSync(join(dir, "existing.txt"), "x");
    try {
      expect(() => guardOutDir(dir, false)).toThrow(HappyworkError);
      try {
        guardOutDir(dir, false);
      } catch (e) {
        expect((e as HappyworkError).code).toBe("output-dir-not-empty");
        expect((e as HappyworkError).exitCode).toBe(ExitCode.INPUT);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("传入 --force 则放行；空目录与不存在的目录直接放行", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    writeFileSync(join(dir, "existing.txt"), "x");
    try {
      expect(() => guardOutDir(dir, true)).not.toThrow();
      expect(() => guardOutDir(join(dir, "nope"), false)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("短选项别名", () => {
  test("帮助同时显示 -o 与 --out-dir", async () => {
    const r = await run("pdf", "split", "--help");
    expect(r.stdout).toContain("-o, --out-dir");
  });

  test("-o 与 --out-dir 等效", () => {
    const cmd = resolveCommand("pdf", "split");
    const viaLong = parseInvocation(cmd, ["/tmp/x.pdf", "--out-dir", "/tmp/out"]).ctx;
    const viaShort = parseInvocation(cmd, ["/tmp/x.pdf", "-o", "/tmp/out"]).ctx;
    expect(viaShort.flags["out-dir"]).toBe(viaLong.flags["out-dir"]);
    expect(viaShort.flags["out-dir"]).toBe(resolve(process.cwd(), "/tmp/out"));
  });

  test("-p 等效于 --pages（bool）", () => {
    const cmd = resolveCommand("pdf", "info");
    expect(parseInvocation(cmd, ["/tmp/x.pdf", "-p"]).ctx.flags["pages"]).toBe(true);
  });
});

describe("版本查询", () => {
  test("--version 输出版本号，退出码 0", async () => {
    const r = await run("--version");
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stderr).toBe("");
  });

  test("-v 与 --version 输出一致", async () => {
    const long = await run("--version");
    const short = await run("-v");
    expect(short.stdout.trim()).toBe(long.stdout.trim());
  });
});

describe("Shell 补全", () => {
  // 每项都要冷启动 `bun` 子进程并加载 @bomb.sh/tab，满负载并行下冷启动会被拖慢，
  // 故放宽超时到 20s（standalone 实测约 200ms）。
  const TIMEOUT = 20_000;

  test(
    "complete zsh 输出可 source 的 zsh 脚本，退出码 0",
    async () => {
      const r = await run("complete", "zsh");
      expect(r.exitCode).toBe(ExitCode.OK);
      expect(r.stdout).toContain("#compdef happywork");
    },
    TIMEOUT,
  );

  test(
    "completion 作为别名等效于 complete",
    async () => {
      const a = await run("complete", "zsh");
      const b = await run("completion", "zsh");
      expect(b.stdout).toBe(a.stdout);
    },
    TIMEOUT,
  );

  test(
    "补全第一个词得到领域 pdf",
    async () => {
      const r = await run("complete", "--", "");
      expect(r.stdout).toContain("pdf");
    },
    TIMEOUT,
  );

  test(
    "补全动作得到 info 与 split",
    async () => {
      const r = await run("complete", "--", "pdf", "");
      expect(r.stdout).toContain("info");
      expect(r.stdout).toContain("split");
    },
    TIMEOUT,
  );

  test(
    "选项补全只含真选项，不含位置参数（无 --input 幻影，任务 8.2）",
    async () => {
      const r = await run("complete", "--", "pdf", "info", "--");
      expect(r.stdout).toContain("--pages");
      expect(r.stdout).toContain("--max-bytes");
      expect(r.stdout).not.toContain("--input");
    },
    TIMEOUT,
  );
});

describe("解析错误不透传底层英文文案", () => {
  test("未知选项：ERROR invalid-flag，message 为中文", async () => {
    const r = await run("pdf", "info", "/tmp/x.pdf", "--nope");
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(r.stderr.split("\n")[0]).toBe("ERROR invalid-flag");
    const msg = parseEntries(r.stderr).get("message") ?? "";
    expect(msg).toContain("未知选项");
    // 回显用户自己的选项名可以，但不得出现 citty 的英文样板文案
    expect(msg).not.toMatch(/Unknown|Missing|argument|command/i);
  });
});
