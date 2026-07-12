# 顶栏 + 设置页 IA 重构（单栏上下文化 + 混合设置结构）

- **日期**：2026-07-12
- **状态**：spec 定稿待实现
- **原型**：Paper 文件「Pie Frontend」P8 系列 6 板（TopBar 单栏六态 / Settings 根页 / 模型配置二级页 / Drawer 设置入口 / Skills 一级视图），已经用户逐板确认
- **分支**：`WiseriaAI/feature-topbar-setting-refactor`

## 背景与问题

side panel 的导航 chrome 是随功能一批批长出来的，信息架构没跟着演进：

1. **chrome 层叠**：顶栏常驻，切到 Settings 后 Settings 又渲染自己的 header（back + 标题）+ 全宽 SegmentedTabs，等于三条横栏叠放；chat 视图下顶栏下面还有独立的 pinned tabs 横栏。
2. **图标风格老旧**：全部手写 inline SVG，细线、14px 小尺寸、风格不完全统一。
3. **Settings tab 扩展性差**：side panel 高而窄，四等分横向 tab 加一类就要重新分宽度；「通用」tab 已成杂物抽屉（语言/实验/本地打通/反馈/关于 5 个不相关 section 顺排）。
4. **入口语义不一致**：Schedules（功能视图）占顶栏一级入口，Skills（同是功能管理）藏在 Settings 二级；主题切换（低频偏好）却占顶栏一级按钮。

## 设计决策总览（均已拍板）

| # | 决策 |
|---|---|
| 1 | 整体重排导航模型（顶栏 + 视图切换 + Settings 内部一起做） |
| 2 | 入口重分工：顶栏 = 会话导航 + Schedules + Skills；设置入口移进会话抽屉底部；主题切换收进设置页 |
| 3 | 单栏化：顶栏上下文化，随视图变身；所有视图自己的 header 全部删除 |
| 4 | Settings 用「轻内联 + 重下钻」混合结构替代四等分 tab |
| 5 | 图标引入 `lucide-react`，本次只换导航 chrome 范围 |
| 6 | pinned tabs 横栏取消，融进顶栏做副行（左对齐，全行宽） |

## 1. 视图导航模型

视图从扁平 toggle（`agent | schedules | settings`）改为**两层栈**：

```
agent (root)
├── schedules        顶栏 ⏰ 进入
├── skills           顶栏 ⚡ 进入（SkillsList 从 Settings 移出，升为一级视图）
└── settings 根页     会话抽屉底部「设置」行进入
    ├── models       模型配置（= 现 configs tab 全部，含 NewConfigWizard / 官方订阅）
    ├── bridge       本地打通（从「通用」独立成页）
    ├── search       搜索（= 现 search tab）
    ├── experimental 实验性（CDP input；后续实验开关都进这页）
    └── feedback     反馈（表单 + GitHub / 邮件链接）
```

- **view 状态**仍在 `App.tsx`，扩展为带 settings 子页的结构（例如
  `{ type: "agent" | "schedules" | "skills" } | { type: "settings", page: "root" | "models" | "bridge" | "search" | "experimental" | "feedback" }`）。
- **back 语义**：settings 二级页 ← 回根页；settings 根页 / schedules / skills ← 回 chat。**Esc 键对齐同一返回栈**（现有 Esc 语义扩展；chat 视图下 Esc 保持现状——终止二次确认等）。
- **schedules ↔ skills 互切**：两视图下顶栏右侧保留 ⏰/⚡ 按钮（当前视图高亮），可直接互切，不必先退回 chat。
- **抽屉设置入口**：SessionDrawer footer（border-top 分隔）加「设置」行（gear 图标 + 文本 + ›），点击关抽屉并进 settings 根页；StorageIndicator 保留在设置行下方。
- **主题**从顶栏移除，变为设置根页内联三段 segmented（亮/暗/自动），存储 key（IDB config `theme-mode`）与三态循环语义不变。
- **快捷键不变**：Cmd-K 新会话、Cmd-D 抽屉在所有视图可用。
- **Subscribe 深链**（`openSubscribeNonce`）：行为等价迁移——直落 `settings.models` 页并展开 NewConfigWizard（managed 模式）。

## 2. 上下文化顶栏

全局唯一一条横栏（`TopBar.tsx` 单组件收拢现有 5 个 `TopBar*.tsx`），按 view 渲染：

