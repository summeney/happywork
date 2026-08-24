## Purpose

为个人实用命令行工具提供统一的调用骨架与对外契约，使同一份结构化文本输出既能被人在终端里舒适阅读，也能被 agent 稳定解析，无需第二套输出格式。

## ADDED Requirements

### Requirement: 两级命令路由

CLI SHALL 以 `happywork <领域> <动作> [位置参数] [--选项]` 的形式接受调用，领域为名词、动作为动词。

#### Scenario: 正常调用

- **WHEN** 用户执行 `happywork pdf info book.pdf`
- **THEN** CLI 路由到 `pdf` 领域下的 `info` 动作并执行，退出码为 `0`

#### Scenario: 领域不存在

- **WHEN** 用户执行 `happywork foo bar`
- **THEN** CLI 向 stderr 输出错误，列出全部可用领域，退出码为 `1`

#### Scenario: 动作不存在

- **WHEN** 用户执行 `happywork pdf nonexistent`
- **THEN** CLI 向 stderr 输出错误，列出 `pdf` 领域下全部可用动作，退出码为 `1`

### Requirement: 命令目录与帮助

CLI SHALL 由命令定义派生每个命令的帮助，并按 citty 的原生 usage 格式在 stdout 输出，支持逐级 drill-down：`happywork help` / `--help`（列出领域）、`happywork <领域> --help`（列出该领域动作）、`happywork <领域> <动作> --help`（单个动作的摘要、位置参数、全部选项及其类型与默认值）。帮助 MUST 随命令定义自动更新，不得手写第二处。帮助文本不受本规格「结构化文本输出语法」约束（该语法只管命令结果）；帮助的措辞语言不作强制。

#### Scenario: 查看动作帮助

- **WHEN** 用户执行 `happywork pdf split --help`
- **THEN** stdout 给出该动作的摘要、位置参数、全部选项及其类型与默认值，退出码为 `0`

#### Scenario: 顶层与领域帮助（drill-down）

- **WHEN** 用户执行 `happywork`（无参数）或 `happywork pdf --help`
- **THEN** 前者列出全部领域、后者列出 `pdf` 下的全部动作，退出码为 `0`

#### Scenario: 新增命令自动出现在帮助中

- **WHEN** 向命令注册表新增一个动作，且未改动帮助相关的任何代码
- **THEN** 该动作出现在其领域的 `happywork <领域> --help` 输出中

#### Scenario: 声明与实际行为一致

- **WHEN** 帮助输出声明某动作有一个名为 `--max-pages` 的整数选项
- **THEN** 该动作实际接受 `--max-pages <整数>`，且传入非整数时报参数错误、退出码为 `1`

#### Scenario: 短选项别名

- **WHEN** 某动作声明了带别名 `-o` 的 `--out-dir` 选项
- **THEN** 帮助中同时显示 `-o, --out-dir`，且 `-o` 与 `--out-dir` 等效

### Requirement: 结构化文本输出语法

CLI SHALL 对全部命令的**结果输出**使用单一的结构化文本格式，不提供其他输出格式选项（帮助由 citty 原生渲染，不在此列）。该格式 MUST 满足下列全部约定。

#### Scenario: 区块与记录块

- **WHEN** 任一命令输出结果
- **THEN** 标量分组以全大写区块名单独成行开头，其下的条目缩进；集合中的每一项以 `[<名称> <序号>]` 单独成行开头，其下的条目缩进；区块之间以空行分隔

#### Scenario: 键值以行尾为界

- **WHEN** 输出一个键值条目
- **THEN** 其形式为 `<键>: <值>`，值从第一个冒号后的空白之后延伸至行尾

#### Scenario: 值含空格与中文不产生歧义

- **WHEN** 某个值为一个含空格、中文书名号或方括号的文件路径
- **THEN** 该值被完整保留在同一行内且无需转义，按「冒号后至行尾」切分可原样取回

#### Scenario: 数值同时满足机器与人类

- **WHEN** 输出一个字节数、时长或其他带量纲的数值
- **THEN** 先输出原始数值，再在其后的圆括号内给出人类友好形式（例如 `bytes: 43099648  (43.1 MB)`）

#### Scenario: 缺失值

- **WHEN** 某个字段无值
- **THEN** 输出 `-` 作为其值，而非留空、省略该行或输出 `null`

#### Scenario: 一行一个事实

- **WHEN** 任一条目的值很长
- **THEN** CLI 不因终端宽度而折行，该条目始终占据且仅占据一行

