---
title: "feat: Skill 自主 CRUD 升级（Skill 作为 first-class 扩展能力）"
type: feat
status: completed
date: 2026-05-01
deepened: 2026-05-01
origin: docs/specs/2026-05-01-skill-autonomous-crud-requirements.md
---

# feat: Skill 自主 CRUD 升级（Skill 作为 first-class 扩展能力）

## Overview

把 Skill 框架从只读的 prompt-template wrapper 升级为 **first-class extension surface**：

- SkillDefinition 增加 `author` / `createdAt` / `allowedTools` / `firstRunConfirmedAt` 字段
- 新增 4 个 meta tools（`create_skill` / `update_skill` / `delete_skill` / `list_skills`）注册到 BUILT_IN_TOOLS，让 agent 能 CRUD skill
- ReAct loop 在 dispatch 每个 tool_call 前 enforce skill 作用域白名单（loop-level，不是 prompt-level 装饰）
- Agent-authored skill 首次执行二次 confirm，防 confirm-fatigue
- SkillsList UI 升级为可手动 CRUD（author 视觉区分、按 createdAt 倒序、可编辑/删除非 built-in）

本 plan 不交付 chrome.tabs.* 原生 tools 与跨 tab 安全模型重设计——这些留 Phase 3 自己解决（origin 文档已明确 scope-ready, not loop-ready for cross-tab）。Checkpoint & resume（origin 附录 C1–C5）作为独立 brainstorm，不在本 plan 内。

## Problem Frame

Phase 2 完成后 Skill 框架是只读 prompt-template wrapper：

- 用户视角：只能在 Settings 切开关、点 Run，不能手动 CRUD；agent 也不能自己增长 skill 库
- 架构视角：每个新模块（如 Phase 3 标签管理）都要单开运行时；skill 作为"扩展能力地基"的设想没兑现

origin 文档的核心决策已收敛（见 `docs/specs/2026-05-01-skill-autonomous-crud-requirements.md`）：workflow / tool-composition skill、双通道 CRUD、confirm 后立即 enabled + 首次执行二次 confirm。本 plan 把这些决策落到具体文件、改动序列、verification scenarios 与**capability-grant 安全模型的关键 invariants**（经 security-sentinel review 后强化）。

## Requirements Trace

源自 `docs/specs/2026-05-01-skill-autonomous-crud-requirements.md`：

- R1. SkillDefinition 增加 `author` / `createdAt` / `allowedTools` 字段（本 plan 还会增 `firstRunConfirmedAt` 支撑 R10）
- R2. **Loop 层强制 enforcement**：dispatch 前查 `current_skill_scope.allowedTools`，白名单外拒绝并返回 observation
- R3. Skill 不能调用其他 skill（不允许嵌套 / 递归）
- R4. 新增 4 个 meta tools 注册到 BUILT_IN_TOOLS
- R5. `create_skill` / `update_skill` 走 high risk → confirm 卡显示 raw 内容；风险等级读 allowedTools 推断
- R6. `delete_skill` 走 low risk
- R7. `list_skills` pure read，不参与风险分级
- R8/R9. confirm 后 create 立即 enabled / update 保持原 enabled
- R10. agent-authored skill 首次执行二次 confirm（持久化 `firstRunConfirmedAt`）
- R11–R14. SkillsList 升级：新建按钮、CRUD 操作、author 标签、createdAt 倒序、built-in 不可改
- R15–R17. author 标签 / promptTemplate 不另套 untrusted tag / agent-step `skillAuthor` 字段
- R18. 触发方式仅 manual run + agent tool-call（不引入 page-match）
- R19. system prompt 加鼓励 agent 创建 skill 的文案

参见 origin 中"Success Criteria"段：本 plan 的 acceptance 以那一段为准。

## Scope Boundaries

- **不含** chrome.tabs.* 原生 tools 与跨 tab 安全模型重设计（留 Phase 3）
- **不含** skill 自动页面匹配触发
- **不含** skill 互调 / 嵌套（R3 + Loop 强制拒绝）
- **不含** skill version 历史 / migration（直接覆盖；author taint 取代历史链）
- **不含** skill 共享 / 导出 / marketplace
- **不含** parameters schema 可视化编辑器（纯 textarea + inline JSON.parse 校验）
- **不含** "draft / quarantine" 中间态（confirm 后立即 enabled，靠 R10 防御）
- **不含** Checkpoint 实施（origin 附录 C1–C5 单独 brainstorm）
- **不含** 引入测试框架（项目无测试基础设施；本 plan 用 manual verification scenarios，不要求新增 vitest/jest）
- **不含** **跨 phase capability forward-compat**：`allowedTools` 中的 tool 名必须在 confirm 时已注册；未来 phase 新增 tool 不会被老 skill 自动激活——若 skill 想使用未来 tool，需重新 update_skill 触发新 confirm（详见 P1-G mitigation）

## Context & Research

### Relevant Code and Patterns

- `src/lib/agent/loop.ts:439-578` — tool_call dispatch 主循环。Skill scope 检查的最小侵入插点：tool 查找之后（line 441）、risk 分级之前（line 476）
- `src/lib/agent/loop.ts:340-349` — 每轮 `allTools` 重组：`[...BUILT_IN_TOOLS, ...skillTools, ...keyboardTools]`。Meta tools 走 BUILT_IN_TOOLS 进入此处
- `src/lib/agent/loop.ts:115-125` — `redactArgsForPanel`：当前只对 keyboard tools 截 text。其他 tool args 原样推流
- `src/lib/agent/risk.ts:57` — `classifyRisk(toolName, args, snapshot): RiskAssessment`。简单 switch on toolName，meta tools 在文件顶部分支
- `src/lib/agent/prompt.ts:39` — `buildAgentSystemPrompt(task, hasKeyboardTools = false)`。R19 鼓励文案以新增 `hasMetaTools` optional 参数注入
- `src/lib/agent/tools.ts:45-208` — `BUILT_IN_TOOLS` 静态数组。Meta tools 直接 append
- `src/lib/skills/types.ts:3-22` — `SkillDefinition` interface
- `src/lib/skills/storage.ts:16-71` — CRUD primitives + `enabled_skills` whitelist+blacklist 语义
- `src/lib/skills/storage.ts:33` — `saveSkill` 当前**不检查 builtIn**，写 `skill_<id>` 不区分（这是 P0-A 漏洞的根源；本 plan 在 meta tool handler 层兜底拦截，不改 saveSkill 签名）
- `src/lib/skills/index.ts:22-39` — `getAllSkills`：user-stored skill 通过 id 覆盖 BUILT_IN_SKILLS（这是 P0-A 漏洞的物化路径）
- `src/lib/skills/index.ts:48-101` — `getEnabledSkills` + `resolveSkillToTools`：handler 渲染 promptTemplate 文本作 observation。本 plan 不改这部分
- `src/lib/skills/builtin.ts:3-30` — `BUILT_IN_SKILLS`。新字段在此处显式补默认值
- `src/sidepanel/components/SkillsList.tsx` — 当前 React 模式：`useState<SkillDefinition[]>` + `useEffect` mount 加载 + 改动后 `await loadSkills()` re-render
- `src/sidepanel/components/Settings.tsx:17-43, 98-103` — form state pattern：`useState<Record>` + spread update
- `src/sidepanel/components/AgentConfirmCard.tsx` — confirm 卡 UI：`safeStringifyArgs(args, 2000)` 当前 cap 2000 char。**Meta tools 必须绕过此 cap**（P0-D），见 Unit 2
- `src/types/messages.ts:64, 74-81` — `AgentStepMessage.args: unknown` 与 `AgentConfirmRequestMessage`。`skillAuthor?: 'agent' | 'user' | 'builtIn'` 加在 AgentStepMessage
- `src/background/index.ts:251-255` — skill 注入点。本 plan **不动**这里；meta tools 走 BUILT_IN_TOOLS

