## Purpose

对单个 PDF 做只读侦察，回答「这本书能不能直接抽文字、有多少页、书上的印刷页码和 PDF 页序号差多少、需不需要拆分」，为后续拆分与解析决策提供依据。

## ADDED Requirements

### Requirement: 基础元信息

`happywork pdf info <文件>` SHALL 输出该 PDF 的绝对路径、内容 SHA-256、字节数与总页数。

#### Scenario: 侦察扫描版书籍

- **WHEN** 对一个 266 页、43 MB 的 PDF 执行 `happywork pdf info <文件>`
- **THEN** 输出中 `pages` 为 `266`、`bytes` 为该文件实际字节数，且 `sha256` 为其内容摘要

#### Scenario: 文件不可读

- **WHEN** 目标路径不存在或不是合法 PDF
- **THEN** CLI 报错并以退出码 `2` 结束

### Requirement: 文字层判定

`pdf info` SHALL 判定该 PDF 是否含可提取的文字层，并给出判定依据。

#### Scenario: 纯扫描件

- **WHEN** PDF 每页均为整版位图且不含字体与字符映射
- **THEN** 输出标记 `hasTextLayer` 为 `false`，并给出该判定的依据（如字体数为 0、逐页图像占比）

#### Scenario: 原生数字版

- **WHEN** PDF 含嵌入字体且可提取出文本
- **THEN** 输出标记 `hasTextLayer` 为 `true`

### Requirement: 印刷页码映射

`pdf info` SHALL 解析 PDF 的 `/PageLabels`，输出各编号段的样式与起始位置，并在存在阿拉伯数字段时给出「PDF 页序号 → 印刷页码」的 offset。

#### Scenario: 解析多段页码

- **WHEN** PDF 的 `/PageLabels` 声明第 0 页起为字母样式、第 3 页起为罗马数字、第 8 页起为阿拉伯数字
- **THEN** 输出列出这三段，并给出 `offset` 为 `7`（即 PDF 页序号 8 对应印刷页 1）

#### Scenario: 无页码信息

- **WHEN** PDF 不含 `/PageLabels`
- **THEN** 输出中 `PAGE-LABELS` 区块不含任何 `segment` 条目，`offset` 的值为 `-`，不报错

### Requirement: 逐页图像元信息

`pdf info` SHALL 在启用 `--pages` 选项时输出每页的图像数量、尺寸与压缩方式。

#### Scenario: 查看逐页信息

- **WHEN** 用户执行 `happywork pdf info <文件> --pages`
- **THEN** 输出包含逐页条目，每条含页序号、图像数量、宽高与压缩方式

#### Scenario: 默认不输出逐页信息

- **WHEN** 用户执行 `happywork pdf info <文件>` 且不带 `--pages`
- **THEN** 输出不含逐页条目，仅含汇总信息

### Requirement: 拆分建议

`pdf info` SHALL 根据给定的页数与体积上限，提示该 PDF 是否需要拆分。

#### Scenario: 超过页数上限

- **WHEN** PDF 为 266 页，且上限为 200 页
- **THEN** 输出标记 `needsSplit` 为 `true`，并说明触发的是页数上限

#### Scenario: 未超限

- **WHEN** PDF 为 120 页、20 MB，上限为 200 页、190 MB
- **THEN** 输出标记 `needsSplit` 为 `false`
