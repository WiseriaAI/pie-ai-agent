# Vailie SidePanel 重制设计（v2.0.0）

日期：2026-07-05
状态：设计定稿待审
范围：pie-ai-agent 客户端 side panel 整体重制（改名 Pie→Vailie + 新设计语言 + IA 重构），随一次发版 v2.0.0 落地。
关联：工作区 GEO/改名设计 `../../../docs/brainstorming/2026-07-04-geo-seo-optimization-design.md`；memory `rebrand-vailie`。本 spec 吸收其中 P0「扩展改名 + UI 品牌串」并扩展为完整重制。

> **实现权威 = 参考代码**。设计意图已落成可跟随的代码，见 `vailie-redesign-reference/`（见文末清单）。实现时以这些文件为准，本文档给的是取舍与结构；两者冲突以代码为准（代码更精确）。Paper 画布「Vailie Remake」的画板是逐屏视觉参照。

---

## 1. 背景与目标

Pie 改名 **Vailie**（vailie.ai 已购），定位收敛为**浏览器助手**（assistant 人设、agent 能力，叙事 "an assistant that acts, not just chats"）。当前 side panel 是工具感偏重的 agent 控制台，黑白调、执行细节平铺。本次重制目标：

1. **换名 + 换脸一次到位**：新名字、新形象、新 IA 随一次发版 v2.0.0 亮相，只过一次商店审核（改名必须随发版，因商店名来自 manifest）。
2. **助手优先**：对话为中心，执行细节默认折叠为一行状态；IP 色团成为「有温度」的助手形象载体。
3. **无界设计语言**：去边框、去分割线；层次靠底色微差 + 间距 + 柔和投影三件套。
4. 保留全部现有能力（Pro 订阅 / BYOK / Schedule / 录制 / 引用 / 权限卡），仅换设计语言与信息架构，不砍功能。

非目标见 §10。

## 2. 已定决策（brainstorm Q&A 记录）

| 决策点 | 结论 |
|---|---|
| 色团 60/30/10 | 指**色团内部**配比（银灰 60 / 蓝 30 / 粉 10），非界面整体 |
| 界面功能色 | 升级为色团同源的**晴空蓝**（accent `#2F8BFF` / strong `#1D6BD6`），非旧中性蓝灰 |
| 色系方向 | **方案二 · 晴空蜜桃 Sky Peach** |
| IP 出现位 | 思考/工作动效态、空状态欢迎屏、设置品牌区、扩展/商店 icon |
| IP 静态形态 | **圆形轮廓**（边缘渐变融到透明、无边框）；**仅动效过程允许有机形变**，动完回归圆 |
| 改动深度 | **全面重构**（含信息架构） |
| IA 目标形态 | **助手优先：对话为中心**（执行细节折叠为状态行） |
| 导航骨架 | **改良版 A**：三段式单屏（宽顶栏 + 全屏对话 + 底部 composer） |
| 顶栏 | 左=IP 色团+字标（→菜单枢纽）；**右侧仅保留裸「＋ 新对话」一个**（高频动作不进枢纽）；主题按钮移出顶栏（→设置 general）|
| Composer | **两态**：未聚焦胶囊 `[＋][文字][发送]` / 聚焦=**现状 composer 原样**（上 textarea + 下 `＋ToolsMenu/ModelPicker/ContextRing/发送` 全功能行），只换皮不改功能排布 |
| 按钮 | 一律**裸图标**（无形状底）+ hover 加亮 |
| 发版 | 开发分阶段、**发版一次 v2.0.0**；提审前 **3–5 天 dogfood 闸**（见 §12）|

### 2.1 Grilling 裁决（2026-07-05 压测定案）

