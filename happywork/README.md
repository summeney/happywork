# happywork

个人实用命令行工具的统一容器。调用形态固定为：

```
happywork <领域> <动作> [位置参数] [--选项]
```

首个领域是 `pdf`（侦察与拆分），主要服务于「把超限的扫描版 PDF 拆分后送去文档解析」这条流水线。

## 安装

```bash
cd happywork
bun install
bun link           # 之后 happywork 全局可用
```

### 启用 TAB 补全（必需，否则 `happywork p<TAB>` 会补出文件名而非 `pdf`）

补全脚本是**通用且静态**的——它不含任何命令名，只在补全时回调 `happywork complete -- <words>` 实时取候选，因此**新增命令/选项后无需重装**。把它写进 shell 的 fpath 补全目录（而不是 `>> ~/.zshrc`）：

```bash
# zsh：写进 fpath 上一个可写的补全目录，交给 compinit 自动加载
mkdir -p ~/.zsh/completions
# 若该目录尚不在 fpath，向 ~/.zshrc 顶部（compinit 之前）加一行：
#   fpath=(~/.zsh/completions $fpath)
# oh-my-zsh 用户可直接用现成的 ~/.oh-my-zsh/custom/completions/（已在 fpath 上）
happywork complete zsh > ~/.zsh/completions/_happywork
rm -f ~/.zcompdump*   # 清 compinit 缓存
exec zsh              # 重载
```

```bash
# bash
happywork complete bash > ~/.local/share/bash-completion/completions/happywork
exec bash

# fish
happywork complete fish > ~/.config/fish/completions/happywork.fish
```

> 未安装时按 TAB 没有 happywork 的补全注册，shell 会回退到默认的**文件名补全**，看起来就是「提示的不对」——但补全引擎本身正常（`happywork complete -- p` 会返回 `pdf`）。装好后：`happywork p<TAB>` → `pdf`，`happywork pdf info --<TAB>` → 各选项。
>
> 不建议 `happywork complete zsh >> ~/.zshrc`：那会把整段脚本灌进 rc、每开一个 shell 重新 source，且依赖它恰好排在 `compinit` 之后，更脆弱。

回退：`bun unlink`，删除上面写出的 `_happywork` / `happywork` / `happywork.fish` 补全文件即可。

## 设计契约（给人，也给 agent）

- **只有一种输出格式**：规定语法的结构化文本，**没有 `--json`**。
- **stdout 只放结果，stderr 只放日志**；失败时 stdout 为空。
- **语义化退出码**：`0` 成功 / `1` 用法错误 / `2` 输入错误 / `3` 内部错误。
- **路径输出为绝对路径**；**非 TTY 零交互**（要覆盖必须显式 `--force`）。
- **帮助不会与实现漂移**：帮助由命令定义经 citty 原生 `renderUsage` 派生（逐级 drill-down）。
- 底层用 [citty](https://github.com/unjs/citty) 做参数解析与子命令树、[@bomb.sh/tab](https://github.com/bombshell-dev/tab) 做补全；帮助与错误的中文渲染由本项目独占。

### 输出语法

```
BLOCK-NAME               区块以全大写名起头
  key: <值直到行尾>       冒号后到行尾都是值，含空格/中文/括号可原样取回
  bytes: 43099648  (43.1 MB)   数值先原始值，再括号内人类可读形式
  offset: -              缺失值一律渲染为 -

[record N]               记录块（如各分片）以 [名称 序号] 起头
  ...
```

一行一个事实、绝不折行，因此 `grep`/按行切分即可解析。

## 命令帮助（citty 原生，逐级 drill-down）

```bash
happywork --help          # 顶层：列出领域
happywork pdf --help      # 某领域：列出动作
happywork pdf info --help # 某动作：参数、选项类型与默认值
happywork --version       # 版本号
```

帮助由命令定义派生（citty `renderUsage`），逐级展开；非 TTY（管道）下自动去色。

## `pdf info` —— 只读侦察

```bash
happywork pdf info <文件> [--pages] [--max-pages 200] [--max-bytes 190mb]
```

输出页数、字节数、有无文字层（扫描件判定）、`/PageLabels` 解析结果与印刷页 `offset`、以及是否需要拆分。`--pages` 额外逐页列出图像元信息。

```bash
happywork pdf info "投资的护城河.pdf"
# SOURCE / TEXT-LAYER / PAGE-LABELS / SPLIT-ADVICE 四个区块
```

## `pdf split` —— 拆分并产出 manifest

```bash
happywork pdf split <文件> \
  [-o|--out-dir <目录>] [--max-pages 200] [--max-bytes 190mb] \
  [--align-chapters <章节表.json>] [--overlap 0] [--dry-run] [--force]
```

- 按页数与体积上限拆分，每个分片同时满足两个上限。
- `--align-chapters` 让拆分点落在章首（章节表见下）；`--dry-run` 只输出方案、不写盘。
- 产出各分片 PDF 与一份 **`manifest.json`**：源文件指纹、`/PageLabels` 与 offset、本次全部选项、每个分片的文件名 / 源页区间 / 印刷页区间 / 页数 / 字节数 / 重叠页。
- 分片文件名形如 `<书名>_01_p0001-0142.pdf`，按名称升序即原书顺序。
- **`/PageLabels` 不随分片继承**（主流库都会丢），页码映射只存在 `manifest.json` 中——这正是本工具存在的理由。

先预演，确认方案再实跑：

```bash
happywork pdf split "投资的护城河.pdf" --align-chapters chapters.json --dry-run
happywork pdf split "投资的护城河.pdf" --align-chapters chapters.json -o out/
```

章节表是一个 JSON 数组，每章给 `title` 与 `printedStart`（印刷页码，工具用 offset 换算为页序号）或 `srcStart`（0 基 PDF 页序号）：

```json
[
  { "number": 1, "title": "指导原则", "printedStart": 1 },
  { "number": 8, "title": "投资组合策略", "printedStart": 135 }
]
```

## 给 agent 的调用范式

1. 用 `happywork --help` → `happywork <领域> --help` → `happywork <领域> <动作> --help` 逐级发现命令、参数与选项（原生帮助会显示每个选项的类型与默认值）。
2. 执行命令，**只解析 stdout**；按 `key: 值到行尾` 逐行取值，缺失值为 `-`。
3. 判定成功看**退出码**，不要解析 message 文案；失败时读 stderr 首行 `ERROR <错误码>`。
4. 写操作默认不覆盖；确需覆盖时显式加 `--force`。破坏性动作前先 `--dry-run`。

## 开发

```bash
bun test          # 全部单元与集成测试
```

代码是仓库根下的独立 Bun 包，不 import 仓库其他目录，日后可整体 `git mv` 迁出为独立仓库。
