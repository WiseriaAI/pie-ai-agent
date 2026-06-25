# 跨标签页录制回放 — 设计 spec

- 日期：2026-06-26
- 状态：设计定稿（经 grill 收敛，待实施 plan）
- 关联：Recording v1（`src/lib/recording/`、`src/background/recording-orchestrator.ts`）；多标签页基建（`pinnedTabs[]` / `currentFocusTabId` / `tabs.ts`）

## 1. 背景与问题

当前录制功能（"录制 → 蒸馏成可复用 Skill"链路）**绑死单个标签页**：

- `RecordingSession.tabId: number` 单值（`src/lib/recording/types.ts:65`，注释明写 cross-tab "deferred 到 v1.1"）。
- capture 只注入到绑定的那个 tab；用户点击链接/按钮**打开新标签页后，新标签页没有监听器 → 操作全部丢失**。
- 录制 tab 一关就 abort（`src/background/index.ts:1768`）。

**结果是死局**：任何"点击 → 开新标签页 → 在新标签页继续"的流程（支付弹窗、OAuth 授权、`target=_blank` 链接对比）录到一半就断，无法完成。

### 关键前提（决定整个设计）

**这个产品没有"回放引擎"。** 真实链路：

```
录制 DOM 操作
  → serialize() 翻译成中文分步 trace（src/lib/recording/serialize.ts）
  → 广播 recording-finished {serializedTrace, stepCount}（仅这两字段；allowedTools/parameters 被丢弃）
  → panel 把 trace 喂给 create_skill_from_recording skill（src/sidepanel/components/Chat.tsx:861-882）
  → LLM 蒸馏成通用自然语言 Skill（name/description/instructions）→ create_skill 存下
```

"回放" = 以后用户调用这个 Skill，**普通 agent loop** 照自然语言指令重做。无逐事件重放、无 allowedTools 运行期强制、无"回放模式"任务。

因此本需求拆成两件**独立**的事：
- **A（录制采集跨标签页）**：点击开新标签页后继续采集，trace 不再断。← 直接对应死局。
- **B（蒸馏出的 Skill 运行期跨标签页可执行）**：agent 运行时能接管/操作点击 spawn 出来的子标签页。这是普通 agent loop 早已存在的限制（没有 onCreated auto-pin）。

本期交付 A+B。

## 2. 范围

### In scope
- 录制时跟随"点击/JS spawn 出来的新标签页"（含新窗口 popup）继续采集。
- 录制时在"流程自己开出来的标签页之间"切换（含切回起始页）继续采集。
- 蒸馏出的 Skill 运行期能接管 spawn 出来的子标签页、并在已拥有的标签页间切换。

### Out of scope（明确不做）
- **切换到流程外的、预先各自打开的标签页**（邮箱、文档、音乐等）。运行期无法复现，视为噪声，不录、不注 capture。
- 逐事件确定性回放引擎（与现有架构相悖）。
- 显式"关闭标签页"作为一条回放步骤。

### 已知 ceiling（标 ponytail，本期不解决）
- 同源多流程标签页配对歧义（用 ordinal 兜底）。
- junk 标签页与目标标签页同 origin 时的精确区分。
- 精确 popup 窗口配对（按窗口类型/尺寸）。

## 3. 核心概念：流程标签页集合

**流程标签页集合 = 起始标签页 ∪ opener 链 spawn 出来的标签页。**

- **spawn**：新标签页 `openerTabId ∈ 集合` → 收编（含跨窗口，不按 currentWindow 过滤）。
- **switch**：焦点在**集合内成员之间**移动（含切回起始页）→ 记一条 switch 转换。
- 焦点切到**集合外**标签页 → 忽略。

每个 switch 的目标都是本次流程开过的标签页 → 运行期必然在 `pinnedTabs` 里，B 才有东西可 focus。**依赖顺序：switch 依赖 spawn 先把目标标签页纳入。**

## 4. 数据模型

### 4.1 `RecordedAction` 增加 `tabRef`
- `tabRef: number` —— 纯内部 key，录制时按标签页在流程集合中出现顺序分配（0 = 起始页）。
- 运行期**不靠 tabRef**（跨运行期会漂：spawn 顺序变、某次 spawn 失败即错位）。

### 4.2 `RecordingSession` 改造
- `tabId: number` → 流程集合（`Set<number>` 或 `tabId → tabRef` 映射）。
- 新增 `tabRegistry: Record<tabRef, { origin: string; firstUrl: string }>`，标签页加入集合时写入。
  - `origin` = 运行期匹配 hint；`firstUrl` = 仅可读 hint。
  - 用途：作为"本流程用到哪些标签页"的清单，喂给蒸馏 LLM。
