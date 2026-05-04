# Chrome AI Agent — Roadmap

延续 `docs/design.md` 的 Phase 0/1/2/3 终态。当前已交付的 Phase 详见 `CLAUDE.md` 的 Progress 段（Phase 1 / 2 / 2.5 / 2.6 / 3 已 COMPLETED）。

本文件汇总各 brainstorm / plan 主动 defer 的 milestone，是后续工作的 backlog。每条目标是"够用以决定下一步"，不是 plan，立 plan 时再 `/ce:brainstorm` + `/ce:plan` 走完整链路。

---

## 1. design.md 原始构想中仍未交付的项

| 项 | 来源 | 备注 |
|---|---|---|
| **Gemini provider** | design.md L80, L135 | registry pattern 加 entry 即可，差 host_permission |
| **Ollama / 本地模型** | design.md L80–82, L135 | 需 manifest 加 `http://localhost/*`，streaming 协议适配 |
| **快捷键支持** | design.md L136 | 零结构性风险的打磨项 |
| **任务状态持久化（SW 重启恢复）** | design.md L91 | ✅ M1 partial done (PR #8) — single-session SW-restart recovery + tombstone + R11 drift card. M2/M3 (多 session UI / per-session sandbox) 仍待 |
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

## 3. Checkpoint & Resume（Phase 2.6 brainstorm 附录 C1–C5）— **M1 SHIPPED · M2/M3 pending**

> **Status (2026-05-02)**: Brainstorm 升级为 "session 作为 first-class persistent layer" → `docs/brainstorms/2026-05-02-checkpoint-resume-requirements.md`。Plan (14 unit / M1→M2→M3) → `docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md`，frontmatter status=`m1-shipped`. **M1 (U1-U5) 已 ship via PR #8** (single-session 持久化 + SW restart recovery + R11 drift card)。M1 关键 invariants + 踩过的坑 → `docs/solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md`。**M2 (multi-session UI: drawer / LLM 标题 / LRU archive) 与 M3 (per-session sandbox) 在新 PR 单独推进** —— 不要堆在 m1 分支上。

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
| **1** | 多模态输入图片 | ✅ **已 nail down + 7-reviewer review + 4 high-decision resolve**：`docs/brainstorms/2026-05-04-multimodal-image-input-requirements.md`。v1 范围 = 用户上传（粘贴/拖拽/按钮，多图 ≤ 3，auto-resize 1568px JPEG q85 + EXIF strip）+ LLM 主动调 screenshot tool（仅 pinned tab，visible / fullPage 二选一，**两者都 default high 风险**）+ **No-persist storage + Per-session in-memory cache**（SW Map 30 MB/last-3-turn LRU，5 evict 路径）+ **Fail-on-image**（含 image 的 paused → failed，不可 resume）+ **image untrusted boundary system prompt** + Anthropic/OpenAI/OpenRouter 第一波。Resolve-Before-Planning 3 项：ChatMessage IR shape / resize 执行环境 / CDP fullPage attach lifecycle | → `/ce:plan` |
| **2** | Skill 脚本化（"完整 skill"） | ⚠️ **scope 含糊未深入**：必须先 narrow 含义到 (a) JS 自定义 tool handler / (b) DSL 描述固定步骤 / (c) prompt 加 control flow / (d) 录制+回放（与 #4 重叠）中的某一个。Manifest V3 CSP 对 (a) 是硬约束（禁 `eval`/`Function`，要 sandboxed iframe / Worker，BYOK trust model 重审）；(c) 与 LLM 自身 reasoning 重叠 YAGNI 风险高 | 单独 `/ce:brainstorm` 先 narrow 哪一种含义 + 当前 skill 系统真正卡住的用例 |
| **3** | 控制 Chrome 浏览器 | ✅ **已 nail down + 4-reviewer review + multi-pin pivot**：`docs/brainstorms/2026-05-04-tabs-create-and-nav-requirements.md`。v1 范围 = `open_url(url, active=false)` + **pinnedTabs 升级为 array**（schema migration: SessionMeta `pinnedTabId`/`pinnedOrigin` → `pinnedTabs: Array<{tabId, origin}>`）+ URL allow-list (R6 显式 `protocol === 'http:'\|'https:'`) + IDN punycode 显示（防 homograph）+ always-high confirm。v1 估时 2-3 天。**`nav_pinned_tab` cross-origin nav 推 v1.1 单独 brainstorm**——review 暴露 4 invariant 互动复杂度（R6 inTransitOrigin / R7 atomic swap / R9 CDP detach / R10 task-mutex）+ ADV-1 Premise collapse（多步表单实际是 click-induced nav 而非 nav 工具能解）。Resolve-Before-Planning 4 项：schema migration 路径 / tabId 选择策略 / R7 cross-session 在 multi-pin 下行为 / URL.protocol 边界 | → `/ce:plan` |
| **3.1** | nav_pinned_tab cross-origin (defer) | ⚠️ **推 v1.1**：原稿（pre-multi-pin）暴露 4 P0（SEC-2 server-side redirect / SEC-5 pin-in-transit 永久 DoS / ADV-2 inTransitOrigin race basis / ADV-3 shared-pin sessions broken）+ R11 click-induced false-positive 才是用户最常见痛点。需独立 brainstorm 收窄 4 invariant 设计 + 评估 R11 false-positive 修是否更高 ROI | 单独 `/ce:brainstorm` 在 multi-pin v1 ship 后；评估"R11 click-nav false-positive 修"作为更轻量替代 |
| **4** | 行为录制 + AI 回放循环操作 | ⚠️ **与 §2 "操作录制 → Skill 自动生成"重叠，需收窄**：关键 tradeoff = 机械回放（fast，selector 易失效）vs LLM-assisted 回放（智能，token 翻倍）；参数化 + 数据源（剪贴板 / sheet / sidepanel UI 输入）+ 错误恢复策略未定。隐藏需求可能是 "**手动跑一次让 AI 学会**"（trace-as-skill-seed），与方向 2 (d) 收敛到同一形态 | 单独 `/ce:brainstorm` 收窄到 trace-as-skill-seed 模式 + 录制粒度（DOM 事件 vs CDP）+ 参数化模型 |

**4 个方向都不是单条 PR 能拿下的 scope**——除了方向 1 已 nail，2/3/4 各自至少 1 轮独立 brainstorm 才能进 plan。

## 6. 多轮对话上下文（pre-existing gap, 用户 2026-05-02 报告）

**Status**: 非 M1 / M2 / M3 范围。Phase 2 起 SW 端 `background/index.ts:226-227` 只取最后一个 user message 作为 `task` 字符串丢给 `runAgentLoop`，**LLM 每轮都从零开始**——panel 累积的 user/assistant DisplayMessage 在 wire 层被 SW 直接丢弃。从 ChatGPT 风格"多轮对话"视角看是缺陷；从"每个 sendMessage 是独立 task"语义看是 by-design。当前实现倾向后者，但用户体感倾向前者。

**Two halves（必须一起设计，单独修半 A 只是把症状从 100% 降到 50%）**:

- **半 A：纯 chat 多轮**——`handleChatStream` 把整个 `messages` 数组传给 `runAgentLoop`，起手 `history = [system, ...messages]`。`useSession` 已经把 user/assistant DisplayMessage filter 留出来发上来了，纯改 SW 侧 ~10 行
- **半 B：agent 任务多轮（设计决策）**——`useSession.sendMessage` 的 filter 把 agent-step / agent-confirm / agent-summary 全丢掉，导致 agent task 后接着对话时 LLM 看到连续两个 user message（多家 provider 直接 400）。需要决定前一轮 agent task 以什么形态作为 assistant turn 喂给 LLM：
  - 选项 1：用 `agent-summary.summary` 作为 assistant turn
  - 选项 2：完整 agent IR（tool_use + tool_result）翻译——但 M1-U3 tombstone 已清掉
  - 选项 3：合成"上一轮做了 X / 看到了 Y"摘要

**前置依赖**：✅ M1 完成 (2026-05-02, PR #8)；与 `applySlidingWindow` token 预算策略联动。

**建议路径**：M1 已 ship — **可以开始单独 `/ce:brainstorm` + `/ce:plan`**，不塞进 session-persistent-layer plan。Half A 半小时改完 SW 一处取 `task` 的逻辑改用整个 messages 数组；Half B 需要决定上一轮 agent task IR (tool_use / tool_result / agent-summary) 怎么呈现成 assistant turn — 三个候选 (`agent-summary` 文本 / 完整 IR 翻译 / 合成摘要)。

---

## 推荐推进顺序

按"用户痛感 × 解锁后续能力"性价比（已纳入 §5 4-way 评估结果）：

1. **多轮对话上下文（§6）** — Half A 半小时 + Half B 决策 1 个；用户已报告，用户痛感最直接
2. **多模态输入图片（§5 #1）** — `/ce:plan` 已就绪，model-router IR 升级 + screenshot tool 一次性投入，长期回报大
3. **Chrome narrow（§5 #3）** — `tabs.create` + `open_url`，1-2 天，与 Phase 3 同套机制
4. **Gemini provider** — 最小补丁；与多模态输入图片解耦但同期做有协同（registry 加 entry + manifest + Gemini SSE / vision 协议）
5. **Ollama 本地模型** — 与 BYOK 定位契合；manifest + streaming 协议适配
6. **快捷键支持** — 打磨项，零结构性风险
7. **行为录制 → Skill seed（§5 #4）** — 收窄后单独 plan；产品差异化大但工程量高
8. **Skill 脚本化（§5 #2）** — 收窄 (a)/(b)/(c)/(d) 后再决定
9. **page-match 自动触发** — 需要先解决 prompt-injection-by-page 防御

Checkpoint & Resume 的 M1 已 ship；M2/M3 PR #10 / #13 已 ship。定时工作流仍依赖 SW 5 min 限制突破。