### Institutional Learnings

`docs/solutions/` 仅有 1 条与本议题不直接相关的 Phase 2.5 spike verdict（CDP keyboard），无可复用 prior learnings。本 plan 主要参考 Phase 2 / 2.5 pattern：

- Phase 2.5 redaction 二分通道（confirm 显原文 / agent-step redact）的设计原则用于 meta tools 时**反向应用**——meta tool 的 confirm 必须**完全无截断**显示，agent-step 才走截断（与 keyboard tool 相反，因 raw promptTemplate 才是信任决策内容，见 P0-D）
- Phase 2 risk classifier + confirm 卡协议（pendingConfirmations Map + AgentConfirmRequest/Response）天然支撑 meta tools，不重写

### External References

跳过外部研究：项目内 ReAct loop / risk classifier / confirm 卡 / skill resolveSkillToTools 已有 3+ 直接 pattern 示例；本议题不属于 high-risk 外部领域；产品决策已在 brainstorm 拍板。

## Key Technical Decisions

- **`allowedTools` 用扁平 `string[]`，不分组**：R5 风险推断只需"白名单中最高风险 tool"——加一个 helper `riskOfAllowedTools(names)` 即可，无需 schema 增加分类层。YAGNI。
- **`allowedTools` 写入路径必须 non-null array（P1-F）**：`create_skill` / `update_skill` 的 JSON Schema 把 `allowedTools` 标 `required: true`，type=`array`（不接受 `null`）；空数组 `[]` 合法（仅 `done` / `fail` 可调）。`null` 仅用于读取兼容老 skill。否则 R2 在新写路径上沦为 voluntary。
- **Schema-string trust boundary（P0-B）**：`parameters` JSON Schema 中的 `description` / `enum` / `default` / `examples` / `title` 等字符串与 `promptTemplate` 同等地位——它们也会进每轮 LLM 的 tool 定义里，是永久 system-level injection 面。
  - confirm 卡必须**完整显示** raw promptTemplate **以及** parameters schema（不仅是 promptTemplate）
  - 同样不另套 `<untrusted_*>` 包装（信任由 confirm 决策授予，与 promptTemplate 同处理）
  - 写入路径强制 schema-string 总长度上限：所有字符串字段累计 ≤ **2 KB**（保证 confirm 卡认知负担可控）；超出 → ActionResult error
- **Meta tool confirm 卡不走 2000-char cap（P0-D）**：`AgentConfirmCard` 渲染 meta tool args 时**绕过** `safeStringifyArgs(args, 2000)` 的 cap，全文 + scrollable 显示 promptTemplate / parameters / allowedTools。`agent-step` 推流仍可走 cap（agent-step 不是信任决策面）。
  - 配套：`create_skill` / `update_skill` handler 强制 `promptTemplate` 长度 ≤ **8 KB**；超长 → ActionResult error。combine 8 KB promptTemplate + 2 KB schema = confirm 卡显示量约 10 KB，可滚动审查。
- **author taint propagation（P0-C，选 Option A）**：`update_skill` 写入时**强制把 author 改为 'agent'**（以及 `firstRunConfirmedAt = undefined`），不论原 author 是 user 还是 agent。SkillsList chip 区分原始作者：当 author='agent' 但有迹象（如 `originalAuthor` 字段或 createdAt 早于 confirm 历史）显示 "Originally user · last edited by agent on \<date\>"，但本 plan 选最简方案——只保留 `author` 单字段，update 后即变 agent，UI 不区分"被改"与"创建"。这接受 author 含义从"originator"变为"last-mutated-by"的语义漂移，换取 R10 gate 完整覆盖。
- **Skill scope 入栈/出栈协议**：
  - **入栈**：`tc.name` 命中 skill-resolved set + handler **执行成功**（ActionResult.success === true）后 `currentSkillScope = { skillId, allowedTools }`
  - **出栈**：（a）agent 调 `done` / `fail` —— 自然终止；（b）agent 调另一 skill tool —— 已被 R3 anti-nest 在 enforce 阶段拒绝，不可达
  - 实现：`runAgentLoop` 内部 `let currentSkillScope: SkillScope | null = null` 局部变量；不入 `AgentLoopContext`；不持久化（task 即焚）
- **Loop 拒绝白名单外 tool_call 的协议**：直接构造 ActionResult error `tool '<name>' not allowed in skill '<skillId>' scope. Allowed: [<list>]`，跳过 risk classify + handler；推 agent-step `status: 'error'`；agent 看到后可在 allowedTools 内重选或调 done/fail。
- **R3 嵌套禁止 = 同一通道**：scope 激活时若 agent 调 skill-resolved set 中的 tool（即另一条 skill）—— 直接走拒绝路径，error: `Skills cannot call other skills`；该检查**优先于** allowedTools 检查。
- **`allowedTools` 写入时 name validation（P1-G）**：handler 校验 `allowedTools` 中每个 name 必须**当前已注册**（即位于 `BUILT_IN_TOOLS` ∪ `getEnabledSkillTools()` minus skill-resolved（防 R3 自指）∪ `keyboardTools` if enabled）。未注册 name → ActionResult error `unknown tool: <name>`。
  - 防"今天 confirm 一个 'some_future_tool' 名字 → Phase 3 ship 该 tool 时自动激活"的 capability creep
