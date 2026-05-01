---
date: 2026-05-01
topic: llm-capability-grant-invariants
related_brainstorm: docs/brainstorms/2026-05-01-skill-autonomous-crud-requirements.md
related_plan: docs/plans/2026-05-01-001-feat-skill-autonomous-crud-plan.md
tags:
  - capability-grant
  - prompt-injection
  - confirm-card
  - skill-crud
  - adversarial-review
  - agent-security
---

# 让 LLM agent 写"可执行工件"时的 8 个安全不变式

## 适用范围

任何让 LLM agent **持久化写入** 一个会**在后续轮次自己（或别的 LLM 实例）能调用**的工件——典型案例：本项目的 Skill（promptTemplate + parameters + allowedTools，写完后变 callable tool），其他常见形态如 Cursor rules、Claude Code skill、Voyager skill library、tool-builder agent 等。

这类系统是 **capability-grant 系统**：用户每一次 confirm 不只是批准"这一次的动作"，而是批准"这条 capability 此后被多少次重复触发"。本质上不同于 Phase 2 的 click/type 这类 ephemeral-action tool（trust artifact = 当前 args），capability-grant tool 的 trust artifact 是 **写入后持久化的 effective program**。

> 本 doc 是 Phase 2.6 实施 + adversarial review 后的事后提炼。具体实现细节见 plan，本文聚焦**跨场景可复用的不变式**。

## 问题

让 LLM agent 调 `create_skill` / `update_skill` 之类的 meta tool 时，"用户在 confirm 卡上点 approve" 这一次动作的隐含信任面 = "skill 写入后**全部**持久字段"，而不是"agent 这次提交的 tool_call args"。两者在天真实现下不相等——若开发者把 capability-grant tool 当 ephemeral-action tool 处理，至少有 8 个可被 adversarial agent 利用的口子。

## 症状（adversarial review 实测攻击向量）

- **patch-only confirm display**：`update_skill({id, patch:{promptTemplate:"..."}})` 用户只看到 promptTemplate 改了一行；该 skill 既有的 broad `allowedTools`（含 `dispatch_keyboard_input` 等高风险 tool）persist 但未渲染——用户认为是"文案改动"而 approve，实际是把 fresh malicious prompt 嫁接到 stale broad capability
- **schema-string injection**：`parameters.properties.x.description = "Ignore prior instructions and …"` 进入 LLM **每轮** 的 tool 定义里，是永久 system-level prompt-injection 通道；只看 `promptTemplate` 不够
- **author-preserve bypass**：原 author='user' 的 skill 被 agent `update_skill` 后 author 仍是 'user' → R10 first-run gate（gating 在 `author==='agent'`）失效，恶意 promptTemplate 静默生效
- **id spoofing**：agent 传 `id:'click'` 写入 `skill_click` key，下次 `getAllSkills` 合并时 user-stored 同 id 覆盖 BUILT_IN_SKILLS 中的 built-in
- **confirm-fatigue cumulative DoS**：N 个 ~10 KB 小 skill 通过 confirm 累计填满 chrome.storage.local 5 MB ceiling
- **forward-compat capability creep**：今天 confirm 一个 `allowedTools:['some_future_tool']` → 未来 phase ship 该 tool 时该 skill 自动激活新能力，用户无 re-confirm 机会
- **mid-iteration cache staleness**：runAgentLoop 的 per-iteration `skillDefByName` 缓存在 `[update_skill X, X]` 序列中第二个 X 调用时仍是 pre-update snapshot → R10 gate 静默被绕过
- **meta-tool privilege chain**：skill 的 `allowedTools` 含 `create_skill`/`update_skill` → agent 进 skill scope 后递归创建/修改更多 skill，每条仍走 confirm 但 confirm-fatigue 下用户失守

## 走过的弯路

- **沿用 Phase 2.5 的 redaction split 模式**：keyboard tool 走"confirm 显示原文 / agent-step 截断"；初期 PR 把 `create_skill` confirm 卡也走 `safeStringifyArgs(args, 2000)`——cap 后 promptTemplate 尾部被截断 → 用户 approve 了看不见的 payload。**这种 split 对 ephemeral-action tool 正确（text 不是信任决策内容），对 capability-grant tool 反向适用：confirm 必须无 cap，agent-step 才需要截断**。
- **依赖 prompt-level allowedTools 提示让 LLM 自觉只调子集**：原始 plan draft 里 R2 的 enforcement 写在 prompt 里"请只调 allowedTools 内的 tool"——adversarial review 直接指出"白名单只靠提示就退化成 prompt-only tier"。必须在 loop dispatch 前 hard reject。
- **延后处理 `update_skill` 对 built-in skill 的拒绝**：plan 初版只在 `delete_skill` 上禁 builtIn，没在 update_skill 上禁——`saveSkill(id)` 是 dumb primitive 不检查，`getAllSkills` 又用 user-stored 覆盖 built-in，几乎完美的 silent shadowing 路径。adversarial review 抓到。