| # | 议题 | 裁决 |
|---|---|---|
| G1 | 导航坍缩深度 | 枢纽只收**低频**目的地（设置/技能/定时/历史）；**新对话保持一键**（顶栏右裸＋）；`Cmd/Ctrl+K`（新会话）与 `Cmd/Ctrl+D`（历史）快捷键**原样保留**；IP 加轻量可点线索（字标同为点击热区 + hover caret）|
| G2 | Composer 功能保全 | 展开态 = 现状排版与功能**一致**（＋ToolsMenu 含附加/拾取元素/录制、ModelPicker、ContextRing、发送/停止/排队）；净新增仅「胶囊态」这层壳 |
| G3 | 色团动效数量 | **只有当前活跃轮**显示动效色团；历史轮一律静态（`animate=false`）；同屏动效实例 ≤2（顶栏 idle + 活跃轮）；`will-change` 仅挂动效态类 |
| G4 | B 屏改深 | **纯换皮**：`AgentStepGroup`/`AgentStepLine`/`AgentSummary` 分组折叠状态机与 SW→panel 协议**不动**，只替换视觉（活跃行指示器→迷你 VailieMark） |
| G5 | 欢迎屏建议 chips | **砍掉**。空状态 = 色团 + 开场语；开场语保留现有 7 条随机池机制，文案重写为 Vailie 助手口吻（「嗨，我在。」入池）|
| G6 | 发版回归闸 | 三绿后**不立即提审**：本地 dist 真机自用 3–5 天过核心 flow 清单；商店 listing 截图同批重做、一次提审 |
| G7 | 商店名 | en `Vailie · AI Assistant for Chrome`（32ch，合规 "for Chrome" 后缀式；**不用 formerly Pie**，过渡说明进商店描述首行）；六语言同公式；Open-Source 让位进描述 |
| G8 | 顶栏右侧与主题 | 右侧唯一按钮=裸＋新对话；**主题→设置 general 的 inline SegmentedTabs**（浅/深/系统），取代旧盲循环按钮 |

## 3. 设计系统

### 3.1 色板（Sky Peach）
权威值见 `vailie-redesign-reference/tokens.css`（明暗两套，沿用现有 `src/sidepanel/index.css` 的 4 块结构：`:root` 亮 + `@media dark` + `[data-theme]` 覆盖 + `@theme` 映射，工具类名 `bg-canvas`/`text-fg-1`/… 不变）。要点：

- **银灰中性阶（60%）**：canvas `#F7F9FB` / surface `#FFFFFF` / field `#F0F3F6` / line `#E4E8EC` / fg-1 `#15191F` / fg-2 `#59636F` / fg-3 `#98A2AE` / fg-4 `#C6CDD5`。
- **晴空蓝 accent（30% 功能色）**：`#2F8BFF` / strong `#1D6BD6` / tint `rgba(47,139,255,.10)` / line `.22`。按钮、链接、选中态、进度、发送。
- **粉（10% 点缀）**：`--c-brand-peach #FF9FB2` **仅装饰、仅存在于色团内**，禁止用于 UI 文字/填充/描边。
- **语义色**：success `#3E8E63`；**warning 改为克制琥珀** `#C9821E`（+ 可读文字 warning-fg `#B0781E`、tint `.08`、line `.22`）——旧的橙色 permission 卡统一降调为琥珀；pending `#B8862E`（周额度 80–95% 警戒段）；danger-fg `#C0574B`（删除/忘记配置类文字）。
- **暗色**：accent 提亮到 `#6FB3FF`；其余见 tokens.css。

### 3.2 排版
- 正文/UI 字体 **Inter**（沿用）。字号级：11(标签/eyebrow) / 12 / 13 / 14(正文) / 15–16(标题) / 18–22(区标题) / 28+(强调数字)。
- **等宽 JetBrains Mono 仅用于「技术值」**：URL、脱敏 key、`/slug` 指令、排期表达式、录制 SEQUENCE 的 url/占位、runId。**模型 id / provider 名 / 普通标签一律用 Inter**（修正：MODELS 列表原用等宽，太机械，改正文字体）。
- 小型标签（分区 eyebrow、pill）用 caps + `letter-spacing:.1em`。

### 3.3 无界层次与圆角/投影
- **零边框、零分割线**。层次三件套：底色微差（canvas/surface/field/surface-deep）+ 间距 + 柔和投影 `0 4px 16px rgba(21,25,31,.05)`（卡片）。列表项之间不画线，用留白与 hover 底色区分。
- 圆角：field 11 / card 16 / pill 999（见 tokens `--radius-*`）。
- 弹层用更强投影 `0 8px 28px rgba(21,25,31,.14)`。

## 4. 品牌 IP · VailieMark

权威实现 `vailie-redesign-reference/VailieMark.tsx` + `vailie-mark.css`。