- **R5 风险推断 helper**：`riskOfAllowedTools(names)` 实现：每个 name 查 keyboard tools 名集合（→ high）/ classifyRisk 静态规则（如 keyboard、submit-类、navigation → high）→ 返回 max；本 phase 暂不在 `create_skill` 路径调它（仍 hardcode high），但 export 该 helper 为后续切降级铺路。
- **author='agent' 强制由 handler 写入**：`create_skill` 接收的 args 即便包含 `author` 字段也被覆盖为 `'agent'`；`update_skill` 同样覆盖为 `'agent'`（taint propagation）；`builtIn` / `id` / `firstRunConfirmedAt` 不允许 patch。
- **`firstRunConfirmedAt` 写入时机**：R10 二次 confirm 通过后 → **先 saveSkill 写时间戳 → 再放行 handler 执行**。如 storage 写入失败：log 错误但放行 handler（fail-open，避免双重 confirm 死锁；下次仍会触发二次 confirm 直到写成功）。
- **chrome.storage.local 配额预算（P1-H）**：`create_skill` / `update_skill` handler 在写入前计算所有 `skill_*` key 的字节总和 + 待写入 payload；超过预算（**1 MB**，留 4 MB 给 provider 配置 / agent 状态 / 未来 checkpoint）→ ActionResult error `skill storage quota exceeded`。SkillsList 底部显示用量条 "X KB / 1 MB used by skills"。
- **prompt builder R19 文案**：以一段简短指导 + 1 例 few-shot（"如果你识别用户反复让你做相似的页面提取/填写动作，可调 create_skill 把这个工作流持久化"），不超过 200 token。
- **不引入测试框架**：项目当前无 vitest / jest 与任何 *.test.* 文件；本 plan 不打破这状态。"test scenarios" 在每个 unit 下作为 **manual verification scenarios** 写出。

## Open Questions

### Resolved During Planning

- **`allowedTools` 形态**（origin Deferred Q1）：扁平 `string[]`；写入路径 required + non-null；读取 `null` 仅向后兼容老 skill
- **拒绝后 observation 文本格式 / scope 出栈**（origin Deferred Q2）：直接 ActionResult error；scope 仅 done/fail 退；R3 已禁止嵌套
- **confirm 卡 promptTemplate 展示 + 截断阈值**（origin Deferred Q3）：raw text + parameters schema 全文 + 不走 2000-char cap；handler 强制 promptTemplate ≤ 8 KB / schema strings 累计 ≤ 2 KB
- **author 视觉区分**（origin Deferred Q4）：标签 + 颜色 accent（agent = 紫色 border-l-4，user = 蓝色，built-in = 中性灰）
- **form 字段实现**（origin Deferred Q5）：纯 textarea + inline 校验（name / parameters JSON / promptTemplate / allowedTools 必填）
- **R10 卡文案**（origin Deferred Q6）：示意 "This skill was authored or last modified by the agent on `<date>`. This is its first execution since modification. Confirm to allow run?"
- **R19 鼓励文案**（origin Deferred Q7）：plan 中给 200-token 范本（见 Unit 6）

### Deferred to Implementation

- **手动 verification 路径运行环境**：`pnpm dev` 启服务后挂载到 `chrome://extensions` 的具体步骤已在 README/CLAUDE.md
- **author 视觉的最终色值**：plan 给方向，UI 实现期可微调
- **R19 鼓励文案的精确措辞**：plan 给 draft，实施期跑过几个 LLM 反馈后调
- **Chat UI 是否高亮 agent-authored skill 调用**：本 plan 仅往 message 加 skillAuthor 字段；高亮渲染是 nice-to-have
- **未来 R5 风险降级**：当前 hardcode high；future 调用 `riskOfAllowedTools` 替换
- **storage 配额耗尽时的 SkillsList UX**：plan 要求显示用量条；红色警告 / 强制清理 UI 的细节留实施期

## High-Level Technical Design

> *本节示意 skill scope 状态机与 dispatch 决策流，作为评审方向性 guidance，不是实现规范。*

```
                 ┌─────────────────────────────────────────────┐
                 │           runAgentLoop (per task)            │
                 │   currentSkillScope: SkillScope | null = null│
                 └─────────────────────────────────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │  for each tool_call tc in step:             │
                │                                             │
                │  1. tool = allTools.find(name === tc.name)  │
                │     ↓ not found → error obs + continue      │
                │                                             │
                │  2. ── SCOPE ENFORCE (NEW) ────────────────│
                │     if currentSkillScope !== null:          │
                │       if tc.name in skillResolvedNames:     │
                │         → reject (R3 anti-nest)             │
                │       elif scope.allowedTools !== null AND  │
                │            tc.name not in allowedTools:     │
                │         → reject (R2 enforce)               │
                │     ↓ rejected → ActionResult error         │
                │                  → agent-step status=error  │
                │                  → continue                 │
                │                                             │
                │  3. classifyRisk(name, args, snapshot)      │
                │  4. if high → confirm card → wait approval  │
                │     (meta tool confirm bypasses 2000-cap)   │
                │  5. ── R10 FIRST-RUN GATE (NEW) ───────────│
                │     if name in skillResolvedNames AND       │
                │        skill.author==='agent' AND           │
                │        !skill.firstRunConfirmedAt:          │
                │       → first-run confirm card              │
                │       → on approve: saveSkill({firstRun...})│
                │  6. tool.handler(...) → ActionResult        │
                │  7. ── SCOPE TRANSITION (NEW) ─────────────│
                │     if name in skillResolvedNames AND       │
                │        result.success === true:             │
                │       currentSkillScope = {                 │
                │         skillId: name,                      │
                │         allowedTools: skill.allowedTools    │
                │       }                                     │
                │     if name === 'done' || name === 'fail':  │
                │       (loop terminates; scope discarded)    │
                │  8. agent-step status=ok + observation      │
                └─────────────────────────────────────────────┘
```

要点：
- `currentSkillScope` 是 task-scoped 局部变量，不写入 `AgentLoopContext` 或 storage
- 入栈/出栈对原 dispatch 的 5 个核心步骤是**插入**，不重构
- "skill-resolved tool" 识别：每轮缓存 `Set<string>` of `skillTools.map(t => t.name)`

## Implementation Units

- [ ] **Unit 1: Skill schema 扩字段 + storage 后向兼容**

**Goal:** SkillDefinition 加 4 个新字段并保证旧 storage 数据无缝读取。

**Requirements:** R1, R10

**Dependencies:** 无

