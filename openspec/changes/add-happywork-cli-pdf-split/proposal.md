## Why

投研方法论需要从大量投资类书籍中提炼，但这些书目前都是扫描版 PDF（如《投资的护城河》：266 页、43 MB、**无文字层**，每页一张 JPEG）。计划用 MinerU 在线版做文档解析，但它限制**单文件 ≤ 200 页、≤ 200 MB**，超限的书必须先拆分。

而拆分不是简单切页：原 PDF 的 `/PageLabels` 记录了「PDF 页序号 ↔ 书上印刷页码」的映射（本书 offset = 7），主流 PDF 库的 `copyPages` **不会保留它**。一旦丢失，下游的章节归属、页码锚点、以及「某个观点出自原书第几页」的溯源链路全部断裂——而溯源正是本仓库的立身之本。

同时，这类命令行小工具会持续出现（拆分、侦察、章节切分、Markdown 渲染……），需要一个统一的落脚点，并且要让 Claude 等 agent 能**免文档地发现和调用**它们。

## What Changes

- 新建 `happywork` CLI（Bun + TypeScript），调用形态为 `happywork <领域> <动作> [位置参数] [--选项]`，作为个人实用命令行工具的统一容器。
- 基于 **citty** 声明式定义命令：每个命令在单一文件中用 `defineCommand` 声明名称、参数、选项、说明与执行函数；参数解析、短别名、`--version`、shell 补全的元数据均由这份声明驱动，而帮助与输出语法由本项目独占（`showUsage` 接管、复用统一渲染层），帮助永远不会与实现漂移。
- 落地 agent 友好契约：**命令结果只有一种输出格式——规定语法的结构化文本，不提供 `--json`**；帮助由 citty 原生渲染（`--help` 逐级 drill-down）；stdout 只放结果 / stderr 只放日志；语义化退出码；输出绝对路径；非 TTY 零交互；提供 **shell 补全**（命令名/选项名/选项值）与 `--version`。
- 实现第一个领域 `pdf`，含两个动作：
  - `pdf info`：侦察 PDF——页数、字节数、是否有文字层（扫描件判定）、`/PageLabels` 与印刷页 offset、每页图像类型与尺寸。
  - `pdf split`：按 `--max-pages` / `--max-bytes` 拆分，支持 `--align-chapters` 章节对齐、`--overlap` 重叠页、`--dry-run` 预演；产出各分片 PDF 与一份 **`manifest.json`**，完整记录源文件指纹、页码映射与分片边界。
- 代码位置：仓库根目录下的 `happywork/`（独立 Bun 包，保持干净边界，日后可整体迁出为独立仓库）。

## Capabilities

### New Capabilities

- `happywork/cli-core`: CLI 的骨架契约——命令路由（领域/动作两级）、基于 citty 的声明式命令定义、单一结构化文本结果输出语法、错误输出语法、citty 原生命令帮助（drill-down）、语义化退出码、非 TTY 零交互、shell 补全、版本查询。
- `happywork/pdf-info`: 对单个 PDF 做只读侦察，输出页数、体积、文字层有无、`/PageLabels` 解析结果与印刷页 offset、逐页图像元信息。
- `happywork/pdf-split`: 将 PDF 按页数与体积上限拆分为多个分片，支持章节对齐与重叠页，并产出记录完整页码映射的 `manifest.json`；提供 `--dry-run` 只输出拆分方案。

### Modified Capabilities

（无——本仓库当前尚无既有 spec。）

## Impact

- **新增目录**：仓库根下的 `happywork/`（`package.json`、`src/`、`test/`），可通过 `bun link` 暴露 `happywork` 命令。
- **新增依赖**：一个 PDF 读写库（`pdf-lib` 与 `mupdf` 二选一，需先做基准 spike 定夺，见 design.md）；CLI 框架 `citty` 与补全库 `@bomb.sh/tab`（均零依赖 ESM，见 design.md 决策 1、9）；测试用 `bun:test`，无额外测试框架。
- **不改动**：`documents/`、`methodology/` 及仓库现有内容；本变更只新增工具，不产出书籍转换结果。
- **下游依赖**：后续「PDF → 分章 Markdown」的完整流水线将消费本工具产出的分片与 `manifest.json`；`manifest.json` 的字段结构因此成为对外契约，需在 spec 中固定。
- **待验证的外部前提**（不阻塞本变更，但影响后续流水线）：MinerU 在线版下载包中是否包含 `content_list.json`。建议先用本书目录 3 页做一次小规模试跑确认。
- **版权**：转换产物与原书 PDF 均属受版权保护内容，仅限本地私有使用；仓库当前 `.gitignore` 为空，应在实现前确认 `documents/books/` 不被提交到任何公开远端。
