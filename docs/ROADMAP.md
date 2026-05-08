# Chrome AI Agent — Roadmap

延续 `docs/design.md` 的 Phase 0/1/2/3 终态。本文件是已交付 phase 状态 + 后续 backlog 的 single source of truth；invariant 级别细节见 `docs/solutions/`。

**已交付**：Phase 0 / 1 / 2 / 2.5 / 2.6 / 3 / 4 (M1 + M2 + M3) / 5 (multimodal v1) / v1.5 (multi-pin + open_url + focus_tab)。Skill scope 解禁 + 全局 skip-permissions toggle ([#26](docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md))。Confirm 层彻底删除（risk classifier / confirm card / skip-permissions toggle / K-10 reject-3-strikes）— 2026-05-08。

本文件汇总各 brainstorm / plan 主动 defer 的 milestone，是后续工作的 backlog。每条目标是"够用以决定下一步"，不是 plan，立 plan 时再 brainstorm + plan 走完整链路。

---

## 1. design.md 原始构想中仍未交付的项

| 项 | 来源 | 备注 |
|---|---|---|
| **Gemini provider** | design.md L80, L135 | ✅ **完成** — 与 §7 同期 ship (PR #28)。Native module（`inline_data` + `function_declarations` + `?alt=sse`）+ 7-provider id-keyed dispatch + `generativelanguage.googleapis.com` host_permission。Registry seed: `gemini-2.0-flash` / `gemini-2.5-pro` |
| **Ollama / 本地模型** | design.md L80–82, L135 | 需 manifest 加 `http://localhost/*`，streaming 协议适配 |
| **快捷键支持** | design.md L136 | 零结构性风险的打磨项 |
| **任务状态持久化（SW 重启恢复）** | design.md L91 | ✅ **完成** — M1 PR #8 + M2 PR #9/#10/未编号 + M3 PR #13 全 ship。Single-session SW-restart recovery + tombstone + R11 drift card + multi-session UI drawer + LLM 标题 + LRU archive + per-session sandbox |
| **图片输入（多模态）** | design.md（隐含 / 用户 2026-05-04 新提） | ✅ **完成** — Phase 5 v1 PR #20 merged 2026-05-04。用户上传（粘贴/拖拽/按钮 ≤3 张）+ LLM screenshot tools (`capture_visible_tab` / `capture_fullpage_tab`) + No-persist storage + Anthropic/OpenAI/OpenRouter 三家 vision。v1.1 follow-up 见 §8 |
| **定时工作流（scheduled agent runs）** | design.md L40 "定时工作流可以作为后续迭代加上去" | 需先解决 SW 5 min 限制 + 任务持久化 |

## 2. Skill 框架进阶（Phase 2 / 2.6 brainstorm 主动 defer）

| 项 | 来源 | 备注 |
|---|---|---|
| **操作录制 → Skill 自动生成** | `2026-04-16-phase2-...md` L65 | 需 Phase 0 类的 spike 验证录制可行性 |
| **基于页面 URL 匹配的 Skill 自动触发** | 同上 L66；`2026-05-01-skill-...md` L94 | 需先解决 prompt-injection-by-page 防御 |
| **Agent 自主建议 / 推荐 Skill** | 同上 L67 | UX 不能成为 confirm-fatigue 放大器 |
| **Skill 互调 / 嵌套** | `2026-05-01-skill-...md` L80, L93 | 当前 R3 anti-nest 强约束；放开需重设计作用域栈 |
| **Skill 共享 / 导出 / marketplace** | 同上 L82 | 单用户 BYOK 优先；marketplace 需信任模型重设 |
| **Skill version 历史 / migration** | 同上 L81 | YAGNI；编辑直接覆盖 |
| **Skill draft / quarantine 中间态** | 同上 L83 | 当前用 R10 首次执行二次 confirm 替代 |

## 3. Checkpoint & Resume（Phase 2.6 brainstorm 附录 C1–C5）— ✅ **M1 + M2 + M3 全 SHIPPED (2026-05-04)**

> **Status (2026-05-04)**: Brainstorm 升级为 "session 作为 first-class persistent layer" → `docs/specs/2026-05-02-checkpoint-resume-requirements.md`。Plan (14 unit / M1→M2→M3) → `docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md`，frontmatter status=`completed`. **M1 (PR #8)** single-session 持久化 + SW restart recovery + R11 drift card → `docs/solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md`。**M2 (PR #9 + #10 + 未编号)** multi-session UI drawer + LLM 标题 + LRU archive + 30d 硬删 + soft delete + storage indicator。**M3 (PR #13)** per-session port + per-session pinned tab/origin + R7 cross-session lock + ownerToken `{sessionId, tabId}` + queueTabOp 串行化 + R14 fail-on-image precondition (与 Phase 5 协同) → `docs/solutions/2026-05-03-multi-session-invariant-trace.md`。M3 残余 advisory 项见 §9。

> **§M3-U6 close-out (2026-05-08)**: Panel state per-session migration shipped. M3 series fully complete.

**Original C1–C5 outline (now superseded by full plan above; kept for traceability)**:

`docs/specs/2026-05-01-skill-autonomous-crud-requirements.md` L127–135 outline 级，**未单独 brainstorm**。Phase 2.6 plan 的 1 MB skill 配额 + 4 MB 余量已为它预留。

- **C1** 任务级 checkpoint：每 step 序列化 `{task, modelConfig, agentMessages, pinnedTabId, pinnedOrigin, lastStepIndex, currentSkillScope}` 到 `chrome.storage.local`，键 `agent_checkpoint_<taskId>`
- **C2** SW 重启 / Side Panel 重新打开时检测未完成 checkpoint，推 "上次任务被中断，是否继续 / 丢弃" 卡到 Chat
- **C3** task `done`/`fail`/Stop 时清理 checkpoint
- **C4** 不存 API key；agent 历史中已 redact 字段保持 redact
- **C5** 与 SW keep-alive 责任划分、resume 卡视觉、`currentSkillScope` 序列化协议待定

## 4. Phase 3 plan 主动 defer 的 cross-tab 进阶

**带 acceptance gate（plan 强制约束）**：

- **G-1 `SkillDefinition.allowedTools` schema 升级为 `Array<{name, scope}>` tuple** — 引入任何 risk≠high 的 cross-tab 工具（candidate: `peek_tab_metadata` / `read_tab_title`）之前必须先升级。当前 `risk.ts` build-time check 锁住：每个 `TAB_TOOL_NAMES` 条目必须出现在 `ALWAYS_HIGH_TAB_TOOLS` 或 `ARGS_CONDITIONAL_TAB_TOOLS`，否则 throw
- **G-2 跨 window `move_tabs`** — 引入前必须重审 confirm 卡 wire shape 是否要展示 source/target window context

**纯 deferred（无 gate）**：

| 项 | 来源 | 备注 |
|---|---|---|
| 独立 sidepanel "Tabs" 视图 | Phase 3 plan L58 | **明确不做**（与 agent-as-tools 定位冲突）|
| `discard_tabs` / `tabs.duplicate` / `tabs.captureVisibleTab` | Phase 3 plan L59 | 足以满足 R1-R5 后再补 |
| Incognito 窗口支持 | Phase 3 plan L61 | manifest 不加 `incognito: spanning`，作为 privacy 不变量 |
| Partial-select confirm（checkbox UI） | Phase 3 plan L62 | 当前 all-or-nothing；用户拒绝后 LLM 重新出更小子集即可 |
| "智能清理长期未访问标签" 内置 skill | Phase 3 plan L63 | 留给用户用 SkillsList 自助 CRUD 验证 Phase 2.6 |
| chrome.history 主题趋势分析 | design.md L98 | 已表态不取该权限 |
| approve-side sanity reflection（≥5 cross-origin approve 顶部反思条） | Phase 3 plan L150 | 被评 paternalistic 撤回；等真实滥用模式再补 |
| 两阶段 LLM 分类（>50 tab 时上 TnT-LLM 风格） | Phase 3 plan L103 | v1 单阶段够用 |

## 5. 4-Way Roadmap Evaluation（2026-05-04）

用户提出 4 个方向，brainstorm 评估 + 优先级摘要。详细评估见 `docs/specs/2026-05-04-multimodal-image-input-requirements.md` 的同期对话记录。

| # | 方向 | 状态 | 下一步 |
|---|---|---|---|
| **1** | 多模态输入图片 | ✅ **PR #20 merged 2026-05-04**：v1 = 用户上传（粘贴/拖拽/按钮 ≤3 张，auto-resize 1568px JPEG q85 + EXIF strip）+ LLM screenshot tools (`capture_visible_tab` / `capture_fullpage_tab` 两者 always-high) + No-persist SW per-session cache (30MB/last-3-turn LRU，4 evict 路径) + Fail-on-image (R14 paused→failed) + R15 image untrusted boundary system prompt + Anthropic/OpenAI/OpenRouter 三家。15 task / 339→461 tests (+122 net) / R1-R15 全闭环。v1.1 follow-up 见 §8 | 完成 |
| **2** | Skill 脚本化（"完整 skill"） | ⚠️ **scope 含糊未深入**：必须先 narrow 含义到 (a) JS 自定义 tool handler / (b) DSL 描述固定步骤 / (c) prompt 加 control flow / (d) 录制+回放（与 #4 重叠）中的某一个。Manifest V3 CSP 对 (a) 是硬约束（禁 `eval`/`Function`，要 sandboxed iframe / Worker，BYOK trust model 重审）；(c) 与 LLM 自身 reasoning 重叠 YAGNI 风险高 | 单独 brainstorm 先 narrow 哪一种含义 + 当前 skill 系统真正卡住的用例 |
| **3** | 控制 Chrome 浏览器 | ✅ **SHIPPED 2026-05-05** (manifest 0.5.2, branch `feat/multi-pin-open-url-v15`, PR #21)：v1.5 Path A 全闭环 = `open_url(url, active=false)` + `focus_tab(tabId)` + **pinnedTabs[] schema** + per-iteration `currentFocusTabId` refresh + multi-select PinnedTabDropdown UI + URL allow-list (R6 显式 `protocol === 'http:'\|'https:'`) + IDN punycode 显示（防 homograph）+ always-high confirm + per-call SkillsList badge。10 task / 572 tests pass / @deprecated legacy single-pin fields 完全删除。**`nav_pinned_tab` cross-origin nav 仍推 v1.1 单独 brainstorm**——pre-multi-pin review 暴露 4 invariant 互动复杂度（R6 inTransitOrigin / R7 atomic swap / R9 CDP detach / R10 task-mutex）+ ADV-1 Premise collapse；R11 click-induced nav false-positive 才是用户最常见痛点，v1.5.1 评估优先级。Trace doc → `docs/solutions/2026-05-03-multi-session-invariant-trace.md` v1.5 章节；engineering patterns（phased deletion / dual-write shim / merge-not-replace snapshot / cross-storage integration tests）→ `docs/solutions/2026-05-05-cross-cutting-type-migration-lessons.md` | 完成；v1.5.1 backlog 见 §10 |
| **3.1** | nav_pinned_tab cross-origin (defer) | ⚠️ **推 v1.1**：原稿（pre-multi-pin）暴露 4 P0（SEC-2 server-side redirect / SEC-5 pin-in-transit 永久 DoS / ADV-2 inTransitOrigin race basis / ADV-3 shared-pin sessions broken）+ R11 click-induced false-positive 才是用户最常见痛点。需独立 brainstorm 收窄 4 invariant 设计 + 评估 R11 false-positive 修是否更高 ROI | 单独 brainstorm 在 multi-pin v1 ship 后；评估"R11 click-nav false-positive 修"作为更轻量替代 |
| **4** | 行为录制 + AI 创建 Skill | ✅ **SHIPPED 2026-05-05** (v1，单 tab + LLM-driven skill 创建)：sidepanel Record button → DOM event capture → Finish 后 trace 通过 chat 输入框 chip 注入 → user 加自由 prompt → LLM 显式调用 built-in skill `create_skill_from_recording` → 该 skill 调 create_skill meta tool → R10 first-run confirm 卡片作为 capability review surface。回放完全复用现有 ReAct + click/type 工具路径。所有 Phase 2.6 capability + Phase 3 cross-tab + M3 multi-session 自动兼容。同时新增 2 个 built-in skill（`take_screenshot` / `open_url_in_tab`）+ SkillsList 概念说明。trace doc → `docs/solutions/2026-05-05-record-and-replay-v1-invariant-trace.md`；plan + reframe note → `docs/plans/2026-05-05-record-and-replay.md`。v1.1 backlog：cross-tab 录制 / N 行数据循环 / 重录覆盖 UX | 完成 |

**4 个方向都不是单条 PR 能拿下的 scope**——除了方向 1 已 nail，2/3/4 各自至少 1 轮独立 brainstorm 才能进 plan。

## 6. 多轮对话上下文（pre-existing gap, 用户 2026-05-02 报告）— ✅ **SHIPPED 2026-05-04**

**Status (2026-05-04)**: PR #15 (`feat/multi-turn-conversation`, merge `550e039`) ship 了 Half A + Half B；PR #16 (`fix/multi-turn-followup-p1`, merge `f96cf8e`) 跟进修了 3 个 P1 residual。Plan `docs/plans/2026-05-03-001-feat-multi-turn-conversation-context-plan.md` frontmatter `status=completed`。

**实际落地**：

- **Half A 纯 chat 多轮** — `handleChatStream` 现接整个 `messages` 数组 (`background/index.ts:1078`)；`runAgentLoop` 起手 `history = [system, ...messages]`，第二条及后续 user message 时 LLM 看到完整 `[system, user1, assistant1, …, userN]` (R1 闭环)
- **Half B agent task 后接对话** — 选 D1 hybrid synth (选项 1c)：SW 端 `emitDone` 时从 5 路径 summary 来源合成 assistant turn 文本写入 `session_${id}_meta.lastTaskSynth`，下一轮 `handleChatStream` 起手注入到 history。避免连续两个 user message → provider 400 (R2 闭环)
- **支撑模块** — `src/lib/agent/synthesize-agent-turn.ts` (合成器) + `history-validation.ts` (拼接处不变量) + `window-token-budget.ts` (Half A 多轮 history 注入后 sliding window `preserved=slice(0,2)` 硬编码假设破除)
- **不做（明确 scope out）** — 选项 2 完整 IR 翻译（M1-U3 tombstone 已清掉、物理不可行）/ 选项 3 LLM 调用变形（BYOK token 成本，留 v2）

**Acceptance**：5 条 chat 第 5 条引用第 1 条内容（Half A regression）+ chat→agent→chat 立即接"总结一下"含上一轮信息（Half B happy path）皆通过。

---

## 7. Provider + Model 能力中心化管理（用户 2026-05-04 报告）— ✅ **SHIPPED 2026-05-06**

**Status**: PR #28 merged 2026-05-06，branch `feat/provider-config-center`，21 implementation commits + 多轮 user-feedback polish。700/700 tests pass。

**实际交付（B+ scope）**：

1. **Multi-instance 配置中心**：同 provider × N instance 独立 nickname / model / apiKey；`instance_${uuid}` + `instances_index` + global `active_instance_id` + per-session `instanceId` override（task-start snapshot 锁 ModelConfig）
2. **Per-model capability schema**：`ModelMeta { vision, tools, maxContextTokens }` 替代 per-provider boolean；`supportsVision`/`supportsTools` 字段从 ProviderMeta 删除
3. **BaseURL 完全封装**：`defaultBaseUrl` 唯一 source of truth；UI 删除手填，迁移期静默丢弃
4. **Provider 模块化**：抽 `_shared/openai-compat-core.ts` + 5 家 OpenAI-compat 各成 thin wrapper（OpenRouter 加 `HTTP-Referer`/`X-OpenRouter-Title`），id-keyed dispatch 替代旧 `meta.type` switch
5. **Gemini native module**：`inline_data` + `function_declarations` + `?alt=sse`（同期 ship §1 Gemini provider 项）
6. **DeepSeek provider**：v4-flash + v4-pro，OpenAI-compat 走 thin wrapper
7. **Model dropdown 数据策略**：6/8 provider 走 registry hardcoded（随发版同步官方 doc）+ `/v1/models` 仅 OpenRouter（公开 endpoint，无需 auth，wizard 选 provider 时预拉）+ per-instance `customModels` + per-provider 黏性 pool（`pcm_${provider}` 跨 instance 共享）
8. **Settings UI 重写**：list-by-provider → "my configs" + 2-step `+ 新建配置` wizard + 编辑 form（API Key 部分明文 read-only + Replace key 流程）+ ModelDropdown（限高 280px + 搜索 + capability tag）
9. **Composer InstanceSelector chip**：borderless chip 在 composer action 行（textarea 上下排版）+ 上开 dropdown overlay + locked 态（task in-flight）+ 新会话 fallback 到 active instance
10. **V1→V2 migration**：silent，schema_version sentinel，老 `provider_*` 转为 instance + 老 baseUrl 静默丢弃；session backfill via `migration_v2_mapping`

**Trace docs**：
- Spec: `docs/specs/2026-05-06-provider-config-center-design.md`
- Plan: `docs/plans/2026-05-06-provider-config-center.md`
- PR: https://github.com/WiseriaAI/Pie/pull/28

**新增可扩展点**（架构已就位）：

| 项 | 路径 |
|---|---|
| 加新 provider | registry entry + 模块文件 + manifest host_permission（zero dispatch edits） |
| Per-model vision UI | 已 unblock §8 "MiniMax / 智谱 / 百炼 vision" — schema layer 完成；具体 wire 仍是 per-provider 工作 |
| OpenRouter routing extras | `provider`/`models`/`transforms` 字段未暴露（用户主动降级），后续单独 backlog |
| 官方 SDK 接入 | MV3 SW + bundle / CSP 风险未评估，后续单独 brainstorm |
| Anthropic `cache_control: ephemeral` | §8 backlog 项，可独立 ship |

---

## 8. Phase 5 v1.1 follow-ups（multimodal image input ship 后已知 deferred）

来源 `docs/plans/2026-05-04-multimodal-image-input.md` "Deferred to v1.1" + final review minor findings + post-acceptance bug doc。

| 项 | 价值 | 备注 |
|---|---|---|
| **Anthropic `cache_control: ephemeral` on image content blocks** | 大 | 当前一张图持续 6 round task = ~9.4K 重复 vision token；启用 ephemeral cache 后只算一次。BYOK cost mitigation 头号 |
| **Settings toggle: 1568 ↔ 1092 max-edge** | 中 | Anthropic 1568 进高价 tier (~2.46MP) / 1092 进低价 tier (~1.19MP)。让 BYOK 用户自选清晰度 vs 成本 |
| **Archived bundle thumbnail (256 px / ~50 KB per image)** | 中 | 当前 archived session 全显 `[图已释放]` 占位；v1.1 在 archive bundle 内嵌缩略图，可读但不可 LLM 还原 |
| **Multi-image reorder UI** | 低 | 拖拽重排上传顺序；v1 上传顺序即提交顺序 |
| **Skill `promptTemplate` 内嵌图片** | 低 | 当前 skill template 纯文本；image embed 需要 skill schema 升级 |
| **Resume-with-re-upload for image-bearing paused tasks** | 低 | 当前 R14 强制 failed；用户可点 prompt 提示"上传上次的图继续"再 resume，UX 复杂 |
| **R13 path (e) explicit-clear UI** | 低 | 4 路径自动 evict 已覆盖；显式 "Clear images" 按钮 v1.1 看用户体验数据再决策 |
| **Pre-existing Anthropic `tool_result.toolUseId` snake_case audit** | 维护 | Phase 5 review 暴露：`toolUseId` (camelCase) 直接送 Anthropic API（应是 `tool_use_id`）。Phase 5 之前就这样、似乎被 API 容忍；单独审计 + 可能配合 Gemini 时一起改 |
| **Gemini provider vision** | 大 | ✅ **完成** — §7/§1 同期 ship (PR #28)。Gemini native module 含 `inline_data` 协议；registry seed `gemini-2.0-flash` / `gemini-2.5-pro` 标 `vision: true` |
| **MiniMax / 智谱 / 百炼 vision** | 中 | **Schema unblocked** by §7 (PR #28) — registry 已加 `glm-4v-plus` / `qwen-vl-max` / `MiniMax-VL-01` 标 `vision: true`；wire 层仍走 OpenAI-compat（image_url base64 inline）共享 path，需各家 vision endpoint 实测确认兼容性。**剩余工作 = 测 + 文档**，不是新协议适配 |

## 9. M3 残余 advisory 项（M3 ship 后未实现的可选优化）

> **2026-05-08 update**: M3-U6 panel concurrent state migration shipped (#30). The advisory items below remain optional maintenance and are not blockers for any roadmap item.

ce:review autofix sweep 时已提但未做的项，不影响 R24/R25/R26 acceptance gate；可作为 ad-hoc 维护任务穿插：

| 类别 | 项 | 备注 |
|---|---|---|
| **TS 优化** | kt-2: `TOOL_CLASSES` 用 `Record<typeof KNOWN_*_TOOL_NAMES[number], ToolClass>` 在编译期 enforce 完整性 | 现走 module-load throw；编译期 check 更早暴露 |
| **TS 优化** | kt-4 / kt-5: loop.ts 内 `import("...").CdpOwnerToken` 改为顶部 type 导入 + `let ownerToken` 改为构造点声明 | 风格清理 |
| **可维护性** | MAINT-M3-1: `CdpOwnerToken.tabId` 字段无 reader 可删 | 死字段；ownerToken 已用 sessionId 唯一标识 |
| **可维护性** | MAINT-M3-3: `inFlightSessionIds` Set 在 per-port-per-session 模型下退化为 boolean | M3 后 port 与 session 1:1，Set 永远 ≤1 元素 |
| **agent-native** | W2: R7 lock observation 不附带 offending sessionId | 需要 ctx.crossSessionPinnedTabsByTab 从 Set<tabId> 升级为 Map<tabId, sessionId> |
| **测试 gap** | `verifyPortSession` 拒绝路径无 SW 端集成测试 | 当前只有单元层 |
| **测试 gap** | loop.ts pin-resolution 4 分支无 end-to-end 测试 | 单元层有，跨层缺 |

详细 invariant trace 见 `docs/solutions/2026-05-03-multi-session-invariant-trace.md`。

> **v1.5 部分缓解**：测试 gap "loop.ts pin-resolution 4 分支无 end-to-end 测试" 中的 cross-storage 路径已被 v1.5 Task 6 polish 加入的 `readFocusFromStorage` 集成测试覆盖（empirically fails on missing-await + wrong field path）。M3 single-pin 跨层路径仍未补，但 v1.5 后行为已迁移到 multi-pin 通道，原 M3 gap 仅作历史 advisory 保留。

---

## 10. v1.5.1 follow-ups（multi-pin + open_url ship 后已知 deferred）

> **2026-05-08 update**: M3-U6+ anchor resolved by concurrent sessions ship (#30). The items below are independent deferred polish and not blocked by any roadmap item.

来源 `docs/solutions/2026-05-03-multi-session-invariant-trace.md` v1.5.1 backlog 章节 + final review minor findings + plan 的 v1.5 boundary。Engineering patterns 见 `docs/solutions/2026-05-05-cross-cutting-type-migration-lessons.md`。

| 项 | 价值 | 备注 |
|---|---|---|
| **Phantom pin pruning** | 中 | `removePinFromMeta` helper 已存在但无生产 caller。手动关闭 / 浏览器 crash 一个 pinned tab 后 `pinnedTabs[]` 残留 stale entry。Loop 的 per-iteration origin check fail-soft（clean abort，无安全风险）但 session 进降级状态。修法：`chrome.tabs.onRemoved` 监听 + chat-start re-validation against `chrome.tabs.get` |
| **tabTargets / contentPreview wire drop（pre-existing Phase 3 gap）** | 大 | `useSession.ts:414-423` 的 `agent-confirm-request` handler 没 destructure `tabTargets` / `contentPreview`，尽管 SW 端有写、`AgentConfirmRequestMessage` schema 也声明。close_tabs / group_tabs / get_tab_content confirm card 因此丢 origin list + content preview。v1.5 加 `openUrlPreview` 走对了 pattern 但没顺手修旧 bug。**K-1 informed-approval shortfall** |
| **ownerToken refresh on focus_tab** | 低 | Keyboard tools 实际通过 `ctx.tabId` 路由（focused tab 正确），ownerToken.tabId 停留在 task-start 仅作 metadata。Defense-in-depth：focus_tab + 启用 keyboard tools 组合时 surface 一个 guard warning |
| **PinnedTabDropdown 列表 live refresh** | 低 | `useEffect(..., [])` 只在 mount 拉一次 tab list；user 多选期间 dropdown 长时间打开，浏览器开/关 tab 时列表 stale。修法：subscribe `chrome.tabs.onCreated` / `onRemoved` 直到 dropdown 关闭 |
| **`nav_pinned_tab` cross-origin nav** | 大 | 见 §5 #3.1 — pre-multi-pin review 暴露 4 P0 + R11 click-induced false-positive；推 v1.1 单独 brainstorm 时一并评估"R11 false-positive 修"作为更轻量替代 |
| **`SessionConfirmCard.PinnedTabDriftPayload.pinnedOrigin`** | 维护 | 这个 wire-format 字段名沿用 single-pin 命名；语义上现在是"pinned tab 触发 drift 的那个 origin"，可考虑下次顺手改为 `driftedOrigin` + `driftedTabId` 让多 pin 语义更清晰。无功能影响 |

- **录制 v1.1 待办**：cross-tab 录制（用户在录制中开新 tab 也录入）；数据循环（N 行 csv → 跑 N 次同一步骤）；重录覆盖快捷入口（保 author='user' 路径）

---

## 11. Provider 配置中心 v0.6 follow-ups（§7 ship 后已知 deferred）

来源 PR #28 ship 后梳理 + 用户 acceptance 期间反馈但未 inline 修。

| 项 | 价值 | 备注 |
|---|---|---|
| **OpenRouter `provider` routing / `models` fallback / `transforms` 字段暴露** | 中 | 用户 brainstorm 期间主动降级；BYOK + OpenRouter 高级用户的真实需求待证伪 |
| **官方 provider SDK 接入（`@openrouter/sdk` / `@anthropic-ai/sdk` / `openai`）** | 中 | MV3 SW + bundle size + CSP 风险未评估；当前自研 fetch+SSE 已稳定，单独 brainstorm 后再决定 |
| **Anthropic `cache_control: ephemeral` on image content blocks** | 大 | 与 §8 同条目；Phase 5 v1.1 backlog；当前一张图持续 6 round task = ~9.4K 重复 vision token |
| **MiniMax / 智谱 / 百炼 vision 实测验收** | 中 | §7 ship 已加 schema flag + registry seed (`glm-4v-plus` / `qwen-vl-max` / `MiniMax-VL-01` 标 vision: true)；wire 走 OpenAI-compat image_url base64 — 需各家真 key 实测确认 |
| **Per-instance maxTokens override UI 字段** | 低 | StoredInstance.maxTokens 字段保留但 UI 不暴露；用户反馈需要再加 |
| **InstanceForm React state 复杂度审计** | 维护 | `customModels` 本地 state + `setReplacing` + `setApiKey` + parent reload 多个异步路径；race-safe useEffect merge 已加但代码读起来重；未来如增需求可考虑 reducer 重写 |
| **OpenRouter dropdown 无 vision provider 时 attach button 提示** | 低 | 当前 attach button hide-on-no-vision 已 OK；可考虑 hover tooltip 解释为啥 disabled |
| **Provider doc 同步流程文档化** | 低 | 当前每发版需手扫 7 家 provider 官方 doc 更新 registry seed；可写一个 release checklist 流程文 |
| **`migration_v2_mapping` 永久保留** vs GC | 低 | <1KB，永远 lazy backfill 用；不构成 storage 压力。除非 v3 schema 来时考虑废弃 |

---

## 12. Open feat issues 优先级 (2026-05-07)

GitHub `state:open` 的 3 条 feat 性 issue（虽未打 label，但标题均为 `feat:` / `feat(...)`），按"用户痛感 × 实现就绪度 × scope 清晰度"排：

| 优先级 | Issue | 标题 | 状态 / 下一步 |
|---|---|---|---|
| **P0** | [#30](https://github.com/WiseriaAI/Pie/issues/30) | feat(session): 并发会话支持 — 当前 task 后台继续 / 新建 session 不影响（M3-U6+） | ✅ **SHIPPED 2026-05-08** — panel state migration to per-session `Map<sessionId, T>` + slots/slotsRef hub + createPortHandlers factory + setActive/createAndActivate simplified + #29 streaming guard removed + SW R13(c) evictOnSetActive removed + SW keep-alive scoped to in-flight tasks. ~14 tasks / cross-layer regression for agent-done-task transit / 700+ tests pass / acceptance AC-1..AC-9 met. Closes §3 / §9 / §10 M3-U6+ anchors. Trace doc → `docs/solutions/2026-05-03-multi-session-invariant-trace.md` §M3-U6 (appended) |
| **P1** | [#34](https://github.com/WiseriaAI/Pie/issues/34) | feat: agent working 中途可发送新指令，当前单次 loop 完成后参与后续循环 | scope 含糊 — 必须先 brainstorm 收窄 3 处：a) "插入"是覆盖原始 task 还是纯附加 / b) 是否要二次 confirm / c) 同 loop 后多条 pending 是合并提交还是分批。默认建议：纯附加（不动 task） + 不 confirm（输入即排队） + 多条按时序合并到下一轮 user role + 用 `[User Mid-Task Instruction]:` 标签让 LLM 区分。与 #30 互补但**应在 #30 之后启动**：当前单 port + 单 streaming state 的 architecture 下，pending queue 会和 #29 streaming guard 互锁；#30 ship 后 pending queue 自然 per-session 隔离 |
| **P2** | [#38](https://github.com/WiseriaAI/Pie/issues/38) | feat: 输入时支持引用页内内容（组件元素、文字、图片）及划词显示组件 | 工作量最大、scope 最含糊、prompt-injection 风险最高。issue 含 4 个独立 feature 维度（DOM 元素引用 / 划词组件边界识别 / side panel 引用面板 / SPA+iframe+Canvas+OCR 兼容），任一都够独立 milestone。`src/content/` 当前是 placeholder（DOM 操作走 `executeScript`），引用功能需要常驻 content script 监听 selection / mousemove / click — 需先评估 ship 常驻 content script 的成本（vs 现有 `executeScript` 套路）+ 与 R15 image untrusted boundary 的协作。先 brainstorm 强制 narrow v1 — 推荐 v1 = 纯文字选中 → chat chip 注入 + 选中元素截图复用 Phase 5 image attach pipeline；v2 剥离组件边界 heuristic / iframe / Canvas+OCR。引用内容必须走 `<untrusted_page_content>` wrapper（同 R15 image boundary） |

**Acceptance gate（3 条共用）**：
- 都未单独 brainstorm 过；P0 的 issue body 最贴近 ready-to-plan，P1/P2 都需先走完整 brainstorm
- 都属于 panel↔SW wire shape 变化范围，**必须有 cross-layer regression test**（panel state model 变化必有 wire→DisplayMessage 透传测）
- P0 / P1 严格串行：#30 解掉 panel state 全局单态后再做 #34，否则两个 PR 互相会动同一批 refs / Map 结构

---

## 推荐推进顺序

> **2026-05-08 重排（能用 → 好用）**：产品已过"能用"阶段——Phase 0–5 + v1.5 multi-pin + Provider 中心 + 并发会话 + recording 全部 ship。本节评估标准从"用户痛感 × 解锁后续能力"（功能扩展导向）切换为"是否每天会卡 × 是否影响信任 × 单次 ship cost"（打磨导向）。新能力扩展（Ollama / 定时工作流 / 页内引用 / Skill 脚本化）后撤到第四梯队，日常摩擦修复前置。已交付路径归档至本节尾部，§1–§13 各主题 backlog 不动（它们仍是该主题的 single source of truth，但优先级以本节为准）。

### 第一梯队 — 用户每天会卡的真问题

1. **reject-3-strikes 软化（§13 P2 #45-6）** — ✅ **SHIPPED 2026-05-08**：升级为彻底删除 confirm 层（risk classifier / informed-approval / skip-permissions / K-10），详见 [v0.8.0 release notes](docs/release-notes/v0.8.0.md)
2. **Page snapshot 加 semantic 层（§13 P2 #44-3 / #45-3）** — interactive-only snapshot 让 LLM 在复杂页面"看不见报错/状态文案/表单 label"，是好用阶段最显眼失败模式。需 brainstorm 4 层观察（lightweight / semantic / fulltext / screenshot）默认值 + 每轮 token 成本 + R15 untrusted 边界协作
3. **Anthropic `cache_control: ephemeral` on image content blocks（§8 / §11）** — 一张图 × 6 轮 task ≈ 9.4K 重复 vision token；BYOK 成本痛点 #1，改动局部（content block 加字段），ROI 极高
4. **凭证场景 pause/resume（§13 P2 #45-7）** — 登录墙日常常见场景，当前只能 `fail`。M3 sandbox / lifecycle 基础设施可复用；scope 收得住

### 第二梯队 — 信任 / informed-approval 修复

5. **`tabTargets` / `contentPreview` wire drop 修复（§10 K-1）** — close_tabs / group_tabs / get_tab_content confirm card 丢 origin list + content preview，pre-existing Phase 3 gap，影响用户审批决策正确性。单 PR 可修
6. **业务按钮语义风险识别（§13 P2 #44-9）** — 提交 / 删除 / 支付 / 发布按钮缺业务级保护；当前 risk classifier 只看工具类型 + cross-origin args + 关键字

### 第三梯队 — 体验质量打磨

7. **快捷键支持（§1）** — 零结构性风险，高频用户体感差异大
8. **Settings toggle: 1568 ↔ 1092 max-edge（§8）** — 给 BYOK 用户成本控制权（Anthropic 高 / 低 tier 价差大）
9. **Phantom pin pruning（§10）** — 浏览器 crash / 手关 pinned tab 后 session 进降级状态；`removePinFromMeta` helper 已存在但无生产 caller

### 第四梯队 — 新能力扩展（"好用"阶段稳住后再考虑）

10. **Agent 中途插入指令（§12 #34, P1）** — 加分项不是日常卡点；scope 含糊先 brainstorm 收窄"附加 vs 覆盖 / 是否 confirm / 多条合并策略"3 处设计决策
11. **页内内容引用（§12 #38, P2）** — Phase 级 scope（4 个独立维度），打磨期不开新坑；需评估常驻 content script 成本 + 与 R15 image untrusted boundary 协作
12. **Ollama 本地模型（§1）** — 新 provider 维度，与"好用"正交；manifest + streaming 协议适配
13. **Skill 脚本化（§5 #2）** — 含义含糊，需先 narrow (a) JS handler / (b) DSL / (c) prompt 控制流 / (d) 录制回放 中的某一种
14. **定时工作流（§1）** — 依赖 SW 5 min 限制突破 + 任务持久化（Checkpoint & Resume M1/M2/M3 已 ship 但仍未触及 SW lifetime 命题）

### 后续阶段（设计权衡需深入，不适合打磨期速决）

- 元素 index → `{role, name, within}` 三元组（§13 P3 #44-4）— 成本极高（snapshot 协议 + LLM prompt + click/type/select 全部 tool 改），需先 spike 验证 LLM 定位准确率
- 任务级 / scope 级授权（§13 P3 #44-5 / #45-5）— 越权风险大，需精心设计避免 + 与 R10 first-run-confirm 协作
- 会话间用户偏好层（§13 P3 #45-11）— scope 含糊，需先 narrow 是 prompt 片段 / 行为习惯 / 站点 context note 哪一种
- page-match Skill 自动触发（§2）— 需先解决 prompt-injection-by-page 防御
- 安全规则下沉到工具层（§13 P3 #44-8 / #45-8）— 透明可审 vs 黑盒省 token 的 trade-off

### 已交付路径（按时间序，仅历史 traceability）

- ✅ Checkpoint & Resume M1/M2/M3（§3）— 2026-05-04 (PR #8 / #9 / #10 / #13)
- ✅ 多轮对话上下文（§6）— 2026-05-04 (PR #15 + #16)
- ✅ 多模态输入图片（§5 #1）— 2026-05-04 (PR #20)
- ✅ 行为录制 → Skill seed（§5 #4）— 2026-05-05 (v1)
- ✅ Chrome narrow / multi-pin / open_url / focus_tab（§5 #3）— 2026-05-05 (PR #21, manifest 0.5.2)
- ✅ Skill scope 解禁 + 全局 skip-permissions toggle — 2026-05-06 (PR #26)
- ✅ Confirm 层彻底删除（§13 P2 #45-6 升级版）— 2026-05-08
- ✅ Provider + Model 能力中心化（§7）+ Gemini provider（§1）+ DeepSeek provider — 2026-05-06 (PR #28)
- ✅ 自定义 OpenAI-compat Provider（§12）— 2026-05-07
- ✅ 并发会话支持（§12 #30, P0）— 2026-05-08
- ✅ §13 P1 quick wins（prompt drift + 软换行）— 2026-05-08 (PR #45)

---

## 12. 自定义 OpenAI-compat Provider — ✅ **SHIPPED 2026-05-07**

**Status**: Branch `feat/custom-providers-impl`，在 §7 multi-instance + per-model capability + Provider 模块化的基础上实现用户自定义 OpenAI-compat provider。

**Spec**: `docs/specs/2026-05-07-custom-providers-design.md`

**核心改动**：

1. **数据模型**：新实体 `StoredCustomProvider`（name / baseUrl / models[]）+ `CustomModelMeta`（vision / tools / maxContextTokens），storage key `custom_provider_${uuid}` + `custom_providers_index`。Provider 层解耦于 instance，对齐已有"provider × N instance"模式。
2. **类型系统**：`Provider` → `BuiltinProvider` + `ProviderRef = BuiltinProvider | \`custom:${string}\``，零迁移（老数据 `"openai"` 仍合法）。`ModelConfig.providerName?` 字段用于错误信息显示名。
3. **Dispatch 改造**：`streamChatByProvider` record → `dispatchStreamChat(config)` function，custom provider 直走 `_shared/openai-compat-core.ts`（不带 hooks，仅标准 Bearer auth）。
4. **Provider meta 异步解析**：`resolveProviderMeta(ref)` async 统一入口（builtin 同步查 registry，custom 从 storage 加载动态构造 `ProviderMeta`）。
5. **CRUD + cascade-block**：`src/lib/custom-providers.ts` 提供 `saveCustomProvider` / `updateCustomProvider` / `deleteCustomProvider`（有 instance 引用时 throw + 引导先删 instance）。
6. **通用 fetch helper**：`fetchOpenAICompatModels(baseUrl, apiKey?)` 带 URL 归一化（检测 `/v\d+$` 后缀避免 `/v1/v1/models` 404），`fetchOpenRouterModels` 重构为薄壳调通用 helper + OpenRouter 扩展字段。
7. **UI 组件**：`CustomProviderForm.tsx`（Name/BaseURL/Models/Test connection/Advanced per-model flags）+ `useProviderMeta.ts` hook。
8. **Settings UI**：新增 "CUSTOM PROVIDERS" section 平级于 "MY CONFIGS"，列出 provider + instance 计数 + edit/delete。
9. **Wizard 集成**：NewConfigWizard Step 1 可选 custom provider 或 "+ 创建新的 custom provider" 直达表单。
10. **Agent loop async**：`applyTokenBudget` / `streamChat` 改用 async `resolveProviderMeta`。

**文件清单（8 new + 9 modified）**：

| 新增 | 修改 |
|------|------|
| `src/lib/custom-providers.ts` | `src/lib/model-router/index.ts` |
| `src/lib/openai-compat-models-fetch.ts` | `src/lib/model-router/providers/registry.ts` |
| `src/sidepanel/components/CustomProviderForm.tsx` | `src/lib/model-router/providers/index.ts` |
| `src/sidepanel/hooks/useProviderMeta.ts` | `src/lib/model-router/providers/_shared/openai-compat-core.ts` |
| | `src/lib/instances.ts` |
| | `src/lib/openrouter-models-fetch.ts` |
| | `src/lib/agent/window-token-budget.ts` / `loop.ts` |
| | `src/sidepanel/components/Settings.tsx` / `InstanceForm.tsx` / `NewConfigWizard.tsx` / `ModelDropdown.tsx` / `Chat.tsx` |

**Invariant trace**：`docs/solutions/2026-05-07-custom-providers-invariant-trace.md`

**不做（明确 punt）**：
- Builtin provider 可编辑 baseUrl / model 列表 — 维持 `defaultBaseUrl` 唯一权威
- Custom provider 走 native protocol（Anthropic / Gemini wire format）
- Custom headers UI（HTTP-Referer / X-Title 等）
- 远程 preset 库
- Per-instance baseUrl override
- OpenRouter 之外的 builtin lazy `/v1/models`

---

## 13. Issue #44 / #45 模型侧设计审查（2026-05-08）

来源：[#44](https://github.com/WiseriaAI/Pie/issues/44)（9 大类高层建议）+ [#45](https://github.com/WiseriaAI/Pie/issues/45)（12 项细粒度）共 21 条。两条 issue 大量重叠，且约 60% 内容**基于对 tool/skill 分层的误读或过时认知**。下表按"用户痛感 × 实现就绪度 × 是否真问题"分级。

**关键事实校准**（issue 里的多数误读集中在这三点）：

1. **tool ≠ skill**：`take_screenshot` / `open_url_in_tab` / `extract_structured_data` / `auto_group_tabs` / `close_duplicate_tabs` / `create_skill_from_recording` 全部是 `src/lib/skills/builtin.ts` 里的 **built-in skill**（用户可见包装层），底层 tool 是 `capture_visible_tab` / `open_url` / `get_tab_content` / `group_tabs`。skill 是 LLM-driven workflow，最终调用 tool，不是 tool 重叠
2. **`allowedTools` 早已不是 required**：issue #26 (2026-05-06) 已删 R2 enforcement；`SkillDefinition.allowedTools: string[] | null`（`src/lib/skills/types.ts:37`）现在是可选。但 `prompt.ts:32-39` 的 `META_TOOL_GUIDANCE` 仍说 "allowedTools must be a non-empty array of currently registered tool names" — 这是 **prompt-vs-impl drift 真 bug**（见 P1）
3. **active/focus 双轨**：是有意为之的安全边界（用户视角 vs agent 操作目标分离），不是设计缺陷；`prompt.ts:49` 已显式说 "activate_tab does NOT change the agent's pinned tab"

### P1 — quick wins（独立可做、不需 brainstorm）

| 项 | 来源 | 备注 |
|---|---|---|
| **清理 `META_TOOL_GUIDANCE` 中过时 allowedTools 描述** | #45-1 / #45-12 | ✅ **SHIPPED 2026-05-08** as `d4adfa1` (PR #45)：prompt.ts META_TOOL_GUIDANCE 删过时声明，risk.ts confirm 卡 reason 字符串同步删 allowedTools 引用 + 孤儿 jsdoc 清理 |
| **`dispatch_keyboard_input` 软换行支持** | #45-10 | ✅ **SHIPPED 2026-05-08**：选方案 (b) — `softBreak?: boolean` 可选参，默认 false 向后兼容，true 时 \n → Shift+Enter (CDP modifiers=8)。`sendKeyPress` 加 `modifiers` 参数；prompt.ts KEYBOARD_SIM_GUIDANCE 加 hard/soft break 段；observation 文案 `paragraph break` ↔ `soft break` 区分；新建 `keyboard.test.ts` 4 cases 覆盖默认 / softBreak=true / 无 \n / 显式 false。770/770 tests pass。方案 (a) 不取：press_key 当前 KEY_MAP 不支持 modifier，文档化 `shift+enter` 前还要先扩 KEY_MAP，且 LLM 多行段需逐行 confirm 体验差 |

### P2 — 需 brainstorm 但 scope 较清晰

| 项 | 来源 | 备注 |
|---|---|---|
| **Page snapshot 加 semantic 层（标题 / 区块 / 状态文案 / 表单 label / 错误提示）** | #44-3 / #45-3 | ✅ **SHIPPED 2026-05-08**：单 PR 落地 spec [`2026-05-08-semantic-snapshot-design.md`](superpowers/specs/2026-05-08-semantic-snapshot-design.md)。snapshotInteractiveElements 单 executeScript 内增量采集 page-level（h1-h3 / role=alert / role=status / aria-live，per-field char caps + max counts）+ element-level（`<label for>` / aria-labelledby / ancestor `<label>` fallback chain，aria-invalid+describedby → error）。buildObservationMessage 渲染 `<untrusted_page_content>` 内 `Semantic:` / `Elements:` 子段，复用 wrapper 不增 sanitize 表面。HARD INVARIANT：所有 5 个新文本源走 sanitizeText。STATIC_AGENT_SYSTEM_PROMPT 加一行格式说明。snapshot.test.ts 31 case + prompt.test.ts 8 case + cross-layer.test.ts 3 case 覆盖 |
| **业务按钮语义风险识别** | #44-9 | 当前 risk classifier 只看工具类型 + 关键字 + cross-origin args；提交/删除/支付/发布按钮缺业务级保护。设计点：(a) DOM hint（按钮文案 + form context）→ risk 升级 (b) 高风险点击前要求 LLM 复述即将发生的动作 |
| **reject-3-strikes 软化** | #45-6 | ✅ **SHIPPED 2026-05-08**：升级为确认层彻底删除，不再有 reject 计数逻辑 |
| **凭证场景优雅降级（pause/resume）** | #45-7 | 当前登录墙只能 `fail`。设计点：task 主动 pause + UI 提示"等用户登录完成后继续" + resume 时重做最近 snapshot。M3 已有 sandbox/lifecycle 基础设施可复用 |

### P3 — 设计权衡需深入

| 项 | 来源 | 备注 |
|---|---|---|
| **元素 index 替换为 role + name + within 三元组** | #44-4 | 当前 `[N]` 索引每次 snapshot 重排，page 变化/弹窗后失效。改为 `{role: "button", name: "Create", within: "issue form"}` 是高价值改动，但成本极高（snapshot 协议 + LLM prompt + click/type/select 全部 tool 改）。需先 spike 验证 LLM 在三元组下定位准确率 |
| **任务级 / scope 级授权** | #44-5 / #45-5 | 当前 `get_tab_content` always-high 是有意（凭据 mirror 风险），但同 origin / 多步任务确认疲劳实在。设计点：(a) "本任务内允许读取当前 origin 内容" (b) "5 分钟内允许同 origin 截图"。提交/删除/跨域不放开。需精心设计避免越权 + 与 R10 first-run-confirm 协作 |
| **安全规则部分下沉到工具层** | #44-8 / #45-8 | prompt 现在偏长（KEYBOARD_SIM_GUIDANCE + META_TOOL_GUIDANCE + TAB_TOOLS_GUIDANCE 累计 ~180 行）。现实是 risk classifier 已下沉部分（CDP 永远 high / cross-origin args 自动升级），但 prompt 仍在重复声明。trade-off：透明可审 vs 黑盒省 token |
| **skill 与 tool 命名空间隔离** | #45-9 衍生 | issue 第 9 条本身是误读（已验证 `tools.ts` / `tools/*.ts` description 全部英文，中文都在 `skills/builtin.ts`），但暴露真问题：LLM 在工具列表里同时看到 tool（`open_url`）和 skill（`open_url_in_tab`）名字相近，认知摩擦。可考虑加 prefix（`skill__open_url_in_tab`）或 description 显式标注 "(skill — composes lower-level tools)"。有 storage migration 成本 |
| **会话间轻量持久化（用户偏好层）** | #45-11 | 当前持久层有：session（first-class）/ instance（provider 配置）/ skill（跨 session workflow）/ settings（全局）。"用户偏好"模糊 — 需先 narrow：是 (a) 跨 session 的常用 prompt 片段 (b) 用户行为习惯学习 (c) 项目/网站维度的 context note。类似 §2 "Agent 自主建议 Skill"，UX 不能成 confirm-fatigue 放大器 |

### P4 — YAGNI 风险高

| 项 | 来源 | 备注 |
|---|---|---|
| **输入工具自适应编辑器（系统侧识别 Notion / Monaco / CodeMirror）** | #44-6 / #45-2 部分 | 当前 prompt.ts:26 是 fail-fallback：`type` 失败返回 "hidden IME / keyboard capture buffer" → LLM 自动 fallback 到 `dispatch_keyboard_input`。这是 honest signaling，DOM 端编辑器类型检测 fragile（react contenteditable / 各种 shadow root / iframe），写好成本远超 fail-fallback。Punt |
| **合并工具到高层意图（read_page / open_page / input_text / interact_with_page）** | #44-1 后半 | "暴露大量底层工具 → 提供更稳定语义接口"是合理方向，但当前 9 个核心 tool 已经收敛，强行加一层 `interact_with_page(action)` 会变成路由器（违反 CLAUDE.md "不要预设抽象"）。LLM 已经能直接调底层工具，加意图层是 abstraction-for-its-own-sake |

### P5 — 不做（违反已落地的设计/不变量）

| 项 | 来源 | 备注 |
|---|---|---|
| **create_skill 增加 allowedTools 必填字段** | #45-1 / #45-12 | issue #26 (2026-05-06) 故意删了 R2 enforcement — 见 ROADMAP 顶部 "Skill scope 解禁 + 全局 skip-permissions toggle"。重新加回去等于回退 |
| **pinned/active/focus 合并为 switch_working_tab** | #44-2 / #45-4 | active vs focus 分离是有意安全边界（用户视角 vs agent 操作目标）。合并会让 "用户切 tab 看页面" 自动改 agent 操作目标 — 与 v1.5 multi-pin 设计冲突。`prompt.ts:49` 已显式澄清 |
| **"工具重叠"误读项** | #44-1 前 3 组 / #45-2 前 2 组 / #45-9 整条 | `take_screenshot` / `open_url_in_tab` / `extract_structured_data` 是 built-in **skill**，不是 tool；分层不是重叠。所谓"中英混杂"也是 skill description（中文）vs tool description（英文）的 by-design 分工 |

### 重复 / 已在 backlog

| 项 | 来源 | 备注 |
|---|---|---|
| **系统侧检测重复 workflow → 主动建议 Skill** | #44-7 | 重复 §2 "Agent 自主建议 / 推荐 Skill"；punt 理由相同（UX 不能成 confirm-fatigue 放大器） |
| **`type` vs `dispatch_keyboard_input` 真 tool 重叠** | #44-1 第 4 组 / #45-2 第 3 组 | 两者确实都是 tool，但分工已在 `prompt.ts:24-28` 明示（`type` 走 DOM input event，`dispatch_keyboard_input` 走 CDP）。移除任一会丢失 canvas 编辑器支持。归为"分层是 by design"而非 backlog 项 |

### 推进策略

- **P1 立即可做**：单 PR 修 prompt drift（45-1）+ 软换行支持（45-10），不进 §5 4-way 主线
- **P2 走 brainstorm 流程**：4 项各自需 brainstorm，与 §10/§11 已知 backlog 一同排队；优先级在 §12 #34 (P1) 之后
- **P3 留给观察期**：先看哪几项的用户报告最多再选着做
- **P4/P5 + 重复**：close issue 时点明，不入工作排期
