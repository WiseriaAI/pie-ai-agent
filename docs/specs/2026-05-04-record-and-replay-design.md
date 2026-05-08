---
date: 2026-05-04
topic: record-and-replay
status: brainstormed
related:
  - docs/specs/2026-05-04-tabs-create-and-nav-requirements.md  # 方向 3，依赖
  - docs/ROADMAP.md  # §2 Skill 框架进阶 / §5 #4 行为录制
---

# 网页操作录制 + 回放（trace-as-Skill）

## Problem Frame

Phase 2 起 agent 能用 click / type / scroll 等 tool 操作网页，但**单次任务驱动**——用户每次想跑同样流程要重头描述。BYOK 用户面对"每天登录 SaaS 检查 X / 点 4 步固定操作 / 重复任务"等场景，缺一种"演示一次后可重复调用"的能力。

ROADMAP §2 已定方向"操作录制 → Skill 自动生成"为 backlog；ROADMAP §5 #4 brainstorm 收窄到 trace-as-Skill 形态。本 spec 是 v1 设计。

**关键 reframe**：录制+回放原本被设想为**新建 replay engine 子系统**（DOM event listener + 直接 dispatch），但 brainstorm 期间用户给出关键 framing 简化——

> "录制产物是 Skill，回放就是调用 skill"

这意味着 v1 **不引入新 engine**：录制 = 用户演示动作 → 系统序列化为自然语言 promptTemplate → 写入现有 Skill；回放 = LLM 调用 skill → 现有 ReAct 路径 + click/type/scroll 工具走完。所有 Phase 2.6 capability invariant / Phase 3 cross-tab / Phase 2.5 CDP / M1 paused/resume / M3 multi-session sandbox 自然兼容。

## v1 Scope

**做**：

- Sidepanel 演示模式（toolbar 入口 + 实时 step list + Finish/Discard 按钮）
- DOM event listener 注入到 active tab，capture click / input / select / scroll / submit
- 敏感字段 auto-redact（type='password' / autocomplete='cc-*' / aria-label 含 'password|secret|token|api[._-]?key|auth'）→ 替换为 `{{paramName}}` placeholder
- RecordedAction[] → 自然语言 promptTemplate 序列化（与现有 Skill schema 100% 兼容）
- promptTemplate + 自动推断 allowedTools + 自动构造 toolSchema.parameters 写入新 user-authored Skill
- 录制中 cross-origin nav / 新 tab 自动 record navigate action 续录
- SW restart 中途 abort 录制（不持久化，与 Fail-on-image 心智一致）
- 回放完全复用现有 skill dispatch + ReAct loop

**不做**（明确推 v1.1+）：

- 数据爬取 + 预览 + 写文件（CSV/JSON 导出 / chrome.downloads permission / table preview / row-level progress）—— 用户 reframe 时拆出，作为 v1 之上用户自定义 layer
- 结构化 traceSpec 字段升级 Skill schema —— v1 只用现有 promptTemplate 字段
- Mechanical replay engine（DOM event 直接 dispatch）—— v1 通过 LLM 调 skill 走 ReAct 即可
- LLM 续跑数据循环 —— v1 是固定步骤序列，不是 N 行循环
- 录制中关键判断点用户标注（mechanical / LLM 混合） —— v1 全部 LLM 调用现有 tool
- 录制完成后用户编辑结构化步骤 UI —— v1 用户能编 promptTemplate 文本（与现有 SkillsList Skill 编辑一致）
- 跨 origin 复杂导航场景的特殊处理 —— v1 复用方向 3 multi-pin + open_url（依赖方向 3 ship）

## Architecture

录制层 + 现有所有路径的接入点。整体 dataflow：

```
用户在 sidepanel 点 "Start recording"
  ↓
sidepanel 注入 Recording Mode flag → SW 端创建 RecordingSession（per-tab）
  ↓
用户在 active tab 上正常操作（click / input / scroll / 翻页）
  ↓
Recording Capture Layer 监听 DOM events（content script + 注入式 listener）
  ↓ 每个 event
SW 收到 RecordedAction { type, selector, value?, redactedValue? }
  ↓
sidepanel 实时显示 step list ("第 N 步：click ..." / "第 M 步：type ...")
  ↓
用户点 "Finish recording"
  ↓
SW 序列化 RecordedAction[] → 自然语言 promptTemplate
  ↓
弹"保存为 Skill"对话框（Skill name / description / allowedTools 自动推断）
  ↓
write 到现有 chrome.storage Skill key（user-authored, R10 first-run gated）
  ↓
SkillsList UI 自动显示新 skill（可编辑 promptTemplate 修订）
```