### Requirement: 错误输出语法

CLI SHALL 将失败信息按结构化文本语法写入 stderr，首行 MUST 为 `ERROR <机器可读错误码>`，其后为缩进的键值条目且至少包含 `message`。

#### Scenario: 输入文件不存在

- **WHEN** 用户对一个不存在的路径执行任一 `pdf` 动作
- **THEN** stderr 首行为 `ERROR input-not-found`，其后含 `path:` 与 `message:` 条目，stdout 为空，退出码为 `2`

#### Scenario: 错误码稳定可判定

- **WHEN** 同一类失败重复发生
- **THEN** 首行的错误码保持不变，调用方可据此分支处理，无需解析 `message` 的文案

#### Scenario: 解析错误走统一错误格式

- **WHEN** 用户传入一个非法选项，触发框架的参数解析错误
- **THEN** stderr 首行为 `ERROR <错误码>`、走本项目统一错误格式，不直接透传 citty 的原始用法文本；`message` 的语言不作强制

### Requirement: 流分离

CLI SHALL 只向 stdout 写入命令结果，将进度、警告、诊断等一切非结果内容写入 stderr。

#### Scenario: 结果不被日志污染

- **WHEN** 某命令在执行过程中输出了进度与警告
- **THEN** stdout 的全部内容仍严格符合输出语法，不含任何进度或警告文本

#### Scenario: 结果可重定向

- **WHEN** 用户执行 `happywork pdf info book.pdf > out.txt`
- **THEN** `out.txt` 的内容完整且符合输出语法，进度与警告仍显示在终端上

### Requirement: 语义化退出码

CLI SHALL 使用约定的退出码区分失败原因：`0` 成功、`1` 调用方错误（参数非法、命令不存在）、`2` 输入错误（文件不存在、无法读取、格式不受支持）、`3` 内部错误。

#### Scenario: 输入文件不存在

- **WHEN** 用户对一个不存在的路径执行任一 `pdf` 动作
- **THEN** 退出码为 `2`

#### Scenario: 选项值非法

- **WHEN** 用户传入一个类型不匹配的选项值
- **THEN** 退出码为 `1`

### Requirement: 路径以绝对形式输出

CLI SHALL 在所有输出中以绝对路径表示其读取或写入的文件。

#### Scenario: 输出文件路径可直接使用

- **WHEN** 某动作在输出中报告它写入的文件
- **THEN** 该路径为绝对路径，调用方无需知晓 CLI 的工作目录即可访问

### Requirement: 非交互执行

CLI SHALL 在任何情况下都不阻塞等待用户输入；一切可能覆盖已有文件的操作 MUST 默认拒绝并要求显式 `--force`。

#### Scenario: 输出目录已存在且非空

- **WHEN** 某动作的输出目录已存在且含有文件，且未传入 `--force`
- **THEN** CLI 不写入任何文件，报错并提示使用 `--force`，退出码为 `2`

#### Scenario: 显式覆盖

- **WHEN** 同样情形下传入 `--force`
- **THEN** CLI 覆盖同名文件并正常完成

### Requirement: Shell 命令补全

CLI SHALL 提供 shell 自动补全：命令名、选项名与枚举选项值由命令定义派生，文件类参数回落到 shell 原生文件补全。`happywork complete <shell>`（`completion` 为等价别名）MUST 输出可被 source 的补全脚本，至少支持 zsh。

#### Scenario: 补全命令名

- **WHEN** 用户键入 `happywork p` 后按 TAB
- **THEN** shell 将其补全为 `pdf`

#### Scenario: 补全动作名

- **WHEN** 用户键入 `happywork pdf s` 后按 TAB
- **THEN** shell 将其补全为 `split`

#### Scenario: 补全文件路径

- **WHEN** 用户在需要 PDF 文件的位置参数处按 TAB
- **THEN** shell 以原生文件补全列出候选，CLI 不因此阻塞或额外启动进程

#### Scenario: 生成补全脚本

- **WHEN** 用户执行 `happywork complete zsh`
- **THEN** stdout 输出可直接 source 的 zsh 补全脚本，退出码为 `0`

### Requirement: 版本查询

CLI SHALL 通过 `--version`（别名 `-v`）输出 `package.json` 中的版本号。

#### Scenario: 查询版本

- **WHEN** 用户执行 `happywork --version`
- **THEN** stdout 输出当前版本号，退出码为 `0`