- **形态**：多层 `radial-gradient` 叠合的色团，边缘衰减到 alpha 0——无 border / 无 shadow / 无 clip，形状由颜色定义。银灰主体、蓝自下涌起、粉在右上一缕。
- **静态恒为圆**；`size` prop 缩放（顶栏 ~30、空状态 ~132、图标 16）。16px 小尺寸用收紧的衰减半径（`recording` 配方即紧衰减范式）。
- **四态 + 录制变体**（mesh + 动效，均纯 CSS，`prefers-reduced-motion` 下停）：
  - `idle` 8s 缓慢呼吸；`thinking` 2.4s 粉缕内旋脉动；`working` 1.6s 收紧蓝增定向涌动；`done` 一次绽放(scale 1.08)回落后切回 idle；`recording` 粉前致密、1.4s 柔脉动。
- **出现位**：思考/工作态（对话流内 22–26px）、空状态欢迎屏、设置品牌区、扩展/商店 icon、**录制标识**（见 §6 录制——由 magenta 脉冲点改为 `recording` 变体色团，整页从洋红收敛回品牌蓝）。
- **动效预算（G3）**：同屏动效色团 ≤2——顶栏 idle 呼吸 + 当前活跃轮 thinking/working。历史轮/已完成清单一律静态（`VailieMark animate={false}`）；`will-change` 只随动效态类挂载，不进基类。
- 扩展图标需按新 IP 重做（`public/icons/icon-*.png` + 商店 listing 图），P0 品牌资产的一部分。16px 下渐变团的可辨识度在 dogfood 期验证，必要时 icon 采用加密度/提对比的专用配方（`recording` 紧衰减范式）。

## 5. 无界交互规则与核心组件

权威实现 `vailie-redesign-reference/ui-primitives.tsx`、`Composer.tsx`。

- **IconButton**：静默裸图标 → hover 亮 field 底 + 图标转深；`active` 用 accent-tint 表选中/打开；**focus-visible 恒有 ring**（`ring-accent-line`）——hover 不是唯一可达性提示。
- **Card / SegmentedTabs / StatusPill / QuotaBar**：见 primitives。SegmentedTabs 标签**文字居中**（修正）。
- **Composer 两态**（`Composer.tsx`，G2）：
  - 未聚焦 **胶囊**：高 52、radius 26；`[＋][文字][发送]` 三件，按钮中心落在两端圆心（26px 处）。ModelPicker/ContextRing 不在胶囊态出现。
  - 聚焦 **上下两段全宽**：radius 18；上段 textarea 多行增长；**下段 = 现状 composer 动作行原样**：`[＋ ToolsMenu(附加/拾取元素/录制)] ···spacer··· [ModelPicker chip] [ContextRing] [发送/停止(+排队滑入)]`。功能与排布不改，仅重贴无界皮。
  - 胶囊↔展开 150ms ease-out。聚焦反馈 = 底色微亮 + 柔和蓝晕投影（替代 focus ring，键盘 focus 同样式）。运行时发送图标变停止方块；`/` 斜杠技能补全 popover 行为不变。
- 开关(Switch)/单选(SelectRing) 保持自定义控件（非原生），沿用现有 role=switch 模式。

## 6. 信息架构与界面清单

**骨架**：宽顶栏（左=IP 色团+Vailie 字标→菜单枢纽，字标同为点击热区、hover 现 caret；右=裸「＋ 新对话」，G1/G8）+ 全屏对话 + 底部 Composer。菜单枢纽是 push 子页栈，**只收低频目的地**：会话历史 / 技能 / 定时任务 / 设置。列表型配置（语言、数据）走 push 子页；枚举开关（主题）inline segmented（落点=设置 general，G8）；流程卡片（CDP/文件权限/Schedule 创建/会话恢复漂移/引用 chip）内联对话流。

**快捷键保留（G1）**：`Cmd/Ctrl+K` 新会话、`Cmd/Ctrl+D` 会话历史（新 IA 下打开枢纽的历史子页）、Esc 返回对话——现有 App.tsx 键位原样迁移。

**pending 确认标识迁移**：现 ≡ 按钮红点（`pendingConfirm`，活跃生产者=恢复漂移卡 `pinned-tab-drift`）→ 新 IA：IP 右上角小状态点（pendingCount>0 时）+ 枢纽「会话历史」行计数 + 会话行点。

