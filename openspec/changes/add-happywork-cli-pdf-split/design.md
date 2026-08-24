## Context

动机见 proposal.md - Why；对外行为契约见本变更的三份 spec。此处只记录塑造实现方式的现状与约束。

已实测的输入样本（`documents/books/《投资的护城河…》.pdf`）：

```
266 页 / 43,099,648 字节 / PDF 1.4
每页 1 张整版 JPEG（DCTDecode），1760×2768 或 1764×2770（约 200 DPI）
/Font 0 个 · /ToUnicode 0 个       → 无文字层
/Outlines 262 条，标题为 "1" "2" …  → 扫描软件自动生成，无语义价值
/PageLabels [0→字母, 3→罗马, 8→阿拉伯] → offset = 7（已用第 44、150 页交叉验证）
```

外部约束：MinerU 在线版单文件 ≤ 200 页且 ≤ 200 MB，每账号每天 1000 页高优先级额度。

运行环境：Bun 1.3.7（已装）；本机为 Intel Mac，磁盘仅剩约 5 GB，因此实现不得依赖大体积模型或外部系统二进制。

消费者只有两类：**在终端里读输出的人**，以及**把输出直接读进上下文的 agent**。目前没有第三类程序化消费者（shell 脚本、CI）需要服务——这一点是决策 2 的前提。

## Goals / Non-Goals

**Goals:**

- 让「加一个命令」的成本等于「加一个文件」，帮助与命令目录不需要手写、不会与实现漂移。
- 让输出只有一种格式，人和 agent 都能稳定读取，不存在「两条渲染路径不同步」的腐化面。
- 让 `manifest.json` 成为稳定的对外数据契约——下游只读它，不再重新解析原 PDF。
- 拆分过程可预演、可复算：同样的输入与选项必须得到同样的分片边界。

**Non-Goals:**

- 不做 OCR、不做 Markdown 渲染、不调用任何模型。本变更只交付「切」与「侦察」。
- 不做 PDF 合并、压缩、加解密、页面编辑。
- 不提供 `--json` / `--format` 等输出格式选项（理由见决策 2）。
- 不做全局安装或发布到 npm；本阶段通过 `bun link` 在本机可用即可。
- 不实现 `--align-chapters` 所需章节表的**生成**（那需要 OCR，属后续变更）；本变更只**消费**一份给定的章节表。

## Decisions

### 决策 1：采用 citty 作为命令框架，结果与错误由本项目独占、帮助交给 citty 原生

每个动作用 citty 的 `defineCommand({ meta, args, run })` 声明；命令树用 `subCommands` 组织。参数解析、短别名、`--version`、shell 补全的元数据来源全部由 citty 承担，happywork 不再手写 `args.ts` / `registry.ts` 的分词与路由。

**分工原则：凡 citty 合规的都用它，只有它的产出违反本项目 spec 的部分才自留。**

citty 负责它做得对的部分：分词（`parseArgs`）、参数模型与别名、子命令树、`--version` 的版本来源、**帮助渲染（`renderUsage`，drill-down）**、以及经 `@bomb.sh/tab` 的补全。

- **帮助交给 citty 原生**：`--help` 在每一级调用 citty 的 `renderUsage`（drill-down、英文可接受）；给每个 arg 加 `valueHint` 与 `default`，使原生帮助照样显示类型与默认值（如 `--max-bytes=<bytes> (Default: 190mb)`）；非 TTY 时剥掉 ANSI 颜色码。不再自建 `help.ts` 的四层目录，也不再有 `help --all`。
- **结果与错误仍自留**：命令结果走 `render.ts` 的结构化文本；错误由 `errors.ts` 产出 `ERROR <码>` + 退出码，未知选项显式拒绝、未知领域/动作列出 available —— citty 内置都不满足这些**结构**（与语言无关，语言现已松绑）。命令仍导出 `run(ctx): Doc`，`cli.ts` 的执行 adapter 守住「命令拿不到 stdout」。

```
        commands/pdf/split.ts  defineCommand(args) + 本项目 run(ctx):Doc
                   │
        ┌──────────┼──────────────┬──────────────┬────────────────┐
        ▼          ▼              ▼              ▼                ▼
   citty parseArgs  校验/coerce   citty          tab(citty 树)    cli.ts 执行 adapter
   (分词/别名)      +errors.ts    renderUsage    →complete 脚本   run(ctx):Doc→render→stdout
                   ERROR<码>      →--help        (决策 9)         ★命令拿不到 stdout
```

