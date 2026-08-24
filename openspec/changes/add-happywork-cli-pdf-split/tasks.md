## 1. 选型 spike（已完成，结论见 design.md 决策 3）

- [x] 1.1 在仓库根下的 `happywork/` 建最小 Bun 包骨架（`package.json`、`tsconfig.json`、`.gitignore`），仅够跑脚本
- [x] 1.2 写一次性基准脚本：分别用 `pdf-lib` 与 `mupdf` 把样本书拆成 2 份，量出**耗时、峰值内存、各分片字节数之和相对原文件的膨胀比**
- [x] 1.3 用 `documents/books/《投资的护城河…》.pdf`（266 页 / 43 MB）实跑两个库，记录三项指标
- [x] 1.4 验证两个库各自能否读出 `/PageLabels`（期望解析出 `[0→字母, 3→罗马, 8→阿拉伯]`，offset = 7）
- [x] 1.5 定选型，把基准数据与结论补进 `design.md` 决策 3；若两者膨胀比均不可接受，改走兜底方案并更新设计
- [x] 1.6 把 `documents/books/` 与拆分产物目录加入仓库根 `.gitignore`（当前为空文件）

## 2. CLI 骨架（capability: happywork/cli-core）

> 采用 citty 重构（design 决策 1、9）。以下标注 **保留** 的项对应已写好、
> 在 citty 下继续复用的代码（`render.ts` / `errors.ts` / `io.ts` / `fs.ts`）；
> 标注 **重写** 的项对应作废的手写代码（`args.ts` / `command.ts` /
> `registry.ts` / `help.ts`），需按 citty 重新实现。

- [x] 2.4 【保留】实现唯一的结构化文本渲染层（帮助与全部命令共用）：区块、`[record N]` 记录块、`key: <值到行尾>`、数值「原始值 + 括号内人类形式」、缺失值 `-`、不折行；命令本身不得直接向 stdout 打印
- [x] 2.6 【保留】实现错误输出与退出码：`0/1/2/3` 四档语义；错误写入 stderr，首行为 `ERROR <错误码>`，其后为缩进键值条目且至少含 `message`
- [x] 2.7 【保留】实现流分离：结果只走 stdout，进度与诊断只走 stderr
- [x] 2.8 【保留】实现绝对路径输出与非交互约束（含 `--force` 覆盖保护）
- [x] 2.1 【重写】用 citty `defineCommand` 声明命令树（`core/citty.ts`）；命令仍导出 `run(ctx): Doc`，执行 adapter 在 `cli.ts`（parseInvocation→run→render），类型层面守住「命令不得写 stdout」
- [x] 2.2 【重写】用 citty `subCommands` 组织领域/动作两级命令树（`buildMain()`），供 tab 补全与 `complete` 派发消费；路由错误（未知领域/动作 + available 列表）仍由 `registry.ts` 产出，以满足 spec 的中文错误契约
- [x] 2.3 【重写】用 citty `parseArgs` 分词；`bytes`/`path`/`int` 在 `args.ts` 的 coerce 层转换，类型不匹配报 `invalid-flag-value`、退出码 `1`
- [x] 2.5 【改用原生】`--help` 各级改用 citty `renderUsage`（drill-down）；给每个 arg 加 `valueHint` 与 `default`，使原生帮助显示类型与默认值；非 TTY 时剥掉 ANSI 颜色码；**删除 `help.ts`**，去掉 `help --all` 与顶层 USAGE 解释器块
- [x] 2.11 接入 `@bomb.sh/tab`：`happywork complete <shell>`（zsh 已验证）由 citty 定义派生命令名/选项名/枚举值，文件类参数回落 shell 原生补全（默认 `NoFileComp` 仅在补命令名时生效）。**命名**：tab 注入的命令为 `complete`（非 `completion`），已保留 `completion` 作等价别名；spec 场景措辞已按 `complete` 实现
- [x] 2.12 选项短别名（`--out-dir`→`-o`、`--pages`→`-p`）与 `--version`/`-v`（输出 `package.json` 版本号）
- [x] 2.13 未知选项/缺参/多余参数一律由 `args.ts` 映射为统一 `ERROR <码>` 结构（不透传 citty 的原始用法文本；位置参数在 citty 侧一律 optional，必填由 coerce 强制）。message 语言不再强制（全中文已松绑），当前实现为中文即可
- [x] 2.9 【改测】cli-core 测试：删「`help --all` 覆盖」「结构化文本 help」断言，改为原生帮助断言（`--help` drill-down、显示类型与默认值、非 TTY 无 ANSI）；保留路由、输出语法、错误首行与退出码、`--force` 保护、短别名等效、`--version`、`complete zsh` 脚本、解析错误走统一格式
- [x] 2.10 `bin` 入口 `./src/cli.ts` 已 `bun link`；`happywork` / `--version`（0.1.0）/ `complete zsh` 经真实二进制验证可用；`complete -- ''`→`pdf`、`complete -- pdf ''`→`info split`（原生 `--help` 的验证并入 2.9/2.10 重做）