**核心屏（Paper 画板 A–I）**：
- **A 欢迎/空状态**：色团 + 开场语 + 胶囊 composer。**无建议 chips（G5 砍）**；开场语沿用现有 7 条随机池机制，文案重写为 Vailie 口吻（「嗨，我在。」入池），i18n 走现有字典。
- **B 任务进行中**：用户气泡右对齐；助手自然语言开场 + 一行执行状态（迷你色团 thinking 态 + "正在读取… 3/6"）+ 已完成步骤浅色清单。**实现=纯换皮（G4）**：`AgentStepGroup/AgentStepLine/AgentSummary` 的分组折叠状态机、step 消息协议、pending/ok/error 流转全部不动，仅替换活跃行指示器与配色。
- **C 菜单枢纽**：无边框列表（历史/技能/定时/设置）+ 底部品牌区 "Vailie · v2.0.0 · 开源 Apache-2.0 · 无遥测"（不写 formerly Pie，G7）。
- **D 会话历史**：今天/昨天分组、hover 浮现 ··· 归档/删除、顶部搜索。
- **E 技能**：录制新技能入口 + 技能行（名称 + `/slug` + 描述 + 开关）。
- **F 定时任务**：任务行迷你色团状态标识 + 排期表达 + 开关/暂停。
- **G 设置**：分区 configs/skills/search/general（见 §7.7）。
- **H 任务完成**：完成态色团 + 折叠状态行 + **文件产出卡**（FileOutputCard）+ 次级操作。
- **I 首次上手**：大色团 +「我是 Vailie」+ 双卡（订阅 / 自带 Key）+ 信任行。

## 7. 存量功能忠实还原（字段/文案/状态以真实代码为准）

以下为重制时必须覆盖的状态清单，Paper 画板 J–O 是视觉参照，文案已按现有 i18n 语义还原为简体中文（英文原值见 `src/lib/i18n/dictionaries/en.ts`）。

### 7.1 Pie Pro 订阅（画板 J）
组件：`ManagedSubscribePanel` / `ManagedAccountPanel` / `ManagedErrorCta` / `ManagedStatusPill` / `ManagedPlanIcon` / `RedeemCodeForm` / `QuotaBar` / `ModelPicker`。状态：
- 未登录 sign-in 卡（Pie Official + 三 benefit + Google 登录）
- 已登录未订阅：**月/年双价 radio 卡**（首月半价徽标 `introOffer`、年付 save% 徽标、pricing 下发）+ 兑换码入口；无 pricing 时降为单「订阅」按钮；polling 等待态 + "我已支付—刷新"。
- 活跃卡：planName + 计费周期胶囊 + 续费/取消日 + **QuotaBar** + 管理订阅(portal)/刷新。
- 兑换码激活卡：`redeemedUntil`、隐藏管理按钮、可再叠加兑换。
- Blocked 欠费卡：更新支付方式(portal)。
- 运行时错误 CTA（插对话流）：dunning(warning) / session 过期(纯文字) / 周额度耗尽(neutral 无按钮) / 未订阅拦截(neutral+订阅)。
- `ManagedPlanIcon` 全彩付费徽标、`ManagedStatusPill` 三 tone。

### 7.2 BYOK 配置（画板 K）
- NewConfigWizard 方式切换 tab（自带 Key / 官方订阅，**标签居中**）+ ProviderDropdown（12 内置 + 自定义，见 registry 清单）。
- InstancesList 行：provider 徽标 + displayName + endpoint variant 胶囊 + 脱敏 key；手风琴内联展开编辑。
- InstanceForm 字段：ENDPOINT 分段（5 家有 Plan+Pay-as-you-go 变体，标签居中）/ API KEY(AES-GCM·LOCAL、脱敏替换态)/ MODELS(ProviderModelList，**model id 用 Inter 非等宽**) / Test + Save(wizard 里为 Create) / 忘记配置(danger)。
- CustomProviderFields：NAME(字数/40) + BASE URL + 两条安全提示（琥珀）+ 删除(引用时禁用)。
- ModelPicker：managed 模型行（name + description + vision 标签 + 消耗点 ●●○ costLevel）+ BYOK 手风琴 + "管理 providers/模型"。