**为什么是 citty，不是更流行的 commander**：补全是本次重构的第一诉求，而 commander 与 citty **都没有内置补全**，两者都得外挂 `@bomb.sh/tab`。流行度在「补全」这个维度上买不到任何东西。剩下的决定因素是迁移成本：citty 的 `defineCommand({ args, subCommands })` 与现有的 `CommandDef` 声明式对象几乎 1:1，而 commander 的链式 `.command().option().action()` 是逆着现有代码结构改。commander 唯一实打实的优势是 `.argParser()` 能原生解析 `190mb`（citty 不能，见风险），但不足以抵消逆结构迁移 + 补全同样要外挂的代价。

**为什么不是 oclif / stricli / yargs**：

- **oclif**：补全最正统（静态烘焙、支持 zsh），但它接管 help 格式、错误、退出码与 Command 基类，直接撞本项目的三条 spec 约束（输出语法、语义化退出码、命令不得写 stdout）。为两个命令引 oclif 是加农炮打蚊子。
- **stricli**：与本架构最贴合（零依赖、`kind:"parsed"` 支持自定义类型、完整中文 localization、内置 helpAll），但其 `@stricli/auto-complete` 目前**只支持 bash**，而目标 shell 是 zsh —— 一票否决。
- **yargs**：有内置 bash+zsh 补全但是纯动态（每次 TAB 掏一次进程），且 API 风格与本项目 TS-first 的声明式不合。

**这仍是 cli-core spec 中「新增命令自动出现在帮助中」那条场景的实现依据**：新增命令 = 新增一个 `defineCommand` 文件并挂进 `subCommands`，帮助（citty `renderUsage`）与补全都从中派生，不存在手写的第二处。

**代价**：多两个零依赖包（citty + @bomb.sh/tab）。@bomb.sh/tab 版本仍是 0.0.x（Wrangler 2026-01 起用它），是补全这件事目前最好但不最成熟的答案。

### 决策 2：只有一种输出格式——结构化文本，不提供 JSON

全部命令输出同一套结构化文本（区块 + `key: value` + `[record N]` 记录块），语法由 cli-core spec 固定。不提供 `--json`，也不提供 `--format`。

**为什么**：

1. **agent 不跑 `jq`。** 工具输出直接进入上下文被「读」，而不是被程序解析。JSON 的括号、引号、逗号与缩进在这个场景下是纯开销，结构靠视觉分组表达更省 token 且更易读。
2. **双渲染 = 两条代码路径。** 两倍的 bug 面与漂移面，且必然出现「JSON 模式忘了加新字段」这类静默缺陷。
3. **同时服务人和机器通常让两边都变差。** 一份规定良好的结构化文本能同时满足两者；而 JSON 人不想看、随手打印的表格 agent 要猜。

**代价与化解**：结构化文本若没有规定的语法，agent 就是在靠语感猜，会静默出错——这比 JSON 报错更糟。因此语法被写进 spec 而非留给实现自由发挥，其中三条是关键：

- `key: <值到行尾>` 是唯一的键值形式 → 值含空格、中文书名号、方括号均不歧义（本项目的书名和路径全是这种）。
- 集合用 `[chunk 1]` 这样的**记录块**而非对齐表格 → 对齐表格在值含空格时会歧义，记录块不会。
- 数值先输出原始值、再在括号内给人类友好形式（`bytes: 43099648  (43.1 MB)`）→ agent 取前者、人看后者，「人 vs 机器」的矛盾在这一条上被直接消解。

**已知边界**：结构化文本唯一真正输给 JSON 的地方是深层嵌套——超过两层就得依赖缩进约定，而缩进约定就是 YAML。目前 `info` 与 `split` 的输出都只有「区块 → 键值 / 记录列表」两层，完全够用。若将来某命令需要输出树形结构（如章节树），正确做法多半是输出一个文件路径而非把树塞进 stdout；为一个假想的未来现在引入 `--json` 属于过早设计。

**连带简化**：JSON 消失后，原计划的 `schema --json` 一并消失。帮助交给 citty 原生 `renderUsage`（drill-down），不再自建四层目录或 `help --all`——命令结果与错误才是本项目自渲染的部分。

**连带加重**：没有 JSON 就没有 `error.code` 字段可读，因此语义化退出码从锦上添花变成**唯一的机器可判定失败类型**；错误输出也必须有语法，首行固定为 `ERROR <错误码>`。