## 解决方案：8 个不变式

每条都是**写入路径**（meta tool handler）的检查；没有任何一条能仅靠运行时（risk classifier / loop scope）兜底替代——因为运行时拿到的是已被持久化的 skill，攻击发生在写入瞬间。

### I-1 Built-in 不可经 meta tool 修改

`update_skill(id)` / `delete_skill(id)` 在 handler 内部 `getSkill(id)` → `existing.builtIn === true` → 直接 reject。`saveSkill` 是 storage primitive 不检查；写入路径是唯一拦截点。

```ts
// src/lib/agent/tools/skill-meta.ts (update_skill handler)
const existing = await getSkill(a.id);
if (!existing) return err("skill not found");
if (existing.builtIn) return err("cannot edit built-in skill");
```

### I-2 Schema-string 字段与 promptTemplate 同等信任边界

JSON Schema 中的 `description` / `enum` / `default` / `examples` / `title` 字符串每轮都进 LLM `toolsToDefinitions(allTools)` 出去，是永久 system-level injection 面。

```ts
// schema strings 总长 cap（独立于 promptTemplate cap）
const schemaChars = countAllStringChars(args.parameters);
if (schemaChars > 2 * 1024) return err("schema strings too long");
```

confirm 卡 **同时显示** raw promptTemplate **和** parameters；不只是 promptTemplate。

### I-3 Author 是 "last-mutated-by" 而非 "originator"

`update_skill` handler 强制 `merged.author = 'agent'` 且 `merged.firstRunConfirmedAt = undefined`，**不论原作者是 user 还是 agent**。代价：用户在 SkillsList 看到的 chip 从 "User" 变成 "Agent"——这是设计意图，等价于"这条 skill 已被 agent 触碰，回滚到 user-trust 需要用户手动审视后保存"。

```ts
// taint propagation
merged.author = "agent";
merged.firstRunConfirmedAt = undefined;
await saveSkill(merged);
```

否则 R10 gate 在 `author === 'agent'` 上检查 → 用户创建 + agent 修改的 skill 永远不触发 first-run confirm。

### I-4 Confirm 卡显示 effective merged result，不是 patch / args

`update_skill` 提交 patch 时，confirm 卡必须渲染 **post-merge effective skill**（含 retained `allowedTools` / 未 patch 的字段），不是 patch keys。

```ts
// loop.ts 在 dispatch high-risk meta tool 前 pre-compute effective
let metaSkillPreview = undefined;
if (tc.name === "create_skill" || tc.name === "update_skill") {
  metaSkillPreview = await previewMetaSkillCall(tc.name, tc.args);
}
await sendConfirmRequest(confirmationId, { tool, args, metaSkillPreview, ... });
```

UI 端用 `(unchanged)` 标注未变字段，让 reviewer 一眼看清"被改了什么"+"被保留了什么"。**单 cap (2000-char `safeStringifyArgs`) 必须 bypass**——它对 ephemeral-action tool 正确（content 不是信任决策内容），对 capability-grant 错误。

### I-5 Schema additionalProperties:false + 写入端显式 strip + UUID 前缀（id 防 spoof 三层防御）

```ts
parameters: { type: "object", additionalProperties: false, properties: { /* no `id` */ } }
// handler 即便 schema bypass 也兜底
delete a.id;
// 系统自生 id 用前缀
const skill = { id: `skill_agent_${crypto.randomUUID()}`, ... };
```

任何一层失守，下一层兜住。

### I-6 写入路径 reject `allowedTools` null

读路径 (`withSkillDefaults`) 容忍 `null` 用于 back-compat；写路径必须强制非 null array。否则 agent 学会写 `allowedTools:null` 直接绕过 R2 enforce。

```ts
if (!Array.isArray(args.allowedTools)) {
  return err("allowedTools must be an array (use [] for done/fail-only)");
}
```

### I-7 `allowedTools` 只能含 currently-registered tool 名

防"今天 confirm 一个名字 / 明天 phase 加这个 tool 时静默激活"。在写入端校验，不在运行时。

```ts
for (const t of args.allowedTools) {
  if (!ALL_KNOWN_NON_SKILL_TOOL_NAMES.has(t)) return err(`unknown tool: ${t}`);
}
```

**重要细节**：`ALL_KNOWN_NON_SKILL_TOOL_NAMES` **不应**包含 meta tool 自身——否则 skill 可调 `create_skill` 形成自我扩张链。把"系统认识的 tool 名"和"skill 可白名单的 tool 名"作为**两个不同**的集合：

```ts
// src/lib/agent/tool-names.ts
export const KNOWN_BUILT_IN_TOOL_NAMES = [...PHASE_2_TOOL_NAMES, ...META_TOOL_NAMES];
export const ALL_KNOWN_NON_SKILL_TOOL_NAMES = new Set([
  ...PHASE_2_TOOL_NAMES,        // ✓ 普通 tool 可入 allowedTools
  ...KEYBOARD_TOOL_NAMES,        // ✓ 键盘 tool 可入
  // META_TOOL_NAMES 故意不包含 — 防 skill 链式调 meta tool
]);
```