### 7.3 Schedule（画板 L）
- 对话内 `ScheduleDraftCard`：LLM 推断排期，用户只补选模型（form/created 两 phase）。
- 管理页 `SchedulesPanel`：New→创建方式选择菜单（填表单 / 对话描述）；空态；`ScheduleCard`（状态徽章 Active/Paused/Completed/Disabled + 开关 + 排期摘要 + 下次运行 + 立即运行/编辑/运行记录/删除两段确认）。
- `ScheduleForm`：Title / Prompt / Model / [Start at · Interval(min)≥1 · Runs∞] / Start URL / 高级折叠(每次运行上限)。cadence = 分钟间隔 + 可选首次 + 可选总次数，**无时区选择**（设备本地）。
- `ScheduleRunHistory`：`#序号` + 状态(Running/Success/Failed/Interrupted/Skipped) + 时间 + 摘要/错误 + 未读点；有 sessionId 可点开会话。

### 7.4 录制（画板 M / M2）
- `RecordingMode` 全屏：Vital Bar（**IP recording 变体色团**做标识 + 步数计数 + RECORDING 标签，整页品牌蓝，非 magenta）/ SEQUENCE 实时步骤（序号 + 类型 chip CLICK/TYPE/NAV… + 值，REDACTED/UNSTABLE 标记）/ Footer Bar（Cancel/Finish + esc/⏎ 提示）。
- 中止态（RECORDING ABORTED + reason）。
- 完成 → 待发送 chip（📼 + 步数 + "写 prompt 后发送生成技能" + ×）。
- **关键约束**：录制后**无独立命名/保存表单、无 `/slug` 输入**；轨迹交 LLM，自动 `create_skill`（name/description/instructions 由 LLM 生成，skill id 系统生成）。
- **已定实现事实（代码判定，2026-07-05）**：`create_skill` 工具零 confirm 引用、全 src 无 `"agent-tool"` confirm 生产者、`no-confirm-*` 跨层测试主动断言该路径不得复活 → **无审阅卡，直接落库 + 回 "skill created"**。附带修复项：`src/lib/skills/builtin.ts:165-166` 的 skill 指令仍称"用户会看到 confirm 卡"，是死文案（会让 LLM 对用户描述不存在的界面），v2.0.0 一并删除。

### 7.5 引用与附件（画板 N）
- Composer 上方三类可同存：文本/元素引用 `QuoteChip`（文本 chip / 元素 chip 带截图缩略图 + role·name + hostname + ×）、图片缩略图（64×64 ×3 上限 + ×）、文件 `FileChip`（图标 by MIME + 文件名 + 可选"已截断" + ×）。文件 chip **无大小字段**（`FileAttachment` 无 size）。
- 页内捕获（content script）：文本选区浮动圆按钮（pie logo，label "添加为引用" 硬编码非 i18n）；元素拾取绿色高亮框 + role 标签。

### 7.6 流程卡片（画板 O，均**琥珀 attention** 不再橙）
- `CdpOnboardingCard`：开启浏览器输入模拟(CDP) + 黄条说明 + 开启/暂不。**CDP consent 卡保留**（一次性能力授权，非已移除的 tool confirm 层）。
- `FileAccessCard`：允许访问文件网址（文案硬编码非 i18n，自动消失）。
- `LocalFileRequestCard`：选择文件… + 取消(倒计时)。
- `SessionConfirmCard`（grilling 补漏）：恢复会话时固定标签页漂移的确认卡（kind `pinned-tab-drift`，生产者 `background/index.ts` resume 流程）——重贴皮时同批覆盖，驱动 ≡ pending 点的就是它（迁移见 §6）。
- `FileOutputCard`（H 屏内）：图标 + 文件名(去扩展名) + `类型·大小` + 下载；idle/busy/expired 三态。

### 7.7 设置交互形态（item 5 答复）
- 顶部 4 段 SegmentedTabs（configs/skills/search/general）切分区，非子页。
- 新建 config = inline Collapse；config 编辑 = 手风琴内联展开；删除 = 原生 confirm。
- **界面语言/助手语言 = 自定义下拉 popover**（按钮 + 浮层 listbox + 勾选），非原生 select、非子页、非 inline 展开。
- CDP = 自定义 Switch + 展开琥珀警告块；反馈 = textarea + 含日志勾选 + 发送；关于 = 图标 + 版本 + 官网/changelog。
- **主题（G8 改址）**：旧=顶栏盲循环按钮 → 新=**设置 general 内 inline SegmentedTabs（浅色/深色/跟随系统）**，顶栏不再有主题钮。**无「数据管理」独立分区**（重制可新增，但非既有）。