### 决策 3：选用 `pdf-lib`（spike 已完成，结论如下）

候选 `pdf-lib@1.17.1`（纯 JS）与 `mupdf@1.28`（WASM）。用真实样本（266 页 / 43,099,648 字节）各拆一次为 `[0,141]` + `[142,265]`，实测：

| 指标 | pdf-lib | mupdf |
|---|---|---|
| 耗时 | **295 ms** | 303 ms |
| 峰值 RSS | **140 MB** | 245 MB |
| 分片体积 | 23.0 MB + 18.1 MB | 23.0 MB + 18.1 MB |
| 产出合计 | 43,012,382 | 43,062,988 |
| **膨胀比** | **0.998×** | 0.999× |
| 能否读出 `/PageLabels` | ✅ 能 | ✅ 能 |
| 分片是否保留 `/PageLabels` | ❌ 丢失 | ❌ 丢失 |

**结论：选 `pdf-lib`。** 峰值内存低 100 MB，且是纯 JS——没有 WASM 初始化开销，在 Mac 与 Windows 上行为完全一致，少一层平台变量。速度与膨胀比两者无差别。`mupdf` 作为兜底保留（它还能栅格化，若将来要处理需要渲染的原生数字版 PDF，可单独为那条路径引入）。

**两处与原设计预期相反，已据实测更正：**

1. **膨胀比不是问题。** 原本担心 `copyPages` 重复嵌入资源会撑破 200 MB 上限——实测 0.998×，产出反而略小于原文件。这本书无字体、无跨页共享资源，正是最有利的情形；但这也意味着对**扫描件**这一类输入，该风险基本不存在。（对含大量共享字体的原生数字版 PDF 仍需留意，届时重测。）
2. **`pdf-lib` 同样能读 `/PageLabels`**，原设计称其「不支持、需自己解析」不准确。通过 `catalog.get(PDFName.of("PageLabels"))` 可直接取到 `<</Nums [0<</S/A>>3<</S/r>>8<</S/D>>]>>`，只是拿到的是原始 PDF 对象，`/Nums` 数组仍需自行遍历——但那是本来就要写的解析逻辑，不构成选型差异。
3. **`pdf-lib` 在大文件上 OOM 的担忧不成立**：43 MB 输入的峰值 RSS 为 140 MB，反而比 mupdf 低。

**兜底不变**：若将来遇到膨胀比不可接受的输入，退路是绕开高层 API 直接按对象级复制页面资源。

### 决策 4：自行解析 `/PageLabels` 并写入 manifest，不依赖分片继承

`copyPages` 类 API 普遍不保留 `/PageLabels`——spike 已实证：`pdf-lib` 与 `mupdf` 拆出的四个分片**全部丢失** `/PageLabels`。与其尝试在分片里重建它（各库支持度不一，且下游未必读），不如**只在源文件上解析一次**，把「PDF 页序号 → 印刷页码」的映射固化进 `manifest.json`。

**为什么**：这是本工具存在的理由。分片 PDF 只需承载像素，坐标系交给 manifest 承载——职责分离后，换 PDF 库不影响下游契约。

### 决策 5：manifest 保持 JSON，与 CLI 输出格式的选择互不牵连

决策 2 把 CLI 的 stdout 定为结构化文本，但 `manifest.json` 仍是 JSON。

**为什么**：两者受众不同，不应因「一致性」而统一。

```
CLI stdout    = 一条消息，读一次就扔，进 agent 的上下文   → 结构化文本
manifest.json = 一个数据文件，被下游程序反复读取         → JSON
```

manifest 的消费者是后续的「PDF → 分章 Markdown」流水线，那是真正的程序，`JSON.parse` 一行即可；而它是文件、不进上下文，决策 2 里「token 开销」那条理由在此不成立。

**备选**：统一成同一套结构化文本（一致性最高，但下游要自己写解析器），或改用 TOML（既标准又可读）。两者都可行，放弃的原因是 JSON 在「被程序读」这个唯一用途上没有短板，而换格式要付出下游成本。

### 决策 6：拆分边界的计算与写盘彻底分离

`planSplit(源元信息, 选项) → 分片方案` 是一个纯函数，不碰文件系统。`--dry-run` 就是只跑这个函数并渲染其结果。