- **不变量保持**：`RecordingSession` 仍**绝不**写入 `chrome.storage`（Unit 8 build-time grep gate），新字段同样只活在 SW 内存。

### 4.3 转换 origin 的精确来源
serialize 渲染某条转换的目标 origin 时，**用目标标签页里紧跟的那条 action 自带的 `url`**（每条 `RecordedAction` 都有 `url`），比 `tabRegistry` 的 join-origin 更准（避免页内跨域漂移）。`tabRegistry` 退化为"标签页清单"角色，不参与逐步精确匹配。

## 5. A — 录制采集侧

### 5.1 capture 注入时机
- **`chrome.tabs.onCreated`（opener ∈ 流程集合）** → 仅登记入集合、分配 tabRef、写 tabRegistry，标记待注入。**不在 onCreated 注 capture**（新标签页常是 about:blank，随后真实导航会冲掉监听器）。
- **`chrome.webNavigation.onCommitted`** → 现有逻辑从"只认录制 tab"扩成"认流程集合内任一 tab"：新标签页首次 commit 时注 capture；同标签页内导航也继续重注。同一段逻辑两用。
- **不引入 `onActivated`**："switch 转换"由 action 流里 `sender.tab.id` 的变化推出来；用户只看不操作的切换对回放无意义。
- 跨 origin spawn（OAuth 弹窗）→ `<all_urls>` host_permission 下 executeScript 能注；`chrome://`/扩展页注不了 → 跟现有 restricted 处理一样跳过。
- 后台 spawn（`target=_blank`/中键开在后台）→ onCommitted 后照样装监听器，用户之后切过去交互时事件正常触发（Chrome 只节流后台定时器，不拦交互事件）。

### 5.2 action 归属
- 收到 `recording-action` 时，`sender.tab.id` → 流程集合查 tabRef，标记到该 action。
- `sender.tab.id ∉ 集合` 的 action → 防御性丢弃（理论上不会发生，capture 只注入集合内标签页）。

### 5.3 生命周期 / abort
- **`chrome.tabs.onRemoved`**：把关掉的 tab 从流程集合移除；**仅当集合变空才 abort**（reason `tab-closed`）。
- 关任意单个标签页（含起始页，只要还有别的流程标签页在）→ 只移除、继续录。
- 不把"关标签页"录成步骤；用户关掉/弹窗自关后，下一条 action 来自另一标签页 → serialize 自然推出一条 switch 转换延续意图。
- origin 锚点（`RecordingSession.origin`）惰性：仅 start 时算一次、随 `recording-started` 回 panel 当展示用，之后无任何录制逻辑读它 → 起始页关闭不需保留/转移。
- 其余 abort 原因（`sw-restart`/`panel-disconnect`/`session-switched`/`csp-blocked`）不变。
- 被 opener-chain 误收的 junk 标签页（页面弹的广告页）即使注了 capture，只要用户不操作就无 action 产生 → trace 里完全不出现，无害。

## 6. serialize + 蒸馏

### 6.1 `serialize(actions, tabRegistry)`
- 新签名加 `tabRegistry`。
- 遍历时维护"上一条的 tabRef"：idx>0 且 tabRef 变化 → 吐转换步骤；**类型按首次出现判**（该 tabRef 第一次见 = spawn，见过 = switch；切回起始页正确判为 switch）。
- 文案风格（origin 作括号 hint、**不**用占位符 token，符合蒸馏 skill 的"通用"约束）：
  - spawn：`第 N 步：上一步的点击会打开一个新标签页，切换到它继续（目标站点：pay.stripe.com）。`
  - switch：`第 N 步：切回 amazon.com 的标签页继续。`
- 新增 origin 字段同样走 `escapeUntrustedWrappers`。

### 6.2 `create_skill_from_recording`（`src/lib/skills/builtin.ts:144-175`）补多标签页说明
- trace 可能含跨标签页步骤（切到新打开的标签页 / 切回某站点的标签页），**保留**为工作流步骤，别拍平成单页流程。
- 运行期 agent 用 `switch_to_new_tab` / `list_tabs`+`focus_tab` 落地；蒸馏只需把意图写成自然语言（如"在打开的支付标签页里完成付款，然后回到订单页"）。
- origin 作可读 hint 保留，但措辞保持通用（说"支付标签页"比硬写域名更可复用）。
- 切回别的**窗口**里的老标签页时需 `list_tabs({allWindows})`（list_tabs 默认仅 currentWindow）。