## 3. PDF 元信息底座（capability: happywork/pdf-info）

- [x] 3.1 实现 `readPdfMeta()`：绝对路径、SHA-256、字节数、总页数
- [x] 3.2 实现文字层判定，并输出判定依据（字体数、字符映射数、逐页图像占比）
- [x] 3.3 实现 `/PageLabels` 解析：输出各编号段样式与起始页，并在存在阿拉伯数字段时算出印刷页 offset；无 `/PageLabels` 时内部返回 `null`（渲染为 `-`）且不报错
- [x] 3.4 实现逐页图像元信息采集（图像数量、宽高、压缩方式），仅在 `--pages` 时输出
- [x] 3.5 实现拆分建议：依据页数与体积上限给出 `needsSplit` 及触发原因
- [x] 3.6 用 citty `defineCommand` 实现 `happywork pdf info <文件>` 并挂进 `subCommands`（选项：`--pages`、`--max-pages`、`--max-bytes`）
- [x] 3.7 写 pdf-info 测试：对样本书断言 266 页、`hasTextLayer` 为 `false`、offset 为 `7`、`needsSplit` 为 `true`；对不存在/非法文件断言退出码 `2`

## 4. 拆分方案计算（纯函数，capability: happywork/pdf-split）

- [x] 4.1 实现 `planSplit(meta, options) → 分片方案` 纯函数骨架，不触碰文件系统
- [x] 4.2 实现页数上限切分，保证 `--overlap 0` 时无重不漏、页数之和等于总页数
- [x] 4.3 实现体积上限二分细化；单页即超过 `--max-bytes` 时返回可识别的错误并指出页号
- [x] 4.4 实现 `--align-chapters` 章节对齐：拆分点落在章首，且仍满足页数上限
- [x] 4.5 实现单章超过上限时的退让：章内按页数切分并产出显式警告
- [x] 4.6 实现章节表校验：文件缺失、非法 JSON、起始页越界均返回输入错误
- [x] 4.7 实现 `--overlap` 叠加（在基准区间划分之后），并在方案中标出重叠页
- [x] 4.8 实现印刷页区间换算（源页区间 + offset → 印刷页区间；无 offset 时为 `null`）
- [x] 4.9 写 `planSplit` 的穷尽单元测试（用构造的 meta，不需要真实 PDF）：各上限单独/共同触发、章节对齐、单章超限退让、重叠页、无需拆分、边界值

## 5. 拆分写盘与 manifest（capability: happywork/pdf-split）

