---
date: 2026-05-01
topic: skill-autonomous-crud
---

# Skill 自主 CRUD（Skill 升级为可扩展能力地基）

## Problem Frame

Phase 2 完成后 Skill 框架是只读的 prompt-template wrapper：用户可在 Settings 切开关、点 Run，但既不能在 UI 手动 CRUD，也不能让 agent 自己创建/编辑/删除 skill；handler 只渲染一段提示词作为 observation 回 LLM，没有方式描述"这条 skill 应该用哪些 tool 工作"。

这阻塞了两件事：

- **用户视角**：BYOK 用户希望让 agent 把"我经常做的工作流"持久化为可复用 capability，但当前 UI 只能开关内置 skill。
- **架构视角**：标签管理（计划中的 Phase 3）等"扩展模块"和已有的"对话/执行"主线只是功能列表上并列，不能用统一的 skill 抽象表达；每个新模块都要单开运行时。

本 brainstorm 把 Skill 升级为 **first-class extension surface**——让用户/agent 都能 CRUD skill，且让 skill 比现在的 prompt wrapper 多承担"指定可调 tool 子集（受 loop 强制）"这一层结构。Phase 3 标签管理在本 phase **不交付**，且在当前"tabId+origin pinning"的安全模型下也不只是"加一组 chrome.tabs.* 工具"那么简单（详见 Key Decisions / Scope Boundaries）；本 phase 完成后，**Skill schema 已 ready** for 跨 tab 能力，但**跨 tab 的安全模型重新设计**留 Phase 3 自身解决。

二级议题（Checkpoint & resume）作为粗 outline 单独放到附录，留给独立 brainstorm 展开。

## Requirements

### Skill Schema 升级（Workflow / Tool-Composition Skill）

- R1. SkillDefinition 在既有字段（id / name / description / toolSchema.parameters / promptTemplate / enabled / builtIn）基础上新增：
  - `author: 'user' | 'agent'`：创建来源
  - `createdAt: number`（ms timestamp）：用于 SkillsList 排序与事后审计
  - `allowedTools: string[] | null`：限定 skill 触发时 agent 可调的 tool 名白名单；`null` 表示不限制（与现有行为兼容）
- R2. **Loop 层强制 enforcement（非装饰）**：skill 被触发进入"skill 作用域"后，loop 在 dispatch 每个 tool_call 前查 `current_skill_scope.allowedTools`：若 tool 名不在白名单，loop **拒绝**该 tool_call 并向 agent 返回 observation `"tool '<name>' not allowed in skill '<skill_id>' scope"`。skill 作用域随 skill 触发 tool_call 入栈，随对应 observation 返回出栈（嵌套已被 R3 禁止）。
- R3. Skill **不能** 调用其他 skill（不允许递归 / 嵌套），防止环路与复杂度爆炸。

### Agent Meta Tools（Skill CRUD via tool-call）

- R4. 新增 4 个 meta tools 注册到 BUILT_IN_TOOLS：
  - `create_skill(definition)` —— 写入新 skill；`id` 由系统生成，`author` 强制为 `'agent'`，`createdAt` 由 handler 写入
  - `update_skill(id, patch)` —— 编辑既有 skill 的 `description` / `promptTemplate` / `toolSchema.parameters` / `allowedTools`；不允许改 `id`、`author`、`builtIn`
  - `delete_skill(id)` —— 删除非 built-in skill
  - `list_skills()` —— 返回所有 skill 的 `id / name / description / author / enabled`（让 agent 决定要新建还是复用）
- R5. `create_skill` 与 `update_skill` 走 **high risk → confirm 卡**：每次调用都需用户显式确认；confirm 卡内容含 raw `promptTemplate` 与 `parameters schema`（informed approval 需要内容可见性，沿用 Phase 2.5 confirm 通道）。**风险等级在 confirm 时也读 `allowedTools`**：白名单中包含至少一个高风险 tool（例如 `dispatch_keyboard_input`、未来的 `chrome.tabs.remove` 等）则整体 high；纯低风险（`scroll` / `extractData` / `done`）的具体降级策略留 plan。
- R6. `delete_skill` 走 **low risk**（删除是收敛动作，blast radius 不会扩大；用户可在 SkillsList 直接恢复或重建）。
- R7. `list_skills` 是 pure read，不参与风险分级。

### Confirm 后立即 enabled

- R8. `create_skill` confirm 通过后：skill 写入 storage 且 `enabled = true` 立即生效，可在同任务后续轮次或下一任务被 agent 直接调用。
- R9. `update_skill` confirm 通过后：保持原 `enabled` 状态不变（用户只同意"这个改动可写入"，不应重置启用状态）。
- R10. **首次执行二次确认（confirm-fatigue 防御）**：`author='agent'` 的 skill 第一次被任意人触发时，loop 在执行前再弹一次 confirm 卡"This skill was authored by the agent at <timestamp>. Confirm first run?"。用户确认后该 skill 标记 `firstRunConfirmedAt`；后续执行不再额外提示，回归常规 risk 流程。