## 7. B — 运行侧（无任何常驻监听）

回放 = 蒸馏 Skill 被普通 agent 任务执行，全套工具可用。两条路径在 agent 工具层收敛，"类型分支"落在"目标标签页怎么进 pinnedTabs"。

### 7.1 spawn → 新工具 `switch_to_new_tab(origin?)`
- **read-class**（无页面 mutation，类比 `focus_tab`，不需 confirm）。
- 候选集 = `chrome.tabs.query({})`（不限窗口）中 `openerTabId ∈ 本 session 拥有集合` 且 `tabId ∉ pinnedTabs` 的标签页（= spawn 出来还没收的）。
- 多候选策略：
  1. 配对前短暂等候选 URL settle（复用 `interpretPinnedTabUrl` / `waitForUrlSettle`），避开 about:blank。
  2. **origin 优先配对**：候选里 origin 匹配 `origin` 参数（LLM 从步骤 hint 读出传入）的优先 → 区分"目标支付页 vs 同时弹的广告页"。
  3. 同 origin 多个 / 没传 origin → 取最新（tabId 最大）兜底。
- 命中 → `appendPinnedTab` + `setCurrentFocusTabId`（ctx 里这俩能力现成，`loop.ts:2240` / focus_tab）。
- **零候选** → 返回 observation "未检测到新标签页"，让 LLM 在当前页继续或调 fail，**不报错中断**。
- 返回时报告选了哪个 + 其它候选的 domain，供 LLM 发现选错时用 `list_tabs`+`focus_tab` 纠正。

### 7.2 switch 回老标签页 → 复用现成工具
- `list_tabs`（返回 domain）+ `focus_tab`。目标已在 pinnedTabs（起始页或更早 spawn 收编的）。

### 7.3 收编对正在跑的 loop 可见
- loop 每轮 `readFocusFromStorage`（`loop.ts:1446`）→ `getSessionMeta` 拿新鲜 pin 列表喂 `ctx.pinnedTabs`（"Live pin list — read fresh"，`:932`）。`switch_to_new_tab` 写进 session meta 后，下一轮即可见、`focus_tab` 命中。`open_url` 的 mid-task 追加就是这么生效的。

### 7.4 为何不用全局 onCreated 自动收编（撤掉的方案）
- 会污染 `pinnedTabs` UI（广告页被自动 pin，用户可见）。
- 需判跨 session 归属 + gate 到"有正在跑 loop"的 session，否则误触发 R7 跨 session 锁。
- 全局 setSessionMeta 与 loop 自身写并发 → read-modify-write 竞态。
- 按需工具把收编限在"skill 明确切标签页"时 + 调用方 session 内 + loop 执行序列里 → 无上述问题。

## 8. 单元边界（便于隔离实现与测试）

| 单元 | 职责 | 依赖 |
|---|---|---|
| `recording-orchestrator`（改） | 流程集合 + tabRef/tabRegistry 维护、onCreated 登记、onCommitted 注入扩集合、onRemoved 空集合才 abort | chrome.tabs / webNavigation / scripting |
| `serialize`（改签名） | actions+tabRegistry → trace，按首次出现吐 spawn/switch 步骤 | RecordedAction |
| `create_skill_from_recording`（改文案） | 蒸馏时保留跨标签页步骤 + 指明运行期工具 | — |
| `switch_to_new_tab`（新工具） | 候选筛选 + origin 配对 + 收编+focus + 报告 | chrome.tabs / ctx.appendPinnedTab / ctx.setCurrentFocusTabId |

## 9. 测试要点（最小）
- `serialize` 首次出现逻辑：spawn/switch/切回起始页判定，相邻同 tabRef 不吐转换。
- `switch_to_new_tab` 候选选择：origin 命中优先、同源取 newest、零候选返回观测不报错。
- 录制 onRemoved：单页关闭只移除、集合空才 abort。

## 10. 不做的事（YAGNI 复述）
- 不引入 onActivated、不引入运行期全局 onCreated 监听。
- 不新增 RecordedActionType（用 tabRef 字段 + 首次出现推断）。
- 不把 origin 硬编进蒸馏 Skill（保持通用、origin 仅 hint）。
- 不为同源多标签页/junk 同源做精确指纹（ceiling，撞了再说）。
