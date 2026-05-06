---
date: 2026-05-06
topic: skill-scope-and-skip-permissions
issue: "#26"
---

# Skill Scope 解禁 + 全局 skip-permissions 开关

## Problem Frame

Phase 2.6（Skill 自主 CRUD）落地后，Skill 框架带着两层约束运行了一段时间：

1. **`allowedTools` 白名单（R2）+ skill→skill 禁止（R3）**：skill 进入"作用域"后，loop 强制拒绝白名单外的 tool 名；skill 不能调其他 skill。
2. **R10 first-run-confirm**：`author='agent'` 且未确认过的 skill 第一次执行时再弹一次 confirm 卡。

加上**所有高风险 tool 仍逐次弹卡**（risk classifier 永远在跑），实际使用中出现两类摩擦：

- Skill 作者在 `create_skill` 时不可能预见所有需要的 tool；常见情况是 skill 第一次跑挂在某个未列入 `allowedTools` 的 tool 上，agent 看到 R2 拒绝 observation 改不了 skill schema 只能 fail。
- 已经被用户 confirm 过的 skill，内部每个 click submit / type 敏感字段 / dispatch_keyboard_input / open_url / get_tab_content 仍弹卡。一次"用 skill 完成一个 5 步流程"的任务里，用户可能要点 4-5 次 Approve。

Issue #26 提出两个明确诉求——

1. 取消 skill scope 内的 tool 白名单管控；
2. 提供"一次 opt-in 之后整体免确认"的全局开关。

本 brainstorm 把这两条都落地。两件事在代码上**正交**——Change 1 拆 skill scope 的 R2/R3/R10 enforcement；Change 2 在 SW `sendConfirmRequest` 短路高风险确认。两条合并能完整覆盖 issue #26 的痛点；其中任何一条单独发布也是合法状态。

**对历史 invariant 的影响**：K-3 capability-grant 防御链（来自 `docs/solutions/2026-05-01-llm-capability-grant-invariants.md`）以 `allowedTools` 为支柱。Change 1 之后 K-3 链失效，是有意识的设计放宽——交给 (a) `create_skill`/`update_skill` 的高风险 confirm 卡（仍保留）、(b) skipPermissions 默认关 + 切开时的一次性 modal、(c) `untrusted_*` wrapper 防 prompt injection 这三条非 R10 路径承担安全护栏。

## Requirements

### Change 1 — 解禁 skill scope（必做）

- **R1.1** 删除 loop 层 R2 enforcement：skill 作用域内 tool 名不再做白名单检查。
- **R1.2** 删除 loop 层 R3 enforcement：skill 可以调其他 skill；递归风险由 agent loop 既有的 max-iteration 上限兜底。
- **R1.3** 删除 R10 first-run-confirm 整段：`author='agent'` 的 skill 不再有"运行时第二道 confirm"。`create_skill`/`update_skill` 的高风险 confirm 卡是创建/修改阶段唯一审查窗口。
- **R1.4** `SkillDefinition.allowedTools` 与 `SkillDefinition.firstRunConfirmedAt` 字段在 TS 类型上**保留**为 optional + `@deprecated` 注释，向后兼容老 storage 数据；任何代码不再读、不再写。
- **R1.5** `create_skill` schema 移除 `allowedTools` required + properties；`update_skill` patch schema 移除 `allowedTools`。`validateSkillContent` 删除 P1-F（`allowedTools` 必须为数组）和 P1-G（每个名字必须已注册）两条。
- **R1.6** `update_skill` handler 不再清空 `firstRunConfirmedAt`，不再写 `merged.allowedTools`；`author = 'agent'` 污染规则**保留**（SkillsList 角标仍需要这个信息）。
- **R1.7** `markSkillFirstRun` 函数 + 相关 storage helper + index re-export **删除**。
- **R1.8** loop ctx 与 checkpoint 持久化中的 `skillExecutionScopeStack` / `resumedSkillScopeStack` 字段**整段删除**；老 checkpoint 反序列化时多余字段被忽略，不报错。
- **R1.9** `risk.ts` `riskOfAllowedTools` 函数删除；G-1 build-time gate 保留代码，仅重写头部注释——把"K-3 防御链支柱"改为"防新增 cross-tab tool 漏分类导致默认 low-risk"。
- **R1.10** `tool-names.ts` 中只服务于 P1-G 的导出（如 `ALL_KNOWN_NON_SKILL_TOOL_NAMES` 若无其他引用）评估后删除；其他用途的导出保留。

### Change 2 — 全局 skip-permissions 开关（必做）