### CRUD UI Surface（Settings 表面）

- R11. SkillsList 升级：提供"新建 skill"按钮 + 每条 skill 的"编辑 / 删除 / 查看完整 promptTemplate"操作。
- R12. SkillsList 每条 skill 必须显示：`name / description / author 标签（user|agent|built-in）/ createdAt / enabled 开关`。Agent 创建的 skill 视觉上与 user / built-in 显著区分（icon / 颜色 / 标签皆可，由 plan 决定具体形态）。
- R13. Built-in skill：可禁用，不可删除，不可编辑（沿用 Phase 2 R22 行为）。
- R14. SkillsList 默认按 `createdAt` 倒序排，让用户第一时间看到 agent 刚创建的 skill 并进行审计。

### Audit & Safety

- R15. 任何 `author='agent'` 的 skill 在 SkillsList 中都附带"Agent created at <timestamp>"标记，可一眼识别。
- R16. promptTemplate 渲染时 `args` 仍包在 `<untrusted_skill_params>` 中（沿用现行机制）；`promptTemplate` 本身不在 untrusted tag 内（它是用户已 confirm 的指令）。本 phase 不引入"agent-authored promptTemplate 也算 untrusted"的额外包装——通过 R5 confirm 卡 + R10 首次执行二次确认 + R12 author 标记把信任决策交给用户。
- R17. agent 调用 `author='agent'` 的 skill 时，`agent-step` metadata 携带 `skillAuthor: 'agent'`，便于 Chat 渲染 / 后续 audit log 筛选。

### Skill 触发模型（沿用 Phase 2）

- R18. 触发方式仅两路：(a) SkillsList 中"Run"按钮手动触发；(b) Agent 在 ReAct 循环中作为 tool 主动选择。**不**引入页面匹配自动触发（沿用 Phase 2 scope boundary）。
- R19. Agent system prompt 中加入"如果识别到用户可能反复做的工作流，可考虑调 `create_skill` 持久化"的鼓励文案；具体文案与 few-shot 例子留 plan。

## Success Criteria

- 用户可在 Settings 手动创建一条 skill（名称 / promptTemplate / allowedTools / parameters），保存后可在 Chat "Run" 触发。
- Agent 可在任务中调 `create_skill` 提议一条新 skill；confirm 卡正确显示 raw promptTemplate 与 parameters；用户 confirm 后该 skill 立即出现在 list 并可被后续 agent 调用。
- 用户在 SkillsList 一眼能区分 built-in / user / agent 三种 skill 来源。
- Loop 层 enforce `allowedTools`：skill 作用域内若 agent 试图调白名单外 tool，被 loop 拒绝并返回 observation；测试中此防线可观测、可日志化。
- `author='agent'` 的 skill 首次执行触发二次 confirm；后续执行不再额外提示。
- **Schema-ready, not loop-ready for cross-tab**：本 phase 完成后，`allowedTools` 字段已能引用任意 tool 名（包括将来要加的 `chrome.tabs.*`），但跨 tab 任务的 origin / blast radius 安全模型 **未** 在本 phase 解决；Phase 3 仍需自己设计。

## Scope Boundaries

- **不含** chrome.tabs.* 原生 tools，也不含跨 tab 安全模型重设计（留 Phase 3）。
- **不含** skill 自动页面匹配触发（沿用 Phase 2）。
- **不含** skill 互调 / 嵌套（R3）。
- **不含** skill version 历史 / migration（YAGNI；编辑直接覆盖）。
- **不含** skill 共享 / 导出 / marketplace（私有 only，单用户）。
- **不含** "draft / quarantine" 中间态（已决定 confirm 后立即 enabled，靠 R10 首次执行二次确认补防御）。
- **不含** Checkpoint 完整交付（仅附录 outline，独立 plan）。

## Key Decisions

- **Workflow / composition skill，非 code skill**：Voyager 式 agent 内嵌 JS 在 BYOK + 多 provider + LLM 输出不可控的语境下风险过高；skill 抽象保持为"prompt + 限定 tool 子集"，原生能力始终走 BUILT_IN_TOOLS。
- **`allowedTools` 由 loop 强制 enforce，不是装饰**：白名单若仅靠 prompt 提示就退化成 prompt-only tier。loop 拦截白名单外 tool_call 是把"workflow skill"这层抽象**真正落到运行时**的关键——也使 R5 的 risk 推断（按白名单中最高风险 tool）变成真信号。
- **CRUD 双通道，单一 storage**：用户 UI 与 agent meta tools 写同一份 `chrome.storage.local`，共用 confirm 通道；不为两种来源开两套表面。
- **agent 创建的 skill confirm 后立即 enabled，但首次执行二次 confirm**：体验优先；以风险分级 + author 标记 + createdAt 排序前置审计；显式承认 **confirm-fatigue 风险存在**，用 R10 把第二道关卡放到"真正执行点"而不是"创建点"，使 fatigue 上限是每条 skill 1 次而不是 N 次。`update` 仍走 confirm 防"已存在 skill 被改恶意版本"。
- **本 phase 是 schema-ready 而非 loop-ready for 跨 tab**：现行 `loop.ts:266` 每轮校验 pinned tab origin 不变；该机制不会自动拦截 `chrome.tabs.query` / `chrome.tabs.remove(otherTabId)` 这类不依赖 pinned tab 的调用，但 pinning 的**设计意图**是把 agent 限定在单 tab 内活动。引入跨 tab 工具等于在 pinning 安全边界外开口子，需要 Phase 3 自己重设计（per-tab confirm 模型 / 跨 tab blast radius 限制 / activeTab 转换协议）。本 phase 不解决该设计，因此 success criterion 明确为"schema-ready"。
- **不引入 skill 互调**：防止环路 / 复杂度爆炸；未来若有需求，单独 brainstorm。
- **page-match 自动触发依然延后**：与 Phase 2 决策一致，避免 prompt-injection-by-page 路径与 skill 升级同时引入。