**Files:**
- Modify: `src/lib/skills/types.ts` —— `SkillDefinition` 加 `author?: 'user' | 'agent'`、`createdAt?: number`、`allowedTools?: string[] | null`、`firstRunConfirmedAt?: number`（全部 optional）
- Modify: `src/lib/skills/storage.ts` —— `listUserSkills` / `getSkill` 读取后过 `withSkillDefaults(skill)` 函数填默认（`author='user'`、`createdAt=0`、`allowedTools=null`、`firstRunConfirmedAt=undefined`）；新增 `generateSkillId(): string` 助手，返回形如 `skill_agent_<crypto.randomUUID()>` 的字符串（前缀防与 BUILT_IN_TOOLS / skill name 冲撞）
- Modify: `src/lib/skills/builtin.ts` —— `BUILT_IN_SKILLS[0]` 显式补 `author: 'user'`、`createdAt: 0`、`allowedTools: null`
- Modify: `src/lib/skills/index.ts` —— `getAllSkills` / `getEnabledSkills` 链路确保 `withSkillDefaults` 应用一次

**Approach:**
- 字段全 optional + 单一 `withSkillDefaults` 助手函数：避免 migration script
- `generateSkillId()` 用 `crypto.randomUUID()`（Web Crypto API，SW 已可用）+ `skill_agent_` 前缀
- 不改 `enabled_skills` 数组语义；不引入新存储 key

**Patterns to follow:**
- 沿 `src/lib/skills/storage.ts:16-31` 直读模式
- 沿 `src/lib/skills/index.ts:22-39` merge 模式

**Test scenarios:**
- *Happy path*: 老格式 skill（无新字段）→ reload 后 `getAllSkills()` 上 `author === 'user'` & `createdAt === 0` & `allowedTools === null`
- *Happy path*: 新建一条 user skill 含完整字段 → 持久化后再读字段全保留
- *Edge case*: storage 中老 / 新格式共存 → 都正确返回字段
- *Edge case (id 冲撞)*: `generateSkillId()` 调 100 次结果全唯一且都以 `skill_agent_` 开头

**Verification:**
- `pnpm build` 通过 TS 严格类型检查
- chrome://extensions reload 后旧用户的 enabled_skills + skill_<id> 数据可读

---

- [ ] **Unit 2: 4 个 meta tools 注册到 BUILT_IN_TOOLS（含全套 capability-grant 防御）**

**Goal:** `create_skill` / `update_skill` / `delete_skill` / `list_skills` 作为 BUILT_IN_TOOLS 项目的最末 4 条；handler 内置 P0-A / P0-B / P0-C / P0-D / P1-E / P1-F / P1-G / P1-H 的全套防御。

**Requirements:** R4, R8, R9, R15

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/agent/tools.ts` —— `BUILT_IN_TOOLS` 数组末尾追加 4 个 Tool 对象
- Modify: `src/lib/skills/storage.ts` —— `generateSkillId` 已在 Unit 1；新增 `getSkillStorageBytes(): Promise<number>` 助手用于配额检查

**Approach:**

**`create_skill`**
- JSON Schema：`{ type: 'object', additionalProperties: false, required: ['name', 'description', 'promptTemplate', 'parameters', 'allowedTools'], properties: { name, description, promptTemplate, parameters, allowedTools: { type: 'array', items: { type: 'string' } } } }` —— **明确不含 `id` 属性 + additionalProperties: false**（P1-E）
- handler 校验序列（按顺序，任一失败 → ActionResult error）：
  1. **P1-E** 防 id 注入：即便 schema 被绕过，handler 显式 `delete args.id`；id 必由 `generateSkillId()` 生成
  2. **P0-D 长度上限**：`promptTemplate.length > 8192` → reject "promptTemplate too long (max 8 KB)"
  3. **P0-B schema string 总长**：递归计算 parameters 中所有 string 字段（description/enum/default/examples/title）字符总和 > 2048 → reject "schema strings too long (max 2 KB)"
  4. **P1-F**：`allowedTools` 不是 array 或为 null → reject "allowedTools must be an array (use [] for done/fail-only)"
  5. **P1-G**：每个 `allowedTools[i]` 必须存在于"当前已注册的非 skill-resolved tool name set"（BUILT_IN_TOOLS ∪ enabled keyboard tools，**不含** skill-resolved 的 tool names——R3 自指禁止）→ 任一未注册 → reject `unknown tool: <name>`
  6. **P1-H 配额**：`getSkillStorageBytes() + JSON.stringify(skillToWrite).length > 1_048_576` → reject "skill storage quota exceeded"
  7. 强制 `author='agent'`、`createdAt=Date.now()`、`enabled=true`、`builtIn=false`、`firstRunConfirmedAt=undefined`、`id=generateSkillId()`
  8. `saveSkill(skill)`

**`update_skill`**
- JSON Schema：`{ type: 'object', additionalProperties: false, required: ['id'], properties: { id, patch: { type: 'object', additionalProperties: false, properties: { description, promptTemplate, parameters, allowedTools } } } }`
- handler 校验序列：
  1. `getSkill(id)` 拿到 existing；不存在 → reject "skill not found"
  2. **P0-A**：`existing.builtIn === true` → reject "cannot edit built-in skill"
  3. patch 中存在禁改字段（`id` / `author` / `builtIn` / `createdAt` / `firstRunConfirmedAt` / `enabled`）→ silent strip（不报错，避免 agent 因 schema 不熟整轮失败；但**不写入**）
  4. 长度 / schema string / allowedTools array / name validation / 配额 校验同 create
  5. **P0-C taint propagation**：写入时强制 `author='agent'`、`firstRunConfirmedAt=undefined`（不论原值）；`enabled` 保持原值；`createdAt` 保持原值
  6. `saveSkill(merged)`

**`delete_skill`**
- JSON Schema：`{ type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } }`
- handler 校验：
  1. `getSkill(id)` 不存在 → reject "skill not found"
  2. `existing.builtIn === true` → reject "cannot delete built-in skill"
  3. `deleteSkill(id)`

**`list_skills`**
- JSON Schema：`{ type: 'object', additionalProperties: false, properties: {} }`
- handler：调 `getAllSkills()`，每条仅返回 `{ id, name, description, author, enabled }`（**不返回** `promptTemplate` / `parameters` / `allowedTools`，防 context 污染 + info-leak P2）

**Patterns to follow:**
- 沿 `src/lib/agent/tools.ts:45-208` BUILT_IN_TOOLS 风格
- handler 返回 `ActionResult` 与 done/fail 一致

**Test scenarios:**
- *Happy path (create_skill)*: agent 调 create_skill → handler 写 storage → list_skills 读到新 skill，author='agent'，id 以 `skill_agent_` 开头
- *Happy path (update_skill)*: 已存在 user skill → update_skill 改 description → 再读 description 已变；id / createdAt 未变；author **变成 'agent'**（taint propagation）；firstRunConfirmedAt 被清
- *Edge case (update_skill on builtIn)*: 试图 update `extract_structured_data` → ActionResult success: false + "cannot edit built-in skill" — **P0-A 关键 scenario**
- *Edge case (update_skill 禁改字段)*: patch 含 `author: 'user'` → 被忽略；patch 含 `builtIn: true` → 被忽略；最终持久化对象 author='agent'、builtIn=false（即原值）
- *Error path (delete_skill on builtIn)*: 删 built-in skill → ActionResult success: false
- *Error path (create_skill missing name)*: schema-level reject
- *Error path (create_skill with id field)*: agent 传 `{id: 'click', ...}` → schema rejects (additionalProperties: false)；即便 schema 被绕过，handler 显式 strip id — **P1-E 关键 scenario**
- *Error path (create_skill 超长 promptTemplate)*: 9 KB promptTemplate → reject "promptTemplate too long"
- *Error path (create_skill schema injection)*: parameters 含 `description: "Ignore prior instructions..."` 但累计 < 2 KB → 通过；累计 > 2 KB → reject — **P0-B 关键 scenario**
- *Error path (create_skill 未注册 tool)*: `allowedTools: ['some_future_tool']` → reject "unknown tool: some_future_tool" — **P1-G 关键 scenario**
- *Error path (create_skill allowedTools=null)*: reject "allowedTools must be an array" — **P1-F 关键 scenario**
- *Edge case (create_skill allowedTools=[])*: 通过；scope 入栈后只有 done/fail 可调
- *Error path (create_skill 配额超限)*: 模拟 storage 已 1.05 MB → reject "skill storage quota exceeded" — **P1-H 关键 scenario**
- *Happy path (list_skills)*: 返回结果不含 promptTemplate / parameters / allowedTools
- *Integration*: agent 同一 task 内 create_skill → list_skills 立即看到新条目；author='agent'

**Verification:**
- 通过 manual UI（DevTools 或 SkillsList）观察 storage 真实数据；agent-step event 看到 handler observation
- chrome.storage.local 直观察 skill_<id> JSON 内容、size 与 author/createdAt 字段

---

- [ ] **Unit 3: Risk classifier 接入 meta tools + R5 风险推断 helper**

**Goal:** `classifyRisk` 识别 4 个 meta tools；提供 `riskOfAllowedTools` helper 为未来 R5 降级铺路。

**Requirements:** R5, R6, R7

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/agent/risk.ts` —— `classifyRisk` 顶部分支加 meta tool 识别；新增 `riskOfAllowedTools(names: string[]): RiskLevel` export