- **R2.1** 新建 `src/lib/skip-permissions.ts`，仿 `keyboard-simulation.ts` 模式：`isSkipPermissionsEnabled()` / `setSkipPermissionsEnabled()` / 导出 `SKIP_PERMISSIONS_STORAGE_KEY = "skip_permissions_enabled"`。
- **R2.2** chat-start handler（`src/background/index.ts`）入口读一次 `isSkipPermissionsEnabled()` 作为**任务级 snapshot**，闭包捕获到 `sendConfirmRequest`；同时通过 `runAgentLoop` ctx 传入 `skipPermissions: boolean` 字段。任务跑到一半切 toggle 不影响 in-flight 任务（同 keyboard sim 语义）。
- **R2.3** `sendConfirmRequest` 在既有 flood-limit 检查与 pre-capture（screenshot）/ open_url URL 解析之后、panel-post 之前，新增短路分支：snapshot=`true` 时
  - 截图工具：`consumePreCapture(confirmationId)`，存在则返回 `{approved: true, screenshotResult: img}`；缓存 miss 返回 `{approved: false, reason: "pre-capture-failed"}`
  - 其他工具：直接返回 `{approved: true}`
- **R2.4** Risk classifier **不变**：`classifyRisk` 在 skipPermissions=true 时仍然跑，仍输出 `level: 'high' | 'low'`。差别仅在于 `loop.ts` 的 `risk.level === 'high'` 分支不再走 `sendConfirmRequest`→等待 panel→根据结果路由的 UI 路径（被 R2.3 短路）。
- **R2.5** `loop.ts` 任何被 `sendConfirmRequest` 短路自动批准过的 tool dispatch 在最终 `emit agent-step` 时附加 wire 字段 `autoApproved: true`；其他情况不带该字段。覆盖路径包括：(a) 通用 high-risk 分支（`loop.ts:1890` 附近）；(b) 截图分支（`loop.ts:1707-1867`）。Panel 端 `AgentStepCard` 渲染器读到 `autoApproved: true` 在 step 卡底部加一行小灰字 `auto-approved by skip-permissions`。
- **R2.6** Settings UI 新增 `<SkipPermissionsSection>`，放在 `<KeyboardSimSection>` 下；视觉惯例使用 warning 色系（`border-warning-line bg-warning-tint text-warning`）。
- **R2.7** Toggle OFF→ON 触发**一次性 modal**：文案直白说明"勾选后所有工具调用会无确认执行；可以随时关回去"，提供「我了解，开启」+「取消」二选一；不要求 typing"I understand"。Toggle ON→OFF 直接生效。
- **R2.8** Chat 顶部（消息列表上方）在 skipPermissions=true 期间显示**不可关闭**的 warning banner：`⚠ Skip-permissions ON — tool calls auto-approved · Disable`。`Disable` 是文字按钮跳到 Settings → SkipPermissions 区，让用户走正常关闭路径。Banner 通过 `chrome.storage.onChanged` 实时同步状态。
- **R2.9** 文案语言**英文**（与现有 Settings 节一致）。

### CRUD UI / Confirm 卡修剪

- **R3.1** SkillsList 编辑表单删除 `allowedTools` 输入控件、详情视图删除 `allowedTools` 展示、保存路径写出对象时不携带 `allowedTools` / `firstRunConfirmedAt` 两个字段。
- **R3.2** SkillsList 删除"first-run pending"角标判定（即 `skill.author === 'agent' && skill.firstRunConfirmedAt === undefined` 的视觉提示）。
- **R3.3** AgentConfirmCard 删除 `allowedToolsUnchanged` 比较逻辑 + `allowedTools` 字段渲染；header 文案改写——
  - 创建态：`Creating a new agent-authored skill. After approval the skill is saved and callable on subsequent turns.`
  - 更新态：`Updating <id>. After approval the skill is saved and runs without further confirmation. Fields tagged "(unchanged)" stay as they were.`
- **R3.4** `SkillSlashPopover` 的 `authorTag`（USER/AGENT/BUILT-IN 角标）**保留**——用户仍需要区分 skill 来源。
- **R3.5** Built-in skill 字面量（`builtin.ts` 中 7 个内置 skill）从对象字面量里移除 `allowedTools` 字段。

### 留下来的护栏（明确不动）

- **R4.1** `untrusted_*` wrapper（`untrusted_page_content` / `untrusted_tab_metadata` / `untrusted_user_message` / `untrusted_skill_params`）**完全保留**——数据流防御与 UI 确认完全正交。skipPermissions=true 时仍生效。
- **R4.2** K-9 close_tabs user-locked pin refusal、R7 cross-session pinned-tab lock 等 server-side 拒绝**保留**——与 confirm UI 无关。
- **R4.3** `create_skill` / `update_skill` 自身的高风险卡**保留**（仅 skipPermissions=true 时才整体短路）：在默认配置下，扩 capability 仍需用户在卡上看完 promptTemplate / parameters 后 approve。
- **R4.4** Risk classifier 全部既有规则**保留**（CDP keyboard 永远 high、screenshot 永远 high、submit click / 敏感字段 type / cross-tab write / open_url / get_tab_content / cross-origin activate_tab / list_tabs allWindows 等）。
- **R4.5** `agent` author 污染规则保留：`update_skill` 仍把 author 改成 `'agent'`（SkillsList 角标依据）。
- **R4.6** K-10 confirm fatigue（连续 3 次拒绝同一 tool 终止任务）保留——skipPermissions=true 时自然失效但无害；OFF 模式下仍是有效 fatigue 防御。