| 视图 | 左侧 | 中间 | 右侧 |
|---|---|---|---|
| chat | ≡（pending 红点）＋ | 会话标题 | ⏰ ⚡ |
| chat + pin | 同上，**顶栏内长出 pin 副行**（见下） | | |
| schedules | ← | 定时任务 | ⏰(高亮) ⚡ |
| skills | ← | 技能 | ⏰ ⚡(高亮) |
| settings 根页 | ← | 设置 | （空） |
| settings 二级页 | ← | 二级页标题 | （空） |

**Pin 副行**（取代现有独立 pin bar，`Chat.tsx` 里的那条横栏删除）：

- 有 pin 时顶栏内追加一行：pin 图标 + origin（mono）+ `×N` 多 pin 计数 badge + ▾；**左对齐**（与 ≡ 同一左缘），全行宽可点，弹现有 `PinnedTabDropdown`（交互零改动）。
- 无 pin 时副行不渲染，顶栏回单行。
- 三态图标映射：自动 pin = pin 描边（fg-2）；锁定 = pin 实心（accent）；用户 ★ pin = star 实心。`pinMode` 语义不变。
- 非 chat 视图不渲染副行。

其他：

- 非 chat 视图下 ≡ 的 pending 红点不可见——接受（回 chat 即见）。
- 删除的组件：`TopBarListButton` / `TopBarNewSessionButton` / `TopBarSchedulesButton` / `TopBarSettingsButton` / `TopBarThemeButton`（主题逻辑迁设置页）。
- 视图切换动画沿用现有 `view-enter`；settings 二级页进出可选加水平 slide（用现有 motion 基建，reduced-motion 兜底）。

## 3. Settings 根页与二级页

**根页**（`settings/SettingsRoot.tsx`）三个分组，iOS 风格 grouped list：

```
┌ 分组 1 · 核心子系统（下钻行 + 状态 badge）
│  box    模型配置    「N 个配置」›
│  plug   本地打通    连接状态点 + 「已连接/未连接/关闭」›
│  search 搜索        当前 provider 名或空 ›
├ 分组 2 · 偏好（标签「偏好」，内联控件行）
│  contrast 主题       [亮|暗|自动] segmented
│  globe    界面语言    当前值 + ▾（复用 LanguageSelect）
│  message  助手回复语言 当前值 + ▾（复用 AssistantLanguageSelect）
├ 分组 3 · 其他（下钻行）
│  flask   实验性功能  ›
│  message 反馈        ›
└ footer · About：Pie logo + 版本 + tagline + 官网/更新日志外链（现 AboutSection 原样搬）
```

**二级页**（`settings/pages/*.tsx`，内容 = 现有 section 组件原样搬，只换壳）：

| 页 | 内容来源 | 备注 |
|---|---|---|
| models | configs tab 全部（InstancesList + InstanceForm + NewConfigWizard + managed 订阅） | 深链落点 |
| bridge | LocalBridgeSection（开关 + 本地 Agent + grants + audit） | 独立成页，audit 可默认展开；daemon roadmap 后续内容都进这页 |
| search | SearchProviderSection | |
| experimental | CdpInputSection | |
| feedback | FeedbackSection | |

`Settings.tsx`（831 行）按页拆文件；现有 section 组件逻辑零改动。`SegmentedTabs` 删除。

## 4. 图标系统

- 引入 **`lucide-react`**（tree-shakeable，仅打包用到的图标）。
- **本次替换范围仅导航 chrome**：顶栏（menu / plus / arrow-left / alarm-clock / zap / pin / star）、设置根页行图标（box / plug / search / contrast / globe / message-square / flask-conical / chevron-right / chevron-down）、抽屉设置行（settings gear）。
- **Chat composer / 消息流内的手写图标本次不动**（后续单独一批）。
- 规格：顶栏图标 17–18px，列表行图标 16px，chevron 14px（›）/ 12px（▾），`strokeWidth={1.75}` 统一。

## 5. 设计规格（Paper P8 板导出 → 代码 token 映射）

原型用暗色 token 硬编码，实现一律回代码 CSS 变量（亮暗自动生效）：