**Approach:**
- `create_skill` / `update_skill` → `{ level: 'high', reason: 'Skill 写入会改变 agent 后续可执行的能力' }`
- `delete_skill` → `{ level: 'low', reason: '删除已存在 skill；blast radius 不扩大' }`
- `list_skills` → `{ level: 'low' }`
- `riskOfAllowedTools(names)` 实现：每 name 查 keyboard tool name set / classifyRisk 静态映射 → 取 max；本 phase 不在 create_skill 路径调它（仍 hardcode high）

**Patterns to follow:**
- 沿 `src/lib/agent/risk.ts:57-` switch 风格

**Test scenarios:**
- *Happy path*: `classifyRisk('create_skill', any, snapshot)` → high
- *Happy path*: `classifyRisk('list_skills', ...)` → low
- *Edge case*: `riskOfAllowedTools(['scroll'])` → low
- *Edge case*: `riskOfAllowedTools(['scroll', 'dispatch_keyboard_input'])` → high
- *Edge case*: `riskOfAllowedTools([])` → low（默认）
- *Edge case*: `riskOfAllowedTools(['unknown_tool'])` → low（保守降级避免误升级）

**Verification:**
- 触发 create_skill → loop 进 confirm 卡（人眼验证 confirm 卡显示 raw skill definition + 不被 2000-char clip）
- 触发 list_skills / delete_skill → 直接执行无 confirm

---

- [ ] **Unit 4: Loop 层 enforce allowedTools（核心改动）**

**Goal:** ReAct loop dispatch 前 enforce skill scope；不在白名单 / 嵌套 → 拒绝 + observation。

**Requirements:** R2, R3

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/lib/agent/loop.ts` —— `runAgentLoop` 加 `let currentSkillScope: { skillId, allowedTools: string[] | null } | null = null`；dispatch 块（441-578）加 scope check + 转移逻辑
- Modify: `src/lib/agent/loop.ts` —— allTools 重组后构造 `Set<string>` of skill-resolved names

**Approach:**
- **检查插入位置**：line 441（tool 查找成功后）↔ line 476（risk 分级前）
- **拒绝路径**：构造 `ActionResult { success: false, error: ... }` → 跳过 risk classify + handler → 推 agent-step `status: 'error'` → continue
- **Anti-nest（R3）**：scope 激活时若 `tc.name` 在 skill-resolved set → 拒绝 `Skills cannot call other skills`；优先级高于 allowedTools 检查
- **Scope 入栈**：handler 执行**成功后**（ActionResult.success === true），若 `tc.name` 在 skill-resolved set → `currentSkillScope = { skillId: tc.name, allowedTools: skill.allowedTools ?? null }`
- **Scope 出栈**：done / fail → loop 自然结束；不引入 explicit exit_skill tool
- **scope = null 时所有现有行为不变**（向后兼容老 task）
- **scope.allowedTools = null 时**：scope 仍激活（R3 anti-nest 仍生效）但 allowedTools enforce 直接 pass through（向后兼容老 skill）

**Technical design (directional):**
```
const skillResolvedNames = new Set(skillTools.map(t => t.name));