## Success Criteria

- Skill 内可调任意 tool（含调另一个 skill），不再因 R2 / R3 报错。
- `update_skill` 后再调用该 skill 不再触发 first-run-confirm。
- `create_skill` 不带 `allowedTools` 也能通过校验、写入 storage。
- 老 storage 中带 `allowedTools` / `firstRunConfirmedAt` 字段的 skill 反序列化不报错；正常显示、调用、保存（保存后字段消失，lazy migration）。
- Settings 有 `Skip permissions` toggle，OFF→ON 弹 modal 二次确认；ON 后 Chat 顶部出现常驻 warning banner；ON 模式下点击/按键/截图/skill 创建等高风险工具不弹卡，agent-step 卡上有 `auto-approved by skip-permissions` 小灰字。
- 任务跑到一半切 toggle 不影响 in-flight 任务行为（snapshot 验证）。
- skipPermissions=true 时 `untrusted_*` wrapper 仍生效；K-9 / R7 server-side 锁仍生效；CDP keyboard 浏览器原生黄条仍出现。
- `pnpm test` + `pnpm build` 全绿（含 risk.ts G-1 build-time gate）。

## Scope Boundaries

- **不含** per-skill `trusted` 标记（granular 模式）——若日后用户反馈"想信任某 skill 但不想全局裸跑"再加，本 phase 只做全局开关 + 解禁 skill scope。
- **不含** "memory of past approvals" 类型的 per-tool/per-target 信任——属于另一种 UX 折中，不在本 phase 范围。
- **不含** SW 端额外的 page-content 防注入加固（`untrusted_*` 已经是现行机制，不动）。
- **不含** Settings 内"我理解风险"输入文本框式的强仪式（评估对开发者过度繁琐）。
- **不含** 任何对 risk classifier 规则的扩缩——本 phase 只改"分级后做什么"，不改"怎么分级"。
- **不含** 跨 session skipPermissions 共享逻辑——单 toggle 对所有 session 全局生效，符合 chrome.storage.local 一切都是单浏览器配置文件的现实。

## Implementation Surface（plan 用作起点）

按顺序、每步独立可验证、回退安全：

1. 新建 `src/lib/skip-permissions.ts`
2. Settings 加 `<SkipPermissionsSection>` + 一次性 modal（toggle 暂未生效）
3. Chat header 加 banner（订阅 `chrome.storage.onChanged`）
4. SW `sendConfirmRequest` 加短路分支（toggle 此时真正生效）；ctx 注入 `skipPermissions`
5. loop.ts 删 R10 整段（`loop.ts:2002-2061`）；agent-step 事件加 `autoApproved` wire 字段
6. loop.ts 删 R2/R3（`loop.ts:1519-1551`）；删 `skillExecutionScopeStack` 全部相关代码
7. `skill-meta.ts` 改 schema + 删 P1-F/P1-G 校验 + 改 update handler
8. `skills/types.ts` 标 `@deprecated` 注释；`storage.ts` + `index.ts` 删 `markSkillFirstRun`
9. `builtin.ts` 7 个 skill 去 `allowedTools`
10. `risk.ts` 删 `riskOfAllowedTools`；G-1 gate 注释重写
11. `SkillsList.tsx` 删 `allowedTools` 输入 + first-run 角标
12. `AgentConfirmCard.tsx` 删 `allowedToolsUnchanged` + render；header 文案改
13. `tool-names.ts` 评估 dead export 后删
14. tests 同步加（详见 Testing 节）

## Testing

### Unit

- `skip-permissions.test.ts` — get/set 持久化、默认 false、非 boolean 强转。
- `loop.test.ts`：(a) skipPermissions=true 时 high-risk tool 不向 panel 发 `agent-confirm-request` wire 事件（短路在 SW 侧完成）；(b) skipPermissions=false 时维持现状；(c) skill scope 内调任意 tool（含其他 skill）不报错；(d) `update_skill` 后再调 skill 不触发 R10（不发 R10 confirm-request）；(e) agent-step 事件在 skipPermissions=true && 该步原本会进 confirm 路径（high-risk 或 screenshot）时带 `autoApproved: true`。
- `skill-meta.test.ts`：(a) `create_skill` 不带 `allowedTools` 通过；(b) 传了也不写入 storage；(c) `update_skill` 后 `firstRunConfirmedAt` 不存在；(d) `validateSkillContent` 不再因未注册 tool 名拒绝。
- `skills/storage.test.ts`：老数据带 deprecated 字段反序列化不报错；新写入对象不含。
- `risk.test.ts`：classifier 行为不变；`riskOfAllowedTools` 删除测试也清理。