**接入点 / 复用基础设施**：

- **Skill 系统（Phase 2.6）**：`promptTemplate` / `allowedTools` / R10 first-run-confirm / 8 capability invariants 全自动适用
- **Phase 3 cross-tab + 方向 3 multi-pin**（方向 3 ship 后）：录制中如果用户开新 tab，新 tab 自动加入 pinnedTabs 数组
- **Phase 2.5 CDP**：录制中 CDP keyboard input（如飞书 docs 演示）依然可用
- **M1 paused/resume**：录制中 SW restart → 录制 session 视为 ephemeral state，转 abort（参考 Fail-on-image 模式：录制中途 SW restart = 录制 abort + drift card 提示重 demo）
- **M3 multi-session sandbox**：录制 session bound 到当前 active session；session 切走自动结束录制

## Components

### `src/lib/recording/types.ts`

**职责**：定义 RecordedAction / RecordingSession 类型 schema。

```typescript
type RecordedAction = {
  type: 'click' | 'type' | 'select' | 'scroll' | 'navigate' | 'wait';
  selector: string;          // 稳定 selector（plan 阶段定优先级：data-testid > aria-label > role > nth-of-type）
  label: string;             // 人类可读："点击 '提交' 按钮"
  value?: string;            // type / select 的值；密码等已 redact
  redacted?: boolean;        // 是否被 redact（true = value 已替换为 placeholder name）
  placeholderName?: string;  // redact 后的 placeholder 名（"password" / "cc_number"）
  url: string;               // action 时所在 URL（origin tracking）
  timestamp: number;
};

type RecordingSession = {
  sessionId: string;         // 绑定到当前 active session（M3 multi-session）
  tabId: number;             // 录制目标 tab
  origin: string;            // 起始 origin（cross-origin 切换 → 录 navigate action）
  startedAt: number;
  actions: RecordedAction[];
};
```

**依赖**：无。

### `src/lib/recording/capture.ts`

**职责**：在目标 tab 注入 capture-phase event listeners（click / input / change / scroll / submit），把每个 user action 序列化为 RecordedAction 发回 SW。

**接口**：`startCapture(tabId, sessionId)` / `stopCapture(tabId)`——通过 `chrome.scripting.executeScript` 注入 self-contained listener function（参考 Phase 2 dom-actions 模式：no closures，args via executeScript）。注入函数用 `chrome.runtime.sendMessage` 把 RecordedAction 发回 SW。

**依赖**：`chrome.scripting`、注入函数 self-contained。

### `src/lib/recording/redact.ts`

**职责**：基于 input element 的 type / autocomplete / aria-label，判断是否敏感 + 返回 placeholder 名。

**接口**：`detectSensitive(elementMeta: { type, autocomplete, ariaLabel, name, placeholder }) → { redacted: boolean, placeholderName?: string }`。规则：

- `type='password'` → redact, placeholder=`password`
- `autocomplete` 含 `cc-number|cc-csc|cc-exp|new-password|current-password` → redact
- `aria-label|name|placeholder` 含正则 `/password|secret|token|api[._-]?key|auth/i` → redact
- 否则 → 不 redact，原样存

**依赖**：纯函数，运行在 capture 注入上下文里。

### `src/lib/recording/serialize.ts`

**职责**：RecordedAction[] → 自然语言 promptTemplate（写进现有 `Skill.promptTemplate` 字段，保留 8KB 限制）。

**接口**：`serialize(actions: RecordedAction[]) → { promptTemplate: string, parameters: string[] }`——actions 转中文步骤描述（"第 1 步：在 '.email' 输入用户邮箱"），redacted action 渲染为 Handlebars 风格 `{{password}}` 占位；返回 parameters 数组用于自动构造 Skill `toolSchema.parameters` JSON Schema（与 R10 first-run-confirm + Phase 2.6 capability invariants 自然兼容）。

**依赖**：纯函数。

### `src/sidepanel/components/RecordingMode.tsx`

**职责**：sidepanel 录制 UI——toolbar 录制状态、实时 step list、"Finish recording" / "Discard" 按钮。

**接口**：React component，由 sidepanel 路由根据 `recording` state 条件渲染（state 来自 SW，每个 RecordedAction 通过现有 port message 推到 panel）。