## Dependencies / Assumptions

- Phase 2 的 risk classifier、confirm 卡、`<untrusted_*>` tag、port 协议可直接复用，无需重构（已 audit `risk.ts` / `loop.ts` / `background/index.ts:251`，假设成立）。
- 现行 `skill_<id>` 键命名空间够用；新字段（`author` / `createdAt` / `allowedTools` / `firstRunConfirmedAt`）向后兼容（旧 skill 缺失字段按 default：author='user'，createdAt=0，allowedTools=null，firstRunConfirmedAt=undefined）。
- 多 provider tool-calling 都能容纳新增 4 个 meta tool 的 schema，无需新增 provider 适配代码。
- 用户接受"agent 创建的 skill 立即生效 + 首次执行二次 confirm"的安全模型；如未来用户反馈过激进，可平滑切到三态模式（draft / enabled / disabled）。

## Outstanding Questions

### Resolve Before Planning

- 无（核心产品决策已收敛）。

### Deferred to Planning

- [Affects R1 / R5][Technical] `allowedTools` 是扁平数组还是按风险类别分组？分组能让 R5 的 risk 推断更精细。
- [Affects R2][Technical] Loop 拒绝白名单外 tool_call 后的 observation 文本格式 + agent 是否需被允许 retry / break out of skill scope；skill 作用域出栈条件的具体 trigger（`done` tool / 显式 `exit_skill` / 第 N 步限制）。
- [Affects R5][Technical] confirm 卡 `promptTemplate` 的展示格式——raw / 高亮 `{{placeholder}}` / 折叠展开；redaction 截断阈值（500 字符是 Phase 2.5 经验值，meta tools 是否需不同）。
- [Affects R12][Needs research] author 视觉区分的具体形态（icon set 是否新增？是否引入第二种排序：按 author 分组）。
- [Affects R11 / R14][Technical] 编辑 form 字段实现：本 phase 暂用纯 textarea + 客户端 zod 校验，是否在 plan 阶段评估升级为 visual schema 编辑器；JSON 校验失败的回退路径。
- [Affects R10][UX] 首次执行二次 confirm 卡的视觉与文案细节（既要让用户严肃 review，又不能反复打断同一条 skill）。
- [Affects R19][Needs research] system prompt 中鼓励 agent "适度" 创建 skill 的文案 + few-shot 例子（需 LLM 反馈调整避免滥用）。
- [Affects all][Needs research] dogfooding 路径——用 agent 创建一条"提取页面表格 → JSON"的 skill，跑通 Create / Edit / Delete 三条路径在飞书 / Notion / 普通页面是否都健康。

## Next Steps

→ `/ce:plan` 推进 Skill 自主 CRUD 主交付（primary）
→ Checkpoint & resume 作为独立 brainstorm（`/ce:brainstorm checkpoint-resume`）展开附录中 C1–C5。

---

## Appendix: Checkpoint & Resume — Outline (Secondary, Outline 级)

二级议题，**不计入** primary success criteria；列出 outline 是为了在 Skill schema 设计阶段为它预留位置，避免主交付完成后 checkpoint 路径被锁死。

- C1. 任务级 checkpoint：每个 agent step 完成后把 `{ task, modelConfig, agentMessages, pinnedTabId, pinnedOrigin, lastStepIndex, currentSkillScope? }` 序列化到 `chrome.storage.local`，键形如 `agent_checkpoint_<taskId>`。
- C2. SW 重启 / Side Panel 重新打开时检测未完成 checkpoint，向 Chat 推送"上一个任务被中断，是否继续 / 丢弃"卡片。
- C3. 任务正常 `done` / `fail` / 用户 Stop 时清理 checkpoint。
- C4. Checkpoint 不存 API key；agent 历史中已 redact 字段保持 redact 状态。
- C5. Checkpoint 与 SW keep-alive 的责任划分、resume 卡片在 Chat 中的具体形态、与"skill 作用域栈"的序列化协议（C1 中的 `currentSkillScope`），均留独立 brainstorm。