**为什么**：拆分逻辑的复杂度（页数上限 × 体积上限 × 章节对齐 × 重叠页的相互作用）全部集中在这个纯函数里，可以用构造出的元信息做穷尽的单元测试，不需要准备几十个 PDF 样本。同时 `--dry-run` 与实际拆分共用同一段代码，spec 中「预演输出与实际拆分一致」这条场景由构造保证，而非靠测试守护。

**边界求解顺序**：先按章节对齐（若启用）取满足页数上限的最大分片，再对超出体积上限的分片二分细化，最后叠加重叠页。重叠页在最后叠加是因为它只扩张分片、不影响「无重不漏」的基准区间划分。

### 决策 7：`pdf info` 与 `pdf split` 共用同一层元信息读取

两者都需要页数、字节数、`/PageLabels`、逐页图像信息。抽出一个 `readPdfMeta()` 作为公共底座，`info` 是它的渲染器，`split` 是它的消费者。

**为什么**：`info` 因此天然成为 `split` 的调试工具——当拆分结果可疑时，`info --pages` 给出的正是拆分决策所依据的同一份数据。

### 决策 8：代码放在仓库根目录的 `happywork/`，保持可迁出的干净边界

作为仓库根下的独立 Bun 包（自带 `package.json`），不与 happyinvest 的任何内容耦合，不 import 仓库其他目录。

**为什么**：现在只有一个工具、唯一消费者就是本仓库，立刻开独立仓库要付出 repo、link、版本三份成本，收益为零。保持包边界干净，等工具数量达到 3 个以上时，迁出就是一次 `git mv`——而从根目录迁出比从嵌套的 `tools/` 里捞出来更干净，这也是不加中间层的理由之一。

**备选**：立刻建 `/Users/mac/happy/code/happywork` 独立仓库。放弃原因如上；另外该路径当前不在本会话的可写范围内。

### 决策 9：补全分两条路径——命令名/选项名可静态，选项值走动态回调

`happywork p<TAB> → pdf` 这类补全命令树是编译期已知的（registry 即静态数组），理论上可烘成一份零延迟的 zsh 脚本。但选项值补全（`split <input>` 的文件路径、`--align-chapters` 的章节表文件）取决于运行时文件系统，只能动态回调。

采用的策略：

- **命令名 / 选项名**：由 @bomb.sh/tab 从 citty 定义生成。
- **文件类位置参数与选项**（`input`、`--align-chapters`、`--out-dir`）：补全时回落到 **shell 原生文件补全**，不在进程内计算 —— 避开每次 TAB 120~200ms 的进程启动开销（实测 `bun src/cli.ts help` 冷启动 200ms，`bun build --compile` 后 120ms）。
- **枚举类选项**：从 citty 的 enum 定义直接给候选。

安装形态：`happywork complete <shell>`（tab 注入的命令名；`completion` 保留为等价别名）输出一份**通用且静态**的补全脚本——脚本内不含任何命令名，只在补全时回调 `happywork complete -- <words>` 实时取候选。因此**新增命令/选项时该脚本无需重新生成**，装一次即永远同步（候选由运行时的命令树派生，与决策 1「帮助与补全都从 registry 派生、无第二处手写」同源）。

**安装位置用 fpath 补全目录，不用 `>> ~/.zshrc`。** zsh 的惯例是把 `#compdef` 脚本放进 `fpath` 上的补全目录（本机为 `~/.oh-my-zsh/custom/completions/`，`_openspec` 即在此），交由 `compinit` 自动加载：

```
happywork complete zsh > ~/.oh-my-zsh/custom/completions/_happywork
rm -f ~/.zcompdump*   # 清 compinit 缓存，使其读到新文件
exec zsh              # 重载
```

`>> ~/.zshrc` 会把整段脚本（约 200 行）灌进 rc、每开一个 shell 重新 source 一遍，且依赖它恰好出现在 `compinit` 之后，是更脆弱的形态。**这一步是必需的、不是可选的**：补全脚本未装进 shell 时，`happywork p<TAB>` 会回退到 zsh 默认的文件名补全——表面看是「提示的不对」，而补全引擎其实完全正常（`complete -- p` → `pdf` 实测正确）。延迟预算写进 spec 的补全需求场景，避免实现时才发现卡顿。

### 决策 10：源码分三层——commands 定义、core 引擎、infra 共享能力

- `commands/<领域>/*.ts`：命令的定义与描述（名称、参数、选项、run 接线）。
- `core/*.ts`：CLI 引擎（citty 桥接、参数校验、渲染、错误、路由、补全）。
- `infra/<领域>/*.ts`：与命令无关的基础能力，多命令共用。`pdf` 的操作（`meta` / `plan` / `split` / `advice`）即属此层，由 `src/pdf/` 迁入 `src/infra/pdf/`。