**依赖**：现有 sidepanel state hooks、`useSession` hook（绑定到 active session）。

### `src/background/recording-orchestrator.ts`

**职责**：录制生命周期 orchestrator——响应 sidepanel start/finish 命令；调 `capture.ts.startCapture` 注入 listener；buffer RecordedAction[]；finish 时调 `serialize` + 创建 user-authored Skill via 现有 `lib/skills/storage.ts`；SW restart 时 abort 录制（不持久化录制中间态）。

**接口**：handler functions for `chrome.runtime.onMessage`（`recording-start` / `recording-finish` / `recording-discard`）。

**依赖**：`recording/capture.ts`、`recording/serialize.ts`、`lib/skills/storage.ts`、M3 active session 注册（决定 RecordingSession.sessionId）。

## Data Flow

### Flow 1: 录制启动

```
sidepanel "Start recording" 按钮
  → chrome.runtime.sendMessage('recording-start', { activeSessionId })
  → SW: recording-orchestrator.handleStart
    - 检查 active session 状态（必须 idle，不允许在 streaming agent task 中启动）
    - 检查 active tab origin（不能是 chrome:// / chrome-extension:// / file:）
    - 创建 RecordingSession { sessionId, tabId, origin, startedAt, actions: [] }
    - 调 capture.startCapture(tabId, sessionId)（chrome.scripting.executeScript 注入 listener）
    - SW state: recordingSessions[sessionId] = RecordingSession
  → port broadcast 'recording-started' { sessionId }
  → sidepanel 切到 RecordingMode UI
```

### Flow 2: User action capture（每次 user 操作）

```
用户在目标 tab 上 click / input / scroll / submit
  → 注入的 capture listener (capture phase) 拦到 event
    - 提取 element meta: { tag, type, autocomplete, ariaLabel, name, placeholder }
    - 算稳定 selector（data-testid > aria-label > role+text > nth-of-type fallback）
    - 调 redact.detectSensitive(elementMeta)
      - 敏感 → value 替换为 placeholder name（不在 client 留原值）
      - 非敏感 → value 原样
    - chrome.runtime.sendMessage('recording-action', RecordedAction)
  → SW: orchestrator.handleAction
    - append 到 recordingSessions[sessionId].actions
    - port broadcast 'recording-action' 给 sidepanel
  → sidepanel RecordingMode UI append step list（实时显示 "第 N 步：..."）
```

### Flow 3: 录制结束 → 保存 Skill

```
sidepanel "Finish recording" 按钮
  → chrome.runtime.sendMessage('recording-finish', { skillName, skillDescription })
  → SW: orchestrator.handleFinish
    - 调 capture.stopCapture(tabId)（移除 listener）
    - 调 serialize(actions) → { promptTemplate, parameters }
    - promptTemplate 长度检查（≤ 8KB Phase 2.6 限制；超限提示用户裁剪步骤数）
    - 自动推断 allowedTools（基于 actions 类型推断：含 click → 'click', 含 type → 'type', 含 scroll → 'scroll'）
    - 调 skills/storage.createUserSkill({
        id: 'skill_user_' + uuid(),
        name: skillName,
        description: skillDescription,
        promptTemplate,
        toolSchema: { parameters: schemaFromParams(parameters) },
        allowedTools,
        author: 'user',
        createdAt: now,
        builtIn: false,
        enabled: true
      })
    - delete recordingSessions[sessionId]
  → port broadcast 'recording-finished' { skillId }
  → sidepanel 关闭 RecordingMode UI，跳转到 SkillsList 高亮新 skill
```

注：`firstRunConfirmedAt` 不设 → 首次执行走 R10 confirm。User-authored skill 默认免 R10，但录制 skill 含 click/type 等高敏 capability，**plan 阶段决定是否对录制 skill 强制 R10 first-run-confirm**——倾向是的，因为录制 skill 的"capability scope"用户可能没完整 review。

### Flow 4: 回放（调用 skill）= 现有 skill dispatch path

```
用户在 chat 输入 /<skillName> args 或 LLM 在 agent task 中决定调用
  → 现有 skill resolution + ReAct loop
  → LLM 看到 promptTemplate 中渲染好的步骤序列（含 {{password}} 等参数 placeholder 已 substitute）
  → LLM 自主决策每步：
    - "第 1 步：点击 .submit" → LLM 调 click tool → 现有 confirm card / risk classifier / R10 invariant 全适用
    - "第 2 步：输入 {{password}}" → LLM 调 type tool（value 来自 user 提供的参数）
    - selector 失效 → LLM 看到 click tool error → 自适应（重新看 page snapshot 找替代 selector，或 emitDone fail）
  → 最终 emitDone（success / fail / abort 任一）
```