| 原型值 | 代码 token |
|---|---|
| `#0B0D10` 底 | `bg-canvas` |
| `#14171C` 分组卡底 | `bg-surface` |
| `#1A1E25` segmented 槽底 | `bg-field` |
| `#22272F` 边线/行分隔 | `border-line` |
| `#E5E8EC` / `#8A929E` / `#525965` 文字 | `text-fg-1` / `text-fg-2` / `text-fg-3` |
| `#B8C8D6` + `rgba(184,200,214,.10)` 高亮态 | `text-accent` + `bg-accent-tint` + `border-accent-line` |
| `#3E8E63` 连接状态点 | `text-success` 系 |
| `#B89968` pending 点 | `--c-pending` |

关键尺寸（与现有设计系统对齐）：

- 顶栏：padding `8px 10px`、gap 6、高 46（单行）；图标按钮 30×30、圆角取 icon-button 现有档（设计稿 8px，落地对齐 IconButton 既有规格）
- 顶栏标题：Inter 13px；chat 会话标题 weight 500，功能视图标题 weight 600
- pin 副行：padding `2px 4px`、pin 图标 13px、origin JetBrains Mono 11px fg-2、×N badge mono 10px accent 底 accent-tint 圆角 5、▾ 11px
- 根页：内容区 padding `20px 16px`、分组间距 20；分组卡圆角 14（`rounded-card`）、行高 46、行内 padding `0 14px`、行 gap 12、行间 `border-t border-line`
- 根页行：标题 Inter 13px 500 fg-1、badge 12px fg-3、分组标签 JetBrains Mono 10px 500 letter-spacing 0.14em fg-3
- segmented：槽 `bg-field` border-line 圆角 8 padding 2 gap 2；段 padding `3px 10px` 圆角 6 文字 11px；active 段底 `#2A303A`（≈ field 提亮一档，可用现有 hover 色）文字 fg-1 weight 500
- 抽屉 footer：`border-t border-line`；设置行 padding `12px 14px`、gear 17px、文字 13px 500；storage 行 mono 10px fg-3

## 6. 实现影响面

| 位置 | 改动 |
|---|---|
| `App.tsx` | view 状态扩展（settings 子页）、back/Esc 返回栈、TopBar 收拢渲染 —— 中等 |
| `TopBar*.tsx` ×5 | 删除，合并为 `TopBar.tsx`（含 pin 副行） |
| `Chat.tsx` | 删独立 pin bar 横栏；pin 数据（`pinnedTabs`/`pinMode`）从 App 层 session 状态取给 TopBar，dropdown 开合状态归 TopBar 内部 —— 小 |
| `Settings.tsx` | 拆为 `settings/SettingsRoot.tsx` + `settings/pages/*.tsx`；section 组件逻辑零改动 —— 大改但机械 |
| `SkillsList.tsx` | 移到 App 层一级视图；`onRunSkill` 回调上移 —— 小 |
| `SessionDrawer.tsx` | footer 加设置行 —— 小 |
| `SchedulesPanel.tsx` | 删自己的 title 行 —— 小 |
| i18n 字典 ×6 locale | 废弃 `settings.tabs.*`，新增根页行/分组/顶栏标题键；**全 locale 键对齐**（parity 测试强制） |
| 依赖 | 新增 `lucide-react` |
| 测试 | Settings/App/TopBar 相关渲染测试改断言路径；section 组件自身测试不动 |

## 7. 不变量与验收标准

1. 任何视图任何时刻**只有一条顶栏**；Settings/Schedules/Skills 内部无独立 header。
2. chat 无 pin 时顶栏单行；有 pin 时副行出现且点击弹 PinnedTabDropdown，多 pin 显示 ×N。
3. 设置从抽屉进入；schedules/skills 从顶栏进入且可互切；back/Esc 逐层返回。
4. 主题三态切换在设置根页可用，语义与存储 key 不变。
5. Subscribe 深链直落模型配置页并展开 wizard（managed 模式）。
6. Cmd-K / Cmd-D 全视图可用。
7. `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿；i18n parity 测试过。
8. 真机验收：亮/暗双主题过一遍全部视图。

## 8. Non-goals（本次不做）

- Chat composer / 消息流 / HITL 卡片内的图标替换（后续批次）。
- Settings 各 section 的内部逻辑与功能改动（纯搬家）。
- SessionDrawer 的会话列表交互改动（只加 footer）。
- 底部导航 / 多面板等更大的导航形态探索。
