## Purpose

把超出下游工具处理上限的 PDF 拆成若干分片，并在拆分的同时保住原书的坐标系——每一个分片页都必须能被追溯回它在原 PDF 中的页序号与书上的印刷页码。

## ADDED Requirements

### Requirement: 按上限拆分

`happywork pdf split <文件>` SHALL 依据 `--max-pages`（默认 `200`）与 `--max-bytes`（默认 `190mb`）两个上限，将输入 PDF 拆为若干分片，使每个分片同时满足两个上限。

#### Scenario: 仅页数超限

- **WHEN** 输入为 266 页、43 MB，上限为 200 页、190 MB
- **THEN** 产出至少 2 个分片，每个分片页数不超过 200、字节数不超过 190 MB

#### Scenario: 无需拆分

- **WHEN** 输入的页数与体积均未超限
- **THEN** 产出单个分片（内容等价于原文件）与对应 `manifest.json`，并在输出中说明未触发拆分

#### Scenario: 分片体积超限

- **WHEN** 按页数上限切出的某个分片字节数超过 `--max-bytes`
- **THEN** 该分片被进一步细分，直到全部分片满足两个上限

#### Scenario: 单页即超过体积上限

- **WHEN** 存在单独一页其字节数已超过 `--max-bytes`
- **THEN** CLI 报错说明无法满足该上限并指出是哪一页，退出码为 `2`

### Requirement: 页序完整且无重不漏

拆分 SHALL 保证在 `--overlap` 为 `0` 时，各分片按顺序拼接恰好覆盖原 PDF 的全部页且互不重复。

#### Scenario: 覆盖完整

- **WHEN** 对 266 页的 PDF 以 `--overlap 0` 拆分
- **THEN** 各分片页数之和为 `266`，且各分片的源页区间首尾相接、无空隙、无重叠

#### Scenario: 页面内容保持不变

- **WHEN** 拆分完成
- **THEN** 每个分片的第 N 页在视觉内容上与其在 `manifest.json` 中所对应的原 PDF 页一致

### Requirement: 产出 manifest

拆分 SHALL 在输出目录中产出一份 `manifest.json`，记录源文件指纹与页码映射，使下游无需再次读取原 PDF 即可还原任意分片页的原始位置。

#### Scenario: manifest 字段完整

- **WHEN** 拆分完成
- **THEN** `manifest.json` 至少包含：源文件的绝对路径、SHA-256、总页数与字节数；`/PageLabels` 解析结果与印刷页 offset；本次拆分所用的全部选项；以及每个分片的文件名、源页区间、印刷页区间、页数与字节数

#### Scenario: 还原印刷页码

- **WHEN** 原 PDF 的印刷页 offset 为 `7`，某分片的源页区间为 `[142, 265]`
- **THEN** 该分片在 `manifest.json` 中的印刷页区间为 `[135, 258]`

#### Scenario: 源文件无页码信息

- **WHEN** 原 PDF 不含 `/PageLabels`
- **THEN** `manifest.json` 中印刷页相关字段为 `null`，其余字段照常写出，且拆分不失败

### Requirement: 章节对齐拆分

拆分 SHALL 支持 `--align-chapters <文件>` 选项，接受一份声明各章起始页的章节表；启用时，拆分点 MUST 落在章的起始页，且各分片仍须满足页数与体积上限。

#### Scenario: 拆分点落在章首

- **WHEN** 章节表声明第 8 章起始于源页 `142`，且以 `--max-pages 200` 对 266 页的 PDF 启用章节对齐
- **THEN** 产出的分片边界落在源页 `142`，即分片一为 `[0, 141]`、分片二为 `[142, 265]`，没有任何一章被切开

#### Scenario: 单章超过上限

- **WHEN** 某一章的页数本身已超过 `--max-pages`
- **THEN** CLI 在该章内部退让为按页数切分，并在输出中明确警告哪一章被切开

#### Scenario: 章节表非法

- **WHEN** `--align-chapters` 指向的文件不存在、不是合法 JSON，或其中的起始页超出原 PDF 页数范围
- **THEN** CLI 报错并以退出码 `2` 结束，不写出任何文件

### Requirement: 重叠页

拆分 SHALL 支持 `--overlap <n>`（默认 `0`），使除首个分片外的每个分片向前多包含 n 页，用于修复跨切口的内容。

#### Scenario: 带重叠拆分

- **WHEN** 以 `--overlap 1` 拆分，且某分片的源页区间起点为 `142`
- **THEN** 该分片实际包含源页 `141` 至其区间终点，且 `manifest.json` 中明确标出哪些页属于重叠部分

### Requirement: 预演模式

拆分 SHALL 支持 `--dry-run`，只计算并输出拆分方案而不写入任何文件。

#### Scenario: 预演不产生副作用

- **WHEN** 用户以 `--dry-run` 执行拆分
- **THEN** stdout 输出与实际拆分一致的分片方案（含各分片源页区间、印刷页区间与预估页数），且输出目录中未新增或修改任何文件，退出码为 `0`

### Requirement: 输出文件命名

分片文件名 SHALL 同时体现顺序与源页区间，使其在文件管理器中按名称排序即为正确顺序。

#### Scenario: 命名可排序且自解释

- **WHEN** 一个 266 页的 PDF 被拆为 2 个分片
- **THEN** 分片文件名包含零填充的序号与其源页区间（例如 `<书名>_01_p0001-0142.pdf`、`<书名>_02_p0143-0266.pdf`），按名称升序排列即为原书顺序