for (const tc of completedToolCalls) {
  const tool = allTools.find(t => t.name === tc.name);
  if (!tool) { /* existing error path */ continue; }

  // ── SCOPE ENFORCE ──
  if (currentSkillScope) {
    if (skillResolvedNames.has(tc.name)) {
      emitRejection(tc, "Skills cannot call other skills");
      continue;
    }
    if (currentSkillScope.allowedTools !== null
        && !currentSkillScope.allowedTools.includes(tc.name)) {
      emitRejection(tc, `tool '${tc.name}' not allowed in skill '${currentSkillScope.skillId}' scope. Allowed: [${currentSkillScope.allowedTools.join(', ')}]`);
      continue;
    }
  }

  // ── existing risk classify + confirm + handler ──

  // ── SCOPE TRANSITION (after handler success) ──
  if (skillResolvedNames.has(tc.name) && result.success) {
    const skill = await getSkill(tc.name);
    currentSkillScope = {
      skillId: tc.name,
      allowedTools: skill?.allowedTools ?? null,
    };
  }
}
```

**Patterns to follow:**
- 沿 loop.ts 现有 `for` + `continue` 错误路径模式（line 442-447）
- agent-step error emit 沿 553-568 既有路径

**Test scenarios:**
- *Happy path*: scope = null → 所有 BUILT_IN_TOOLS 正常调用，行为与 Phase 2 一致
- *Happy path*: 触发 `allowedTools: ['scroll', 'extractData']` 的 skill → 调 scroll 通过 / 调 click 被拒
- *Happy path (allowedTools=null)*: 触发老 skill (allowedTools=null) → scope 激活但 allowedTools 不限制（向后兼容）
- *Edge case (R3 anti-nest)*: scope 激活后 agent 调另一 skill tool → 拒绝 "Skills cannot call other skills"
- *Edge case (allowedTools=[] from new skill)*: 进 scope 后只能调 done/fail
- *Edge case (done/fail)*: scope 激活时调 done → loop 正常终止
- *Error path (handler 失败)*: handler 返回 success=false → scope **不**入栈
- *Integration*: scope 内白名单 tool 是 high-risk（如 dispatch_keyboard_input）→ confirm 卡仍弹（risk classify 在 enforce 之后）

**Verification:**
- `pnpm dev` 中手动创建 allowedTools=['scroll'] 的 skill，触发后再 type → Chat 显示 "tool 'type' not allowed..."
- 验证嵌套：scope 内调另一 skill → 显示 anti-nest error

---

- [ ] **Unit 5: Agent-authored skill 首次执行二次 confirm（R10）**

**Goal:** author='agent' 的 skill 首次触发时弹 first-run confirm；通过后写 firstRunConfirmedAt。

**Requirements:** R10

**Dependencies:** Unit 1, Unit 4

**Files:**
- Modify: `src/lib/agent/loop.ts` —— dispatch 块 risk classify 之后、handler 之前加 first-run gate
- Modify: `src/lib/skills/storage.ts` —— 加 `markSkillFirstRun(id, ts): Promise<void>` helper

**Approach:**
- 触发条件：`tc.name` 命中 skill-resolved AND `skill.author === 'agent'` AND `!skill.firstRunConfirmedAt`
- 因 author taint propagation（P0-C），update_skill 之后 author 变 'agent' 且 firstRunConfirmedAt 被清 → 自动触发 R10。这是关键的安全 invariant
- 走已有 `sendConfirmRequest` 通道；`riskReason = 'first-run-of-agent-modified-skill'`
- 文案示意："This skill was authored or last modified by the agent on `<createdAt date>`. This is its first execution since modification. Confirm to allow run?"
- approve → `markSkillFirstRun(skillId, Date.now())` → 然后走 handler；写失败 → log + fail-open（放行 handler，下次再 first-run confirm）
- reject → ActionResult error "Skill first-run not approved" → handler 不执行

**Patterns to follow:**
- 沿 loop.ts:478-523 现有 high-risk confirm 流程
- 沿 storage.ts saveSkill 模式

**Test scenarios:**
- *Happy path*: agent 创建 skill A → confirm 通过 → 同 task 立即调 A → 弹**第二张** first-run confirm 卡 → approve → handler 执行 → A.firstRunConfirmedAt 持久化
- *Happy path*: 重启扩展 → 再调 A → 不再弹 first-run
- *Edge case (user-authored)*: 用户手动创建 skill B → agent 调 B → **不**触发 first-run confirm（author='user'）
- *Edge case (built-in)*: agent 调内置 skill → 不触发 first-run confirm（author='user'）
- *Edge case (taint by update)*: 用户手动创建 skill C → agent 调 update_skill 改 C → C.author 变 'agent' + firstRunConfirmedAt 清空 → 下次 agent 调 C → **触发** first-run confirm — **P0-C 关键 scenario**
- *Edge case (再次 update)*: agent 又 update C → firstRunConfirmedAt 再清；下次调又触发 first-run confirm
- *Error path (reject)*: first-run confirm 用户 reject → ActionResult error → handler 不执行 → firstRunConfirmedAt 仍 undefined
- *Error path (storage write fail)*: mock storage.set 抛错 → handler 仍执行（fail-open）；下次仍弹 first-run confirm

**Verification:**
- chrome.storage.local 直观察 firstRunConfirmedAt 字段变化
- 验证 confirm 卡显示正确文案 + createdAt 日期

---

- [ ] **Unit 6: agent-step skillAuthor 字段 + prompt builder R19 鼓励文案**

**Goal:** AgentStepMessage 携带 skill author 元信息；system prompt 加鼓励 agent 主动 create_skill 的指导。

**Requirements:** R17, R19

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/types/messages.ts` —— `AgentStepMessage` 加 `skillAuthor?: 'user' | 'agent' | 'builtIn'`
- Modify: `src/lib/agent/loop.ts` —— `sendAgentStep` 调用处（466-473 与 553-568）当 tc.name 命中 skill-resolved 时填 skillAuthor（lookup `getSkill`）
- Modify: `src/lib/agent/prompt.ts` —— `buildAgentSystemPrompt(task, hasKeyboardTools=false, hasMetaTools=false)`；hasMetaTools=true 时 append `META_TOOL_GUIDANCE`
- Modify: `src/background/index.ts` —— 调 buildAgentSystemPrompt 时 hasMetaTools=true（meta tools 在 BUILT_IN_TOOLS 始终启用）

**Approach:**
- META_TOOL_GUIDANCE draft (~180 token):
  > "If you notice the user repeatedly asking you to perform a similar workflow (e.g. extracting structured data from page X, filling form Y), consider whether the work would be reusable. Use `list_skills` first to check existing skills. If none fit, you may propose `create_skill` with a clear name, description, parameters schema, prompt template, and `allowedTools` whitelist (mandatory non-empty array of tools you'll need). The user must confirm before save. Use sparingly — do not propose a skill on a one-off task. The user will be asked to re-confirm the first time the skill runs."
- 注意：文案明确告知 agent "allowedTools 是 required non-empty"，与 P1-F 写入路径校验一致；告知 "用户会二次 confirm"，让 agent 心理预期匹配 R10
- skillAuthor 字段对 Chat UI 渲染的影响留 deferred

**Patterns to follow:**
- 沿 prompt.ts 现有 `KEYBOARD_SIM_GUIDANCE` 注入模式
- 沿 messages.ts 现有 optional field 风格