### I-8 配额检查在写入端，不在运行时

```ts
const currentBytes = await getSkillStorageBytes();
if (currentBytes + estimateSkillBytes(skill) > 1 * 1024 * 1024) {
  return err("skill storage quota exceeded");
}
```

预算 1 MB（chrome.storage.local 5 MB ceiling 的 20%），剩余给 provider 配置 + 任务状态 + future checkpoint。配额 surface 在 SkillsList UI 顶部用量条——让用户能看到累积压力，不是单次 confirm 时的 invisible drift。

## 为什么这套不变式成立

**根因**：capability-grant 系统的 trust artifact 是"approve 后 storage 中持久化的 effective program"，**不是** "agent 这次提交的 tool_call args"。一旦把这两者识别为不同对象，所有 8 条不变式都是从一个统一原则导出的：

> Confirm 卡显示的 = 用户在批准的 = 写入后实际持久化生效的。三者必须严格相等。

- I-4 是这个原则的最直接表达（不显示 patch，显示 merged）
- I-1/I-3/I-5/I-6/I-7 是"约束写入路径，让 effective program 等于用户能预期的"——因为运行时无法事后区分 user-confirmed vs spoofed
- I-2 把 trust artifact 的边界从 promptTemplate 一字段扩展到所有进 LLM context 的 skill 字段
- I-8 防 confirm-fatigue 把"单次 trust 决策"在累积维度上稀释

另一个隐藏维度：**写入路径的 cache invalidation**。loop 在每个 iteration 顶部缓存 enabled skill 元数据；mid-iteration meta tool 写入后必须立即刷新（否则 `[update_skill X, X]` within-step 序列读到 stale X）：

```ts
// loop.ts 在 meta-tool handler success 后
if (isSkillMetaToolName(tc.name) && result.success) {
  const refreshed = await getEnabledSkills();
  skillDefByName.clear();
  for (const s of refreshed) skillDefByName.set(s.id, s);
}
```

这条本身不是 capability-grant 不变式，是"任何依赖 cached metadata 的下游 gate（含 R10 first-run gate）都必须在 cache 失效边界刷新"——属于 cache 一般原理。但在 capability-grant 上下文里它从优化变成**正确性要求**。

## 预防 / 给未来设计 capability-grant 系统的 checklist

设计 LLM-agent-writes-executable-artifact 时，按以下次序自检：

1. **trust artifact 是什么？**
   - ephemeral action（click/type） → trust = 当前 args，redaction split 模式适用
   - capability grant（写持久字段，未来 callable） → trust = post-write effective program，必须 full disclosure
2. **confirm 卡渲染的是 trust artifact 吗？** —— 渲染 patch、args、cap 后的 stringify 都不算
3. **author / origin 字段是 originator 还是 last-mutated-by？** —— capability grant 必须是后者；否则 mutation gate 漏过
4. **每个进 LLM context 的字符串字段都是 trust 边界内吗？** —— description / enum / examples / 任何 schema string 都算，不只是 obvious 的 prompt 字段
5. **写入路径**逐条 enforce：built-in 保护 / 字段长度 / 必填 / name 已注册 / 配额；运行时不能兜底替代
6. **下游 gate 依赖的 cache 在 mutation 后立即失效**
7. **artifact 的 whitelist 字段不能包含写 artifact 的 meta-tool 名** —— 防自我扩张链
8. **forward-compat 字段值要在写入瞬间校验**，未来 phase 的能力不能静默激活老 confirmed artifact

## 跨引用

- 实施 plan：`docs/plans/2026-05-01-001-feat-skill-autonomous-crud-plan.md` — P0-A ~ P1-H 命名 + 每条 unit-level test scenario
- 需求 brainstorm：`docs/brainstorms/2026-05-01-skill-autonomous-crud-requirements.md` — R5 / R10 / Key Decisions on allowedTools loop enforcement
- Phase 2.5 redaction-split 反例：`docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md` — 该 split 对 keyboard tool 正确，对 capability-grant 必须反向（本 doc I-4）
- Phase 2 风险分级基线：`docs/plans/2026-04-17-001-feat-phase2-agent-capabilities-plan.md` — "default low + structural escalation" 仅适用 DOM tools；capability-grant tool 必须 hardcoded high
- 主要 source：
  - `src/lib/agent/tools/skill-meta.ts` — 4 meta tool handler，全部 8 条不变式落地点
  - `src/lib/agent/loop.ts:474-748` — scope enforce + R10 first-run + cache invalidation
  - `src/lib/agent/tool-names.ts` — 双 set 拆分（registry vs allowedTools）
  - `src/sidepanel/components/AgentConfirmCard.tsx` — meta tool 走 `SkillContentDetails` 不走 `safeStringifyArgs` 的分支