### Flow 5: SW restart 中途 abort（录制 ephemeral，不持久化）

```
录制中 SW 被 Chrome evict（30s idle / 5min hard）
  → SW restart
  → recordingSessions Map 是 in-memory，全部丢失
  → recovery path: detectAndMarkPaused 不 handle recording session（recording 不在 session_index agentMessages 中）
  → sidepanel ↔ SW port 触发 disconnect → reconnect（M2-U2 wire）
    → reconnect 后 sidepanel 主动 query 'recording-state' (sessionId) → SW 返回空（recordingSessions Map 已丢）
    → sidepanel 据此 infer abort，显示 "Recording aborted (SW restart)，请重新开始" + Discard 按钮
  → 用户 acknowledge → sidepanel 清 recording state，回到正常模式
```

理由：录制是 ephemeral state，半截录制对用户不友好（恢复出半截 trace 用户也不知道哪段缺）；直接 abort + 提示重 demo 是最 honest behavior，与 H-3 Fail-on-image 决策心智一致。

## Error Handling

### 录制启动期错误

| 场景 | 处理 |
|---|---|
| Active session 正在 streaming agent task | reject + sidepanel toast `'agent task in progress, finish it before recording'`，不进 RecordingMode |
| Active tab 是 restricted URL（`chrome://` / `chrome-extension://` / `file:` / `about:`）| reject + sidepanel toast `'cannot record on this URL'`；与 M3-U2 captureActivePinned 的 restricted-URL filter 一致 |
| 没有 active session（empty state）| reject + sidepanel toast `'create or select a session first'` |

### 录制运行期错误

| 场景 | 处理 |
|---|---|
| 算不出稳定 selector | 退化用 absolute path（`html > body > div > ...`）+ RecordedAction.label 加 `[selector unstable]` 警告；sidepanel UI 该 step 红色高亮提示用户"此步骤可能回放失败" |
| 用户 cross-origin nav 中间录到一半 | record `navigate` action + 继续录；navigate action 序列化为 `'第 N 步：导航到 https://...'`；回放时 LLM 走 v1 仅有的 `open_url`（依赖方向 3）— 已 high-risk confirm |
| 用户开新 tab（含 cross-window）| record `navigate` action（target tab）+ multi-pin 自然处理；新 tab 在录制期间被加入 capture 范围（capture listener 自动注入到新 tab）|
| Redact 漏 detect | 演示完成时 sidepanel **review 步骤列表**，用户能在每步 click "redact this value"——手工补救 redact 漏检（非阻塞 finish）|
| `promptTemplate` 序列化超 8KB | finish 时检查；超限弹 sidepanel dialog `'录制太长（X KB > 8KB），请删除部分步骤或合并'` + 用户在 step list 删步骤；不允许超限保存 |
| 录制中用户切到别的 active session（M3 setActive）| 同 Flow 5 abort 处理：sidepanel 显示 `'recording aborted (session switched)'` + Discard 按钮 |
| Capture listener 注入失败（page CSP 严格 / sandbox iframe）| sidepanel toast `'cannot record on this page (page security restrictions)'` + 自动 abort |

### 录制完成 / 保存期错误

| 场景 | 处理 |
|---|---|
| Skill 名重复 | sidepanel dialog 让用户改名或覆盖原 skill（覆盖走现有 update_skill path 的 R10 taint propagation）|
| `lib/skills/storage.createUserSkill` 写失败 | sidepanel dialog `'failed to save skill: <reason>'`；保留 RecordingSession 在 SW 内存让用户重试；超 1MB skill quota → 提示用户先删旧 skill |

### 回放期错误（v1 不引入新路径——全部走现有 ReAct）

回放就是现有 skill dispatch + ReAct loop：

- selector 失效 → click tool 返回 `element-not-found` 观察 → LLM 自适应（重 snapshot 找替代 selector / 或 emitDone fail）
- 页面结构大改 → LLM 在多次 retry 后 emitDone `'recorded skill no longer matches current page, please re-record'`
- 用户 reject confirm card 3 次 → K-10 task abort（现有机制）
- LLM 误读 promptTemplate 步骤 → 用户 review 录制 skill 时可手编 promptTemplate 修订（与 manual edit user-authored skill 同 path，走 update_skill R10 taint）