- [x] 5.1 实现分片文件名生成：零填充序号 + 源页区间，按名称升序即原书顺序；处理中文书名中的文件系统敏感字符
- [x] 5.2 用 spike 选定的库实现按方案抽页写出分片 PDF
- [x] 5.3 实现 `manifest.json` 写出：源文件指纹、`/PageLabels` 与 offset、本次全部选项、每个分片的文件名/源页区间/印刷页区间/页数/字节数/重叠页
- [x] 5.4 实现 `--dry-run`：只跑 `planSplit` 并渲染方案，确认输出目录零副作用
- [x] 5.5 实现输出目录的 `--force` 覆盖保护（目录非空且未加 `--force` 时以退出码 `2` 拒绝）
- [x] 5.6 用 citty `defineCommand` 实现 `happywork pdf split <文件>` 并挂进 `subCommands`（选项：`--out-dir` 别名 `-o`、`--max-pages`、`--max-bytes`、`--align-chapters`、`--overlap`、`--dry-run`、`--force`）
- [x] 5.7 写集成测试：对样本书实跑拆分，断言分片数、各分片页数与体积均未超限、页数之和为 `266`、manifest 中第二个分片印刷页区间为 `[135, 258]`

## 6. 端到端验收

- [x] 6.1 对样本书执行 `happywork pdf info --pages`，人工核对页数、无文字层、offset = 7 与逐页图像信息
- [x] 6.2 手写一份该书的章节表（章节起始印刷页已在探索阶段读出：1/13/37/65/89/103/125/135/147/159/175/…），执行 `--dry-run --align-chapters`，确认方案为 `[0,141]` 与 `[142,265]` 两片
- [x] 6.3 实跑拆分，逐一打开两个分片确认首末页正确、无缺页、无重页
- [x] 6.4 确认两个分片均满足 MinerU 在线版的 ≤ 200 页且 ≤ 200 MB 限制
- [x] 6.5 运行 `openspec validate --strict` 并修正问题
- [x] 6.6 更新 `happywork/README.md`：去掉 `help --all` 用法、改写为 citty 原生帮助（`--help` drill-down）；保留安装、输出语法说明、两个命令示例（含给 agent 的调用范式）

## 7. 源码分层重构（design 决策 10：commands / core / infra）

- [x] 7.1 `git mv src/pdf src/infra/pdf`（建出 `src/infra/`；`commands/` 与 `core/` 原地不动）
- [x] 7.2 更新 import 路径：`commands/pdf/{info,split}.ts` 的 `../../pdf/` → `../../infra/pdf/`（5 处）；`infra/pdf/{meta,plan}.ts` 的 `../core/` → `../../core/`（2 处，深了一级；内部 `./meta`/`./plan` 不变）；`test/*.ts` 的 `../src/pdf/` → `../src/infra/pdf/`（7 处）
- [x] 7.3 `bun test` 全绿复验，`happywork pdf info/split` 经真实二进制回归

## 8. 补全安装与收尾（explore 追加，源自「happywork p<TAB> 提示不对」的排查）

> 排查结论：补全引擎完全正确（`complete -- p`→`pdf`、`--m`→`--max-pages/--max-bytes` 实测无误），
> 病根是补全脚本从未装进 zsh（`~/.zshrc` 无 happywork 行），zsh 遂回退到文件名补全。见 design 决策 9。

- [x] 8.1 改写 `happywork/README.md` 的补全安装：从 `happywork complete zsh >> ~/.zshrc` 改为写入 fpath 补全目录（`happywork complete zsh > <fpath 补全目录>/_happywork`，本机为 `~/.oh-my-zsh/custom/completions/`；随后 `rm -f ~/.zcompdump*` 并重载 shell），并说明「未安装时 `p<TAB>` 会回退到文件名补全、表现为提示不对」；把该步从「（可选）」改为**必需**；附 bash/fish 等价写法。与 design 决策 9、Migration Plan 措辞保持一致
- [x] 8.2 （可选）修位置参数漏进选项补全：让供 tab 消费的命令树不把 `type:"positional"` 的参数登记为 `--选项`，使 `happywork pdf info --<TAB>` 不再出现 `--input`；补一条补全断言（`--<TAB>` 候选里不含位置参数名）