**为什么**：`info` 与 `split` 都消费同一份 pdf 操作，把它们从命令目录里拎出来单独成层，既避免命令目录里堆逻辑，也让将来 `epub` / `web` 等领域各自在 `infra/<领域>/` 并列扩展。与决策 8（包边界）正交：决策 8 管 happywork 包与仓库的边界，本决策管包内部的分层。

## Risks / Trade-offs

- ~~**分片体积膨胀导致撞破 200 MB 上限**~~ → **已由 spike 解除**：实测膨胀比 0.998×。`--max-bytes` 默认仍取 190 MB 留余量，spec 中「分片超限继续细分」的规则保留作为对未知输入的防线。
- ~~**`pdf-lib` 全量载入内存，在大文件上可能 OOM**~~ → **已由 spike 解除**：43 MB 输入峰值 RSS 仅 140 MB，低于 mupdf 的 245 MB。若将来遇到数百 MB 的输入需重测。
- **结构化文本被实现得随意，退化成散文** → 语法写死在 cli-core spec 里并配有可测场景（键值到行尾、记录块、缺失值 `-`、不折行）；渲染统一走单一输出层，命令本身不得直接 `console.log` 结果。
- **章节对齐与页数上限相互冲突（单章超过上限）** → spec 已明确退让规则：在该章内部按页数切分并显式警告，而不是静默切开或直接失败。
- **`/PageLabels` 解析出的 offset 可能与实际印刷页码不符**（扫描件常见错页、插页） → offset 只作为 manifest 中的一个字段记录，不作为拆分正确性的前提；`pdf info` 输出判定依据，由人在首次处理一本新书时用 `--pages` 抽查确认。
- **重叠页消耗下游额度** → `--overlap` 默认为 `0`，只在需要修复跨切口内容时显式启用；manifest 标出重叠页，下游可据此去重。
- **版权** → 工具本身不含任何书籍内容；但需在实现前把 `documents/books/` 与拆分产物加入 `.gitignore`（当前该文件为空）。
- **citty 不支持自定义解析器** → `--max-bytes 190mb`、`path` 型转换需在 `run()` 内自行完成，且帮助里显示的类型会退化成 `string`；在 `showUsage` 渲染时手工补回类型标注，守住 spec「声明与实际行为一致」那条场景。
- **citty 的 run 可 `console.log`，松动「命令不得写 stdout」** → 由决策 1 的 `run(ctx):Doc` adapter 在类型层面重新焊住。
- **@bomb.sh/tab 处于 0.0.x** → 生态很新；接线集中在 `core/citty.ts`（命令树）与 `cli.ts` 的 `complete` 分支，将来若换补全方案，爆炸半径限于此。
- **位置参数漏进选项补全** → `@bomb.sh/tab` 的 citty 适配器把命令的全部参数（含 `type:"positional"`）都当作 `--选项` 列出，于是 `happywork pdf info --<TAB>` 会给出并不存在的 `--input`（它其实是位置参数「待侦察文件」）。无害，但属「提示的不对」。修法是在 `toCittyArgs` 生成供补全消费的树时不把位置参数登记为 flag，或在 tab 消费层过滤；因影响面小，列为可选收尾项（任务 8.2），不阻塞归档。

## Migration Plan

全新工具，无既有行为需要迁移。启用步骤：在 `happywork/` 执行 `bun install`（含新增的 citty 与 @bomb.sh/tab）与 `bun link`，此后 `happywork` 全局可用；再把补全脚本写进 fpath 补全目录（`happywork complete zsh > ~/.oh-my-zsh/custom/completions/_happywork`，随后清 `~/.zcompdump*` 并重载，详见决策 9）即启用 TAB 补全。回退即 `bun unlink`、删除该 `_happywork` 文件并删除该目录，对仓库其余部分无影响。

## Open Questions

- 分片文件名中的书名部分如何从中文文件名（含 `《》`、`+`、`[]`）安全派生？倾向保留原名并只替换文件系统敏感字符，但具体规则可在实现时定，不影响 spec 与任务拆分。
- `--max-bytes` 的字面量是否需要支持 `mb` / `mib` 等多种后缀？先支持 `b/kb/mb/gb` 十进制即可，扩展不影响契约。