**v1 不引入新错误处理路径**——所有回放期问题都已被 Phase 2 / 2.6 / 3 / M1 现有机制覆盖。这是 trace-as-Skill framing 的核心好处。

## Testing

### Unit tests（pure functions）

**`recording/redact.test.ts`** — `detectSensitive` 全覆盖：

- `type='password'` → redact, placeholder=`password`
- `autocomplete='cc-number'` / `cc-csc` / `cc-exp` / `new-password` / `current-password` → redact
- `aria-label` / `name` / `placeholder` 含 `password|secret|token|api[._-]?key|auth` 大小写不敏感正则 → redact
- 普通 `type='text'` 无敏感 hint → 不 redact，原样存
- 边界：`type='email'` + 普通 placeholder → 不 redact；`type='hidden'` → 录制不 capture

**`recording/serialize.test.ts`** — `serialize(actions[])` 确定输出：

- 空 actions → 空 promptTemplate + 空 parameters
- 单 click → "第 1 步：点击 ..."
- 含 redacted action → promptTemplate 包含 `{{password}}` placeholder + parameters 含 `password`
- 多 input 多个 redacted → parameters 数组无重复（同 placeholder 共享一个参数）
- 超 8KB → throw `PromptTooLargeError` 让 caller 决定
- selector unstable warning → label 含 `[selector unstable]` 标记保留

**Selector 稳定性算法 unit test**（plan 阶段定算法后写）：

- data-testid 优先
- 缺 data-testid 时 aria-label
- 缺 aria-label 时 role + 文本
- nth-of-type fallback + warning

### Integration tests（component-level）

**`recording-orchestrator.test.ts`** — 用 mock chrome.scripting / chrome.runtime：

- `handleStart`：active session streaming → reject；restricted URL → reject；正常路径 → 创建 RecordingSession + 调 startCapture
- `handleAction`：action append 到 RecordingSession.actions + broadcast 给 sidepanel
- `handleFinish`：调 serialize + createUserSkill + 清 SW state + broadcast 'recording-finished'
- `handleAbort`（M3 session switch / SW restart simulate）：清 SW state + broadcast 'recording-aborted'
- promptTemplate > 8KB → handleFinish reject + 不写 skill

**`recording/capture.integration.test.ts`** — happy-dom 环境（与 M2 现有 happy-dom infra 一致）：

- 注入 listener 到 mock DOM
- click / input / change events → 收到 RecordedAction
- value redacted 正确
- selector 算正确

### Multi-session 隔离 regression

**新增 `loop.test.ts`** 一组 cases（mirror M3-U5 trace doc 模式）：

- session A 录制中 + session B 用 chat → session B 不被影响
- session A 录制中 + session B 也 start 录制 → 两个独立 RecordingSession 不串味
- session B 调用 user-authored recorded skill → 与 session A 录制的 skill state 隔离

### Manual / dogfood E2E

要在 manifest dev mode 测：

- 端到端：demo 一个 5 步登录 + 点报表流程 → 保存 skill → 切到新 session 调用 skill → 断言每步通过 click/type tool 走完 + LLM 跟着 promptTemplate 步骤
- SW restart abort：录制中 reload extension → sidepanel 显 abort + Discard
- Cross-origin nav 录制：录到一半点外链 → record navigate action + 录制延续；保存后回放 nav action 走 open_url（依赖方向 3 ship）
- Redact 实地：用 GitHub 登录页 / 银行登录页测 password / 2FA 自动 redact；用 Stripe 测试卡号字段测 cc-number redact

### v1 必须 lock 的 invariant

- **promptTemplate ≤ 8KB**：复用 Phase 2.6 P0-D 限制；超限 createUserSkill 直接 reject
- **`allowedTools` 自动推断的工具名必在 KNOWN_*_TOOL_NAMES**：复用 Phase 2.6 P1-G build-time check
- **skill id prefix `skill_user_`**：复用 Phase 2.6 P1-E
- **录制 SW state 不持久化**：build-time 强制 RecordingSession 类型不在 chrome.storage write path 出现（grep 测试）；M1 detectAndMarkPaused 不识别 RecordingSession（recovery_guard 不 enumerate）
- **录制不修改现有 Skill**：createUserSkill 走 create path，不 update；保留现有 skill 名时 reject 让用户改名或显式 overwrite
- **录制不出现在 agent task 内**：chat/agent task streaming 时 recording-start reject