### Cross-layer integration（重点 — 见 [feedback_cross_layer_integration_tests.md](../../memory/feedback_cross_layer_integration_tests.md)）

- (1) `autoApproved: true` 字段从 SW emit→panel 接收→AgentStepCard 渲染端到端无丢字段。
- (2) skipPermissions=true 时 high-risk + low-risk + skill_call 串联，DisplayMessage 序列正确，无 pending→ok 中间态。
- (3) skipPermissions=false 时 R10 不再触发：mock `author='agent' + firstRunConfirmedAt=undefined` skill 调用，不应有对应 confirm-request 事件给 panel。
- (4) Toggle 切换不影响 in-flight 任务：任务启动时 false，跑到一半 storage.set 改 true，high-risk 步骤仍弹卡。
- (5) Chat banner 在 storage onChanged 改 true 后实时显示；改 false 后消失。

### 留下来护栏的正向回归

- `untrusted_*` wrapper 在 skipPermissions=true 时仍包 page snapshot。
- K-9 close_tabs locked pin 拒绝在 skipPermissions=true 时仍触发。
- R7 cross-session lock 在 skipPermissions=true 时仍拒写。
- skipPermissions=false 时 `create_skill`/`update_skill` 高风险卡仍弹，仅 `allowedTools` 字段从卡上消失。

### Manual browser E2E

- 默认状态：跑 click submit → 弹卡；reject → task 终止。
- Settings 打开 toggle → 一次性 modal → 确认 → toggle ON。
- Chat header 出现 banner。
- 同一 click submit 任务再跑 → 不弹卡，agent-step 卡有 `auto-approved by skip-permissions`。
- Skill A 内部调 Skill B（手填 promptTemplate） → 成功执行无 R2/R3 错误。
- Settings 关 toggle → banner 消失 → click submit 又弹卡。
- 任务跑到一半切 toggle → in-flight 步骤行为不变。
- 老数据兼容：手动 `chrome.storage.local.set` 一个老 skill（带 `allowedTools`），SkillsList 正常显示、调用、保存（保存后 `allowedTools` 字段消失）。
- `pnpm test` + `pnpm build` 全绿。

## Risk / Trade-off Discussion

**主要让步**：Change 1 之后，K-3 capability-grant 防御链失效。具体含义——

- 老语义：用户 approve 一次 `create_skill` → R10 first-run confirm → 之后 agent 用 `update_skill` 加入新 tool 会因 `allowedTools` 变更触发 R10 重新弹卡（"看到新增了什么 tool"）。
- 新语义：用户 approve 一次 `create_skill` → 之后 skill 内可调任何当前注册的 tool；`update_skill` 仅在改动 promptTemplate / parameters 时弹卡（仍是高风险），但用户从卡上看不到"这个 skill 现在能做什么 tool"——只能从 promptTemplate 文本推断。

补偿措施——

- `create_skill`/`update_skill` 自身的高风险卡保留，仍是用户审查 promptTemplate / parameters 的入口。
- skipPermissions 默认关 + 一次性 modal——用户开"yolo 模式"是显式知情决策。
- `untrusted_*` wrapper 数据流防御保留，恶意页面内容无法直接以 system 指令污染 LLM。

**已知 known unknown**：

- skipPermissions=true 模式下 prompt-injection 攻击的实际暴露面**显著扩大**。这是用户接受的折中（issue 原文意图）。我们不在本 phase 加新一层防御（如自动 sanitize page content），那是另一个 brainstorm 的问题。

## Out of Scope（未来可单独提）

- Per-skill `trusted` 字段实现 granular 模式（issue #26 的备选方案，本 phase 不做）。
- Per-tool / per-domain 信任记忆（"在 example.com 上 click submit 不再问"）。
- skipPermissions 模式下的 audit log 持久化（每次自动批准的工具调用打到一份独立 log）——本 phase agent-step UI 上的 `auto-approved` 标记已是事后审计入口。

## References

- Issue #26 — 原始诉求
- `docs/solutions/2026-05-01-llm-capability-grant-invariants.md` — K-3 防御链原始设计（被本 phase 显式弃用）
- `docs/brainstorms/2026-05-01-skill-autonomous-crud-requirements.md` — Phase 2.6 Skill CRUD requirements（R2/R3/R10 出处）
- `docs/plans/2026-05-01-001-feat-skill-autonomous-crud-plan.md` — Phase 2.6 plan（P1-F/P1-G/G-1 gate 出处）