## 8. 改名相关（并入本次）
- manifest `name`/`_locales` 六语言按 **G7 公式**改：en = `Vailie · AI Assistant for Chrome`（32ch；CWS 商店名 45ch 硬上限，现 en 串已顶满 45ch 故必须重组；"for Chrome" 后缀式是 Google 商标规则唯一允许的 Chrome 用法）。**不用 "(formerly Pie)"**——过渡识别放商店描述首行一句 + 更新说明；`Open-Source` 让位进描述（CJK 语言标题若空间够可保「开源」）。`action.default_title` "Open Vailie"；version 本次直接 **2.0.0**（名字+形象+IA 一次亮相）；package.json 同步。
- src 全量大写 `Pie`→`Vailie`（含测试断言）；`subscribe-bridge` ALLOWED_HOSTS 加 `vailie.ai`（保留 `pie.chat` 过渡）；Settings 官网链接 → vailie.ai。
- **后端域名 `account.pie.chat`/`api.pie.chat` 不动**（`managed-config.ts` + manifest host_permissions），`feedback@pie.chat` 暂留。
- repo 改名、GitHub/域名/GSC/商店 = 工作区 GEO 计划 P0/C 阶段，见关联文档。

## 9. 相对旧设计的收紧（3 处）
1. warning 由橙 → 克制琥珀（贴合无界）。
2. 录制由 magenta 专用模式色 → 品牌蓝 + IP recording 变体色团做识别。
3. 安全叙事**不再宣称 confirm-before-act**（tool confirm 层已移除）；仅 CDP 一次性授权保留确认。

## 10. 非目标 / 开放点
- 不砍任何现有功能；不改后端契约与域名。
- 不在本次引入新导航范式之外的功能（如多面板）；不做建议 chips 的页面感知/个性化。
- ~~新对话入口深度~~ → 已定（G1：顶栏常驻裸＋）。~~录制审阅卡去留~~ → 已定（§7.4 代码判定：无卡）。
- 「数据管理」设置分区：可选新增，非既有还原项。
- 「助手自然语言开场」的口吻属 agent prompt 调优，不进本 spec；需要时另开小 issue。

## 11. 参考代码清单（实现权威，位于 `vailie-redesign-reference/`）
| 文件 | 内容 | 落地去向 |
|---|---|---|
| `tokens.css` | Sky Peach 全套 token（明暗 + @theme 映射） | 替换 `src/sidepanel/index.css` token 层 |
| `VailieMark.tsx` + `vailie-mark.css` | 品牌 IP 色团组件 + 四态/录制变体动效 | 新增 `src/sidepanel/components/VailieMark.*` |
| `ui-primitives.tsx` | IconButton / Card / SegmentedTabs / StatusPill / QuotaBar（无界规则） | 拆分到各组件文件 |
| `Composer.tsx` | 两态 composer 骨架（几何 + 过渡 + a11y） | 重制 `Composer` |
> 屏级组合（A–O）由上述原语 + §7 字段清单组装；不逐屏出代码——组合是模板 + 已还原文案，实现时按 Paper 画板与本 §6/§7 落。

## 12. 分阶段（开发分期、发版一次 v2.0.0）
1. **地基**：tokens.css 落地 + VailieMark + 无界原语 + Composer 胶囊态壳（展开态复用现结构换皮）。
2. **IA 重构**：宽顶栏（IP 入口 + 右侧＋）/菜单枢纽子页栈 + 三段骨架 + 快捷键迁移 + pending 点迁移。**B 屏=纯换皮**（G4，step 状态机/协议不动）。
3. **存量功能重贴皮**：§7 各组件按新语言 + 迷你色团状态（遵守 G3 动效预算）+ 琥珀 attention + 录制 IP 化 + `SessionConfirmCard` + 删 `builtin.ts` confirm 死文案。
4. **改名收尾**：manifest/_locales 六语言 G7 名字串 + src 品牌串 + subscribe-bridge 域名 + icon 重做 + 商店描述（首行过渡句 + Open-Source 卖点）。
5. `pnpm test`/`typecheck`/`build` 三绿 → **dogfood 闸（G6）**：本地 dist 真机自用 3–5 天过核心 flow 清单（BYOK 配置/Pro 登录订阅/真实 agent 任务/Schedule 建+跑/录制生成技能/引用三类/暗色/抽 2 门语言查溢出），期间重做 listing 截图 → 一次提审发 v2.0.0。