**Test scenarios:**
- *Happy path*: agent 调 user skill → agent-step.skillAuthor === 'user'
- *Happy path*: agent 调 agent skill → 'agent'
- *Happy path*: agent 调 BUILT_IN_TOOLS（如 click）→ undefined
- *Happy path*: agent 调 built-in skill → 'builtIn'
- *Happy path (taint)*: agent update 一个 user skill → 之后 agent 调它 → skillAuthor === 'agent'（与 R10 触发一致）
- *Happy path*: hasMetaTools=true 时 system prompt 末尾含 META_TOOL_GUIDANCE
- *Edge case*: getSkill 返回 null（dispatch 中途被另一 panel 删）→ skillAuthor 不填，loop 不崩

**Verification:**
- DevTools 观察 agent-step 消息 metadata 含 skillAuthor
- SW 日志或 streaming 输入观察 system prompt 末尾文案

---

- [ ] **Unit 7: SkillsList UI 升级（手动 CRUD + author 视觉区分 + storage 配额显示）**

**Goal:** SkillsList 提供"新建 skill"按钮、CRUD 操作、createdAt 倒序、author 视觉区分；底部显示 storage 配额用量；built-in 不可改。

**Requirements:** R11, R12, R13, R14, R15, P1-H footer

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/sidepanel/components/SkillsList.tsx` —— state 加 `editingSkillId / formState / showCreateForm / storageBytes`；UI 加 "+ New skill" 按钮 + inline 表单 + 每条 skill 的 Edit / Delete 按钮 + 底部用量条
- Modify: `src/sidepanel/components/AgentConfirmCard.tsx` —— 当 `tool === 'create_skill'` 或 `'update_skill'` 时**绕过 2000-char cap**，全文 + 滚动条显示 promptTemplate / parameters / allowedTools — **P0-D 实现点**

**Approach:**
- form state pattern 沿 Settings.tsx：`useState<SkillFormState>` + 字段 onChange spread
- 校验 inline：name 非空、parameters JSON.parse 成功且 root 是 `{type: 'object'}` schema、promptTemplate 非空且 ≤ 8 KB、allowedTools 是 non-empty array（手动 UI 创建也走相同规则，与 meta tool 写入路径一致）
- 校验失败 → form 顶部 error 文案 + Save 按钮 disabled
- 提交：调 `saveSkill(...)` with `author='user'`、`createdAt=Date.now()`、`enabled=true`、`builtIn=false`、`firstRunConfirmedAt=undefined`、`id=editingSkillId ?? generateSkillId()`（手动创建走非 agent 前缀，可考虑独立 `skill_user_<uuid>` 前缀以便区分）
- 删除按钮：built-in 不显示；非 built-in 弹 inline 确认 → `deleteSkill`
- author 视觉：
  - `author === 'user'` → border-l-4 border-blue-500 + chip "User"
  - `author === 'agent'` → border-l-4 border-purple-500 + chip "Agent · created/edited \<date\>"（chip 文案明示 taint 语义）
  - `builtIn === true` → border-l-4 border-neutral-700 + chip "Built-in"
- "查看完整 promptTemplate" 用 inline collapse
- 底部用量条：`getSkillStorageBytes()` → 显示 "`<KB>` KB / 1024 KB" + 进度条；> 80% 红色警告

**AgentConfirmCard 改造（P0-D）:**
- 当 `tool === 'create_skill' || tool === 'update_skill'` 时，跳过 `safeStringifyArgs(args, 2000)`
- 改为分字段渲染：promptTemplate 在 `<pre>`-style 滚动 panel；parameters JSON pretty-print 在另一 panel；allowedTools 列出 chip 形式
- React 自动 escape，无 XSS 风险

**Patterns to follow:**
- 沿 Settings.tsx form 模式
- 沿 SkillsList 现有 `loadSkills` + 改动后 reload 模式
- Tailwind v4 现有 palette（neutral / blue / purple / green / red）

**Test scenarios:**
- *Happy path (create)*: + New skill → 填 form → 保存 → 列表显示新条目（author=user，顶部）
- *Happy path (edit)*: 点 user skill Edit → 改 description → 保存 → 列表更新；createdAt 不变
- *Happy path (delete)*: 点 user skill Delete → 确认 → 列表少一条
- *Happy path (sort)*: agent 创建 skill 后第一条；user skill 按 createdAt 倒序；built-in 末尾
- *Edge case (built-in)*: built-in 卡片无 Edit / Delete，仅 enabled toggle + Run
- *Edge case (validation)*: invalid JSON / 长 promptTemplate (>8 KB) / 空 allowedTools → form error + Save disabled
- *Error path (storage fail)*: mock saveSkill 抛错 → form 显示错误，列表未变
- *Edge case (agent-authored)*: 显示 author=agent skill，紫色 border + Agent chip + createdAt 日期
- *Edge case (P0-D confirm 卡)*: 让 agent create_skill 一条 promptTemplate=5KB 的 skill → confirm 卡完整可滚动显示，没截断 — **P0-D 关键 scenario**
- *Edge case (P1-H 用量)*: storage 100 KB → 底部 "100 KB / 1024 KB" + 蓝色进度；900 KB → 红色警告

**Verification:**
- `pnpm dev` + chrome://extensions 跑 10+ scenarios
- chrome.storage.local DevTools 直观察数据完整性

---

## System-Wide Impact

- **Interaction graph:**
  - 新增 BUILT_IN_TOOLS × 4 → 每轮 allTools +4、AgentConfirmCard 渲染 (P0-D 改造)、SkillsList re-render
  - prompt.ts 新 META_TOOL_GUIDANCE → 每任务 token +~180
  - messages.ts 加 skillAuthor → background→panel metadata
- **Error propagation:**
  - meta tool handler 抛错 → ActionResult success=false → loop emit agent-step error → Side Panel 显 error；不会崩 SW
  - storage 写入失败 → handler 返 error；不污染 enabled_skills
  - first-run confirm 写 firstRunConfirmedAt 失败 → fail-open（log + 放行）；下次再 confirm
  - 配额预算 trigger → handler reject + agent 看到 error observation；可调 list_skills + delete_skill 自行清理
- **State lifecycle risks:**
  - chrome.storage.local cross-context sync；SW 写入下一轮 list_skills 立即可读
  - `currentSkillScope` in-memory 局部，task 终止即焚
  - origin pinning（loop.ts:266）不变；scope enforce 与 origin enforce 是两个独立轴
  - **关键 invariant**：update_skill 必清 firstRunConfirmedAt（P0-C），否则任何 update 都绕过 R10
- **API surface parity:**
  - 所有 BUILT_IN_TOOLS 都受 risk classifier 管 → meta tools 必接入（Unit 3）
  - resolveSkillToTools 注入路径不变；老 user-authored skill（无 author）按 default 'user'
  - 老 enabled_skills 数组语义保持
- **Integration coverage:**
  - 手动 verification 必须覆盖：scope=null / scope active 白名单内 / 外 / nest / first-run gate（agent vs user vs builtIn vs taint-by-update）/ author 视觉 / 配额边界 / confirm 卡完整显示
  - 跨 Side Panel 多实例：用户在 A 创建 skill，B 实例 SkillsList 不自动 sync（chrome.storage onChange 监听本 plan 不引入）—— known limitation
- **Unchanged invariants:**
  - tabId+origin pinning（loop.ts:266）不动；CDP 路径（cdp-session.ts）不动；untrusted_skill_params 包装机制（index.ts:79）不动；既有 BUILT_IN_TOOLS 7 个签名不动；keyboard tools 不动；background/index.ts:251 注入点不动
  - **build-in skills 完全不可被 meta tool 触及**（P0-A）—— 唯一改 built-in 行为的方式是 ship 新 BUILT_IN_SKILLS

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope 状态机 bug 致正常 tool 误拒 | Med | Med | scope=null 默认零影响；Unit 4 第一条 scenario 专测；手动 7 scenarios 全跑 |
| 老 storage 缺新字段崩溃 | Low | High | Unit 1 `withSkillDefaults` coalesce + builtin 显式默认；TS optional |
| **P0-A: agent 通过 update 改 built-in skill** | Was Med→**Mitigated** | **High** | Unit 2 update_skill handler 拒 builtIn=true target；测试 scenario 专测 |
| **P0-B: parameters schema string 永久 injection** | **High** | **High** | Unit 2 schema-string 总长 ≤ 2 KB cap；confirm 卡完整显示；信任由 confirm 授予 |
| **P0-C: agent update user skill 绕过 R10** | **High** | **High** | Unit 2 update_skill 强制 author='agent' + 清 firstRunConfirmedAt（taint propagation）；R10 据此自动触发 |
| **P0-D: confirm 卡 2000-char cap 隐藏内容尾部** | **High** | **High** | Unit 7 AgentConfirmCard 对 meta tool 跳过 cap；handler 强制 promptTemplate ≤ 8 KB（双侧约束） |
| **P1-E: agent 传 id='click' shadow built-in tool** | Was Med→**Mitigated** | High | Unit 1 generateSkillId 用 `skill_agent_` 前缀；Unit 2 schema additionalProperties:false + handler 显式 strip args.id |
| **P1-F: allowedTools=null 让 R2 enforce 沦为 voluntary** | Was Med→**Mitigated** | Med | Unit 2 写入路径 required non-null array；空数组 [] 也合法（仅 done/fail） |
| **P1-G: capability creep（confirm 今日 / 激活将来 tool）** | **Med** | Med | Unit 2 写入时校验 names 已注册；Scope Boundaries 明示 |
| **P1-H: confirm-fatigue 累计填满 storage 配额 DoS** | Med | Med | Unit 2 1 MB 预算；Unit 7 SkillsList 用量条；超额 reject |
| Agent 创建恶意 skill 经 confirm 后被反复触发 | Med | Med | R10 首次执行二次 confirm + author 标签 + SkillsList 倒序前置审计；用户可即时删除 |
| confirm 卡显示 raw promptTemplate 含 HTML 时 XSS | Low | Med | React `{value}` 自动 escape；不用 dangerouslySetInnerHTML |
| Loop 改动破坏既有无 skill task | Low | High | scope=null 时所有 dispatch 走原路径不变；Unit 4 第一条 scenario 专测 |
| 多 Side Panel SkillsList 不同步 | Low | Low | known limitation；用户重开 panel 即可 |

## Documentation / Operational Notes

- 更新 `CLAUDE.md` "Progress" 段：Phase 2.5 后追加 "Phase 2.6 / Skill 自主 CRUD — IN PROGRESS / COMPLETED"
- 更新 `CLAUDE.md` "Project Structure" 段：在 `src/lib/skills/` 行追加 "+ meta tools (在 src/lib/agent/tools.ts) + storage helpers (markSkillFirstRun / getSkillStorageBytes / generateSkillId)"
- 更新 `CLAUDE.md` "Architecture Notes" 段：补一条 capability-grant invariant 摘要："Meta tool security: update_skill rejects built-in / forces author='agent' + clears firstRunConfirmedAt (taint); allowedTools required non-null array, validated against currently-registered tools at write time; AgentConfirmCard bypasses 2000-char cap for meta tools (full content is the trust artifact); 1 MB storage budget"
- 不需新增 manifest 权限（仅 chrome.storage.local 已声明）
- 不需 host_permission 变更
- 实施期若发现真实 institutional learning（特别是 schema-string injection / taint propagation 实战经验），写入 `docs/solutions/`

## Sources & References

- **Origin document:** [docs/specs/2026-05-01-skill-autonomous-crud-requirements.md](../brainstorms/2026-05-01-skill-autonomous-crud-requirements.md)
- **Phase 2 plan**（confirm 卡 / risk classifier 设计基础）: [docs/plans/2026-04-17-001-feat-phase2-agent-capabilities-plan.md](2026-04-17-001-feat-phase2-agent-capabilities-plan.md)
- **Phase 2.5 plan**（redaction 二分通道 / 5-path detach pattern）: [docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md](2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md)
- **Phase 2.5 spike verdict**（CDP keyboard）: [docs/solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md](../solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md)
- **Security review**: 本 plan 经 `compound-engineering:review:security-sentinel` 评审，命中 4 P0 + 4 P1，全部已 amend 入 plan（详见 P0-A / P0-B / P0-C / P0-D / P1-E / P1-F / P1-G / P1-H 标记）
- **核心代码引用**:
  - `src/lib/agent/loop.ts:439-578` — tool dispatch 切面
  - `src/lib/agent/loop.ts:340-349` — allTools 重组
  - `src/lib/agent/risk.ts:57` — classifyRisk 入口
  - `src/lib/agent/prompt.ts:39` — buildAgentSystemPrompt
  - `src/lib/agent/tools.ts:45-208` — BUILT_IN_TOOLS 数组
  - `src/lib/skills/{types,storage,index,builtin}.ts` — Skill 框架
  - `src/lib/skills/storage.ts:33` — saveSkill 不检查 builtIn（P0-A 漏洞根源；handler 层兜底）
  - `src/lib/skills/index.ts:22-39` — getAllSkills user-stored 覆盖（P0-A 物化路径）
  - `src/sidepanel/components/{SkillsList,Settings,AgentConfirmCard}.tsx` — UI 表面
  - `src/types/messages.ts:64,74-81` — AgentStepMessage / AgentConfirmRequestMessage
  - `src/background/index.ts:251-255` — skill 注入点
