# Chrome AI Agent — Roadmap

延续 `docs/design.md` 的 Phase 0/1/2/3 终态。本文件是已交付 phase 状态 + 后续 backlog 的 single source of truth；invariant 级别细节见 `docs/solutions/`。

**已交付**：Phase 0 / 1 / 2 / 2.5 / 2.6 / 3 / 4 (M1 + M2 + M3) / 5 (multimodal v1) / v1.5 (multi-pin + open_url + focus_tab)。Skill scope 解禁 + 全局 skip-permissions toggle ([#26](docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md))。

本文件汇总各 brainstorm / plan 主动 defer 的 milestone，是后续工作的 backlog。每条目标是"够用以决定下一步"，不是 plan，立 plan 时再 `/ce:brainstorm` + `/ce:plan` 走完整链路。

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

> **Status (2026-05-04)**: Brainstorm 升级为 "session 作为 first-class persistent layer" → `docs/brainstorms/2026-05-02-checkpoint-resume-requirements.md`。Plan (14 unit / M1→M2→M3) → `docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md`，frontmatter status=`completed`. **M1 (PR #8)** single-session 持久化 + SW restart recovery + R11 drift card → `docs/solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md`。**M2 (PR #9 + #10 + 未编号)** multi-session UI drawer + LLM 标题 + LRU archive + 30d 硬删 + soft delete + storage indicator。**M3 (PR #13)** per-session port + per-session pinned tab/origin + R7 cross-session lock + ownerToken `{sessionId, tabId}` + queueTabOp 串行化 + R14 fail-on-image precondition (与 Phase 5 协同) → `docs/solutions/2026-05-03-multi-session-invariant-trace.md`。M3 残余 advisory 项见 §9。

**Original C1–C5 outline (now superseded by full plan above; kept for traceability)**:

`docs/brainstorms/2026-05-01-skill-autonomous-crud-requirements.md` L127–135 outline 级，**未单独 brainstorm**。Phase 2.6 plan 的 1 MB skill 配额 + 4 MB 余量已为它预留。

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

用户提出 4 个方向，brainstorm 评估 + 优先级摘要。详细评估见 `docs/brainstorms/2026-05-04-multimodal-image-input-requirements.md` 的同期对话记录。

| # | 方向 | 状态 | 下一步 |
|---|---|---|---|
| **1** | 多模态输入图片 | ✅ **PR #20 merged 2026-05-04**：v1 = 用户上传（粘贴/拖拽/按钮 ≤3 张，auto-resize 1568px JPEG q85 + EXIF strip）+ LLM screenshot tools (`capture_visible_tab` / `capture_fullpage_tab` 两者 always-high) + No-persist SW per-session cache (30MB/last-3-turn LRU，4 evict 路径) + Fail-on-image (R14 paused→failed) + R15 image untrusted boundary system prompt + Anthropic/OpenAI/OpenRouter 三家。15 task / 339→461 tests (+122 net) / R1-R15 全闭环。v1.1 follow-up 见 §8 | 完成 |
| **2** | Skill 脚本化（"完整 skill"） | ⚠️ **scope 含糊未深入**：必须先 narrow 含义到 (a) JS 自定义 tool handler / (b) DSL 描述固定步骤 / (c) prompt 加 control flow / (d) 录制+回放（与 #4 重叠）中的某一个。Manifest V3 CSP 对 (a) 是硬约束（禁 `eval`/`Function`，要 sandboxed iframe / Worker，BYOK trust model 重审）；(c) 与 LLM 自身 reasoning 重叠 YAGNI 风险高 | 单独 `/ce:brainstorm` 先 narrow 哪一种含义 + 当前 skill 系统真正卡住的用例 |
| **3** | 控制 Chrome 浏览器 | ✅ **SHIPPED 2026-05-05** (manifest 0.5.2, branch `feat/multi-pin-open-url-v15`, PR #21)：v1.5 Path A 全闭环 = `open_url(url, active=false)` + `focus_tab(tabId)` + **pinnedTabs[] schema** + per-iteration `currentFocusTabId` refresh + multi-select PinnedTabDropdown UI + URL allow-list (R6 显式 `protocol === 'http:'\|'https:'`) + IDN punycode 显示（防 homograph）+ always-high confirm + per-call SkillsList badge。10 task / 572 tests pass / @deprecated legacy single-pin fields 完全删除。**`nav_pinned_tab` cross-origin nav 仍推 v1.1 单独 brainstorm**——pre-multi-pin review 暴露 4 invariant 互动复杂度（R6 inTransitOrigin / R7 atomic swap / R9 CDP detach / R10 task-mutex）+ ADV-1 Premise collapse；R11 click-induced nav false-positive 才是用户最常见痛点，v1.5.1 评估优先级。Trace doc → `docs/solutions/2026-05-03-multi-session-invariant-trace.md` v1.5 章节；engineering patterns（phased deletion / dual-write shim / merge-not-replace snapshot / cross-storage integration tests）→ `docs/solutions/2026-05-05-cross-cutting-type-migration-lessons.md` | 完成；v1.5.1 backlog 见 §10 |
| **3.1** | nav_pinned_tab cross-origin (defer) | ⚠️ **推 v1.1**：原稿（pre-multi-pin）暴露 4 P0（SEC-2 server-side redirect / SEC-5 pin-in-transit 永久 DoS / ADV-2 inTransitOrigin race basis / ADV-3 shared-pin sessions broken）+ R11 click-induced false-positive 才是用户最常见痛点。需独立 brainstorm 收窄 4 invariant 设计 + 评估 R11 false-positive 修是否更高 ROI | 单独 `/ce:brainstorm` 在 multi-pin v1 ship 后；评估"R11 click-nav false-positive 修"作为更轻量替代 |
| **4** | 行为录制 + AI 创建 Skill | ✅ **SHIPPED 2026-05-05** (v1，单 tab + LLM-driven skill 创建)：sidepanel Record button → DOM event capture → Finish 后 trace 通过 chat 输入框 chip 注入 → user 加自由 prompt → LLM 显式调用 built-in skill `create_skill_from_recording` → 该 skill 调 create_skill meta tool → R10 first-run confirm 卡片作为 capability review surface。回放完全复用现有 ReAct + click/type 工具路径。所有 Phase 2.6 capability + Phase 3 cross-tab + M3 multi-session 自动兼容。同时新增 2 个 built-in skill（`take_screenshot` / `open_url_in_tab`）+ SkillsList 概念说明。trace doc → `docs/solutions/2026-05-05-record-and-replay-v1-invariant-trace.md`；plan + reframe note → `docs/superpowers/plans/2026-05-05-record-and-replay.md`。v1.1 backlog：cross-tab 录制 / N 行数据循环 / 重录覆盖 UX | 完成 |

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
- Spec: `docs/superpowers/specs/2026-05-06-provider-config-center-design.md`
- Plan: `docs/superpowers/plans/2026-05-06-provider-config-center.md`
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

来源 `docs/superpowers/plans/2026-05-04-multimodal-image-input.md` "Deferred to v1.1" + final review minor findings + post-acceptance bug doc。

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
| **P0** | [#30](https://github.com/WiseriaAI/Pie/issues/30) | feat(session): 并发会话支持 — 当前 task 后台继续 / 新建 session 不影响（M3-U6+） | SW 侧 PR #29 已 ship per-session port + per-task abortController + `pendingConfirmationsBySession` + `inFlightSessionIds`，**卡点纯 panel state migration**：`streaming` / `streamingText` / `error` / `toast` / `accumulatedRef` / `streamFinishedRef` / `messagesRef` / `portRef` 全部 `Map<sessionId, …>`；`handlePortMessage` routing 不再 drop non-current；`setActive` / `createAndActivate` 切 session 不 disconnect 仍在跑的 port；移除 #29 临时 streaming guard。Issue body checklist 已细到接近可直接进 `/ce:plan`，brainstorm 仅需 align 4 个设计决策：a) 后台 session 收 `agent-confirm-request` 怎么提示（drawer 红点已有但易错过） / b) CDP / image-cache / screenshot quota 全局上限 / c) session_index `lastAccessedAt` 抖动 / d) panel unmount 集中 disconnect 还是 task done 即时回收。同时关闭 §3 / §9 / §10 的 M3-U6+ 锚点。**需要 cross-layer 集成测试**（per memory `feedback_cross_layer_integration_tests`）：A 跑 → 新建 B → A 完成 → 切回 A 看到 done summary 的 wire→DisplayMessage 透传 |
| **P1** | [#34](https://github.com/WiseriaAI/Pie/issues/34) | feat: agent working 中途可发送新指令，当前单次 loop 完成后参与后续循环 | scope 含糊 — 必须先 `/ce:brainstorm` 收窄 3 处：a) "插入"是覆盖原始 task 还是纯附加 / b) 是否要二次 confirm / c) 同 loop 后多条 pending 是合并提交还是分批。默认建议：纯附加（不动 task） + 不 confirm（输入即排队） + 多条按时序合并到下一轮 user role + 用 `[User Mid-Task Instruction]:` 标签让 LLM 区分。与 #30 互补但**应在 #30 之后启动**：当前单 port + 单 streaming state 的 architecture 下，pending queue 会和 #29 streaming guard 互锁；#30 ship 后 pending queue 自然 per-session 隔离 |
| **P2** | [#38](https://github.com/WiseriaAI/Pie/issues/38) | feat: 输入时支持引用页内内容（组件元素、文字、图片）及划词显示组件 | 工作量最大、scope 最含糊、prompt-injection 风险最高。issue 含 4 个独立 feature 维度（DOM 元素引用 / 划词组件边界识别 / side panel 引用面板 / SPA+iframe+Canvas+OCR 兼容），任一都够独立 milestone。`src/content/` 当前是 placeholder（DOM 操作走 `executeScript`），引用功能需要常驻 content script 监听 selection / mousemove / click — 需先评估 ship 常驻 content script 的成本（vs 现有 `executeScript` 套路）+ 与 R15 image untrusted boundary 的协作。先 `/ce:brainstorm` 强制 narrow v1 — 推荐 v1 = 纯文字选中 → chat chip 注入 + 选中元素截图复用 Phase 5 image attach pipeline；v2 剥离组件边界 heuristic / iframe / Canvas+OCR。引用内容必须走 `<untrusted_page_content>` wrapper（同 R15 image boundary） |

**Acceptance gate（3 条共用）**：
- 都未单独 brainstorm 过；P0 的 issue body 最贴近 ready-to-plan，P1/P2 都需先走完整 `/ce:brainstorm`
- 都属于 panel↔SW wire shape 变化范围，**必须有 cross-layer regression test**（panel state model 变化必有 wire→DisplayMessage 透传测）
- P0 / P1 严格串行：#30 解掉 panel state 全局单态后再做 #34，否则两个 PR 互相会动同一批 refs / Map 结构

---

## 推荐推进顺序

按"用户痛感 × 解锁后续能力"性价比（已纳入 §5 4-way 评估 + §12 open issues）：

1. **多轮对话上下文（§6）** — ✅ **SHIPPED 2026-05-04**：PR #15 (Half A + Half B hybrid synth) + PR #16 (3 P1 residual)；plan completed；R1/R2 全闭环
2. **多模态输入图片（§5 #1）** — ✅ **PR #20 merged 2026-05-04**：15 task / 339→461 tests (+122 net) / R1-R15 全闭环；user acceptance 期间发现 2 个跨层集成 bug（first-task pin race + screenshotPreview wire transit）— 修复并 push (commits `0927031` + `517435d`) 已合并。Phase 5 v1.1 backlog 见 §8
3. **Provider + Model 能力中心化管理（§7）** — ✅ **SHIPPED 2026-05-06** as PR #28 (B+ scope)：multi-instance 配置中心 + per-model capability schema + Provider 模块化（`_shared/openai-compat-core` + 5 wrapper）+ Gemini native module + DeepSeek provider + V1→V2 silent migration + Composer InstanceSelector chip。21 commits / 700 tests pass。同时关闭 §1 Gemini provider 项 + §8 vision 子项的 schema 部分
4. **Chrome narrow（§5 #3）** — ✅ **SHIPPED 2026-05-05** as v1.5 Path A: `open_url` + `focus_tab` + multi-pin schema. 10 task / 572 tests pass / manifest 0.5.2 / PR #21. v1.5.1 backlog 详见 §10。Engineering patterns（4 个跨切层 type migration 模式）沉淀在 `docs/solutions/2026-05-05-cross-cutting-type-migration-lessons.md`
5. **行为录制 → Skill seed（§5 #4）** — ✅ **SHIPPED 2026-05-05** v1（单 tab + LLM-driven create_skill_from_recording）；v1.1 backlog: cross-tab 录制 / N 行数据循环 / 重录覆盖 UX
6. **Gemini provider** — ✅ **SHIPPED 2026-05-06** 与 §7 同期（PR #28）。Native module + `inline_data` + `?alt=sse` + `function_declarations` + manifest host_permission
7. **并发会话支持（§12 #30, P0）** — SW 已就绪（PR #29），纯 panel state migration（per-session Map + routing filter）；M3 系列 natural close-out；可直接进 `/ce:plan`
8. **Agent 中途插入指令（§12 #34, P1）** — 与 #30 互补；scope 含糊先 `/ce:brainstorm` 收窄 3 个设计决策；**应在 #30 ship 后启动**避免与 #29 临时 streaming guard 互锁
9. **页内内容引用（§12 #38, P2）** — Phase 级 scope（4 个独立维度）；先 `/ce:brainstorm` 强制 narrow v1（纯文字选中 chip + 选中元素截图复用 Phase 5 image attach），v2 剥离组件边界 / iframe / Canvas+OCR；需评估常驻 content script 成本
10. **Ollama 本地模型** — 与 BYOK 定位契合；manifest + streaming 协议适配
11. **快捷键支持** — 打磨项，零结构性风险
12. **Skill 脚本化（§5 #2）** — 收窄 (a)/(b)/(c)/(d) 后再决定
13. **page-match 自动触发** — 需要先解决 prompt-injection-by-page 防御

Checkpoint & Resume 的 M1 已 ship；M2/M3 PR #10 / #13 已 ship。定时工作流仍依赖 SW 5 min 限制突破。