## Dependencies / Assumptions

- **方向 3 multi-pin + open_url 已 ship**：本 spec 的 Flow 2 cross-origin nav 录制 / Flow 4 回放时 navigate action 调 `open_url` 都依赖此前置；方向 3 仍在 brainstorm finalize（`docs/specs/2026-05-04-tabs-create-and-nav-requirements.md`），需先 ship。Plan 阶段需在方向 3 ship 后启动
- **Phase 2.6 Skill 系统机制已稳定**：promptTemplate 8KB 限制 / allowedTools 必须 ⊂ KNOWN_*_TOOL_NAMES / R10 first-run-confirm / capability invariants 全部依赖
- **M1 paused/resume 机制不识别 recording session**：录制不持久化 chrome.storage，detectAndMarkPaused 不 enumerate 录制 session（与 Fail-on-image 心智一致）
- **M3 multi-session sandbox**：每 session 独立 RecordingSession（不串味）；session 切走 setActive 时录制自动 abort
- **Phase 2.5 CDP 不被本 spec 直接调用**：录制走 DOM event listener（已有 chrome.scripting.executeScript 路径），不需要 CDP attach。回放期间如调 type tool 在 canvas editor → 走现有 Phase 2.5 CDP keyboard 路径（与录制层解耦）
- **chrome.scripting permission 已在 manifest**：现有 dom-actions 工具就用此 permission，不需要新加权限

## Outstanding Questions for Plan

### Resolve Before Planning

- **Selector 稳定性算法的优先级链**：data-testid > aria-label > role+text > nth-of-type 是 default，但具体生成逻辑、selector 复杂度上限、unstable 警告触发阈值需 plan 阶段 nail；测试 corner case：同时多个 element 共享 aria-label 怎么 disambiguate
- **录制 skill 是否强制走 R10 first-run-confirm**：user-authored skill 默认免 R10，但录制 skill 含 click/type 等高敏 capability，capability scope 用户可能没完整 review。Plan 阶段决定 createUserSkill 时 author='user' 但 firstRunConfirmedAt 不设 → 是否 R10 fire？倾向 fire（让用户 review 自己录的步骤）
- **promptTemplate 序列化模板的具体语言**：中文 / 英文 / multi-locale？BYOK 用户多语言场景下 LLM 跟着 prompt 步骤 → 测试 LLM 对中文步骤指令的跟随准确度（Anthropic / OpenAI / OpenRouter 各自）

### Deferred to Planning

- **`recording-start` / `recording-action` / `recording-finish` 等 chrome.runtime message types**：与现有 ChatMessage / AgentMessage / SessionMessage 系列对齐命名
- **Sidepanel UI 的 RecordingMode 设计**：录制时是覆盖在 chat tab 上还是独立 tab？step list 滚动行为？删除 / 合并步骤交互？
- **"Save as Skill" 对话框设计**：skill name 输入 / description 输入 / allowedTools 自动推断 review / parameters 名重命名
- **录制中 SPA route change 的 capture listener re-attach**：pushState / replaceState 触发后 listener 是否还活？plan 阶段验证
- **录制 step list 实时编辑**：合并连续 click 同一 element？删除 redundant scroll？v1 是否做？
- **Redact 漏 detect 的用户手动补救 UI**：每个 input action 显示 "redact this value" 按钮 vs 列表式 review
- **`firstRunConfirmedAt` 在录制 skill 上的 R10 行为**（与上面 Resolve-Before-Planning 第 2 条联动）
- **录制中 capture listener 在 sandbox iframe / extension UI 自身的边界**：不该 capture sidepanel 自身 click（context confusion 防御）
- **Selector 稳定性算法的具体实现**：CSS selector library 选择 / 自研 / 复用 chrome inspector 的内部 logic（如果可访问）

## Next Steps

→ 等方向 3（multi-pin + open_url）ship → `/superpowers:writing-plans` 生成 implementation plan。Plan 阶段 unit-1/2/3 必须先解 Resolve-Before-Planning 3 项（selector 算法 / R10 行为 / promptTemplate 语言），再展开后续 unit。

预估 plan unit 数：~6-8 unit（types + capture + redact + serialize + orchestrator + RecordingMode UI + manifest）。预估时长：3-5 天（依赖方向 3 已 ship；selector 稳定性算法是主要时间消耗）。
