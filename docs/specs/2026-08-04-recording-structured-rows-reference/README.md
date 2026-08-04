# Recording 结构化步骤行 · 原型代码参考（issue #342）

录制界面步骤行从「采集时烤死的中文句子 label」改为**结构化字段 + 渲染时本地化**，
展示形态 **【action】content**。本目录是设计定稿的原型代码，供实现直接参照/搬运；
实现要求与验收标准以 issue #342 body 为准。

设计原型：Paper 文件「Pie Frontend」
`P9 — Recording · 结构化行【action】content · zh (Dark)` / `· en (Dark)` 两板
（同一行结构双语言零布局差异，验证语法中立）。

## 文件

- `RecordingSequenceRows.tsx` — 步骤行参考实现（SequenceRow / TargetContent /
  MetaChip / AwaitingRow），含 `RecordedTarget` 类型定义。照
  `src/sidepanel/components/RecordingMode.tsx` 现有 inline-style 惯例书写，
  可直接对照替换其中的 `SequenceRow` / `SequenceLabel`。
- `i18n-keys.reference.ts` — 新增词条（`recording.kind.*` / `recording.region.*` /
  `recording.checkedOn|checkedOff`）六语言参考值。落库时按各字典 parity
  规则展开；非中英翻译以母语审校为准。

## 视觉规格 ↔ token 对照

Paper 板上的 hex 全部对应 `sidepanel/index.css` 的 dark 档 `--c-*` token，
代码中一律写 token 不写 hex：

| hex (dark) | token |
|---|---|
| `#0B0D10` | `--c-canvas` |
| `#14171C` | `--c-surface` |
| `#22272F` | `--c-line` |
| `#E5E8EC` | `--c-fg-1` |
| `#8A929E` | `--c-fg-2` |
| `#525965` | `--c-fg-3` |
| `#B8C8D6` | `--c-accent` |
| `#C26B5E` | `--c-warning` |
| `#B89968` | `--c-pending` |
| `#5FA37D` | `--c-success` |

行内容规格：kind 词 Inter 12px `--c-fg-2`（flexShrink 0）；name Inter 13px/18px
`--c-fg-1`（overflowWrap anywhere，不截断）；nth 兜底 `#N` mono 12px `--c-fg-1` +
`· region` Inter 12px `--c-fg-3`；checked mono 12px（勾 `--c-success` /
取消 `--c-fg-3`）；scroll `↓/↑ ≈ Npx` mono 12px `--c-fg-2`；value / `→` /
navigate / meta chips / action chip / 序号列保持现状。
