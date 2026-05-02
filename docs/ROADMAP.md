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
| **任务状态持久化（SW 重启恢复）** | design.md L91 | 现状 SW restart 即终止 in-flight 任务；与下方 Checkpoint & Resume 合并实施 |
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

## 3. Checkpoint & Resume（Phase 2.6 brainstorm 附录 C1–C5）— **PLAN READY (in implementation)**

> **Status (2026-05-02)**: Brainstorm 升级为 "session 作为 first-class persistent layer" → `docs/brainstorms/2026-05-02-checkpoint-resume-requirements.md`。Plan 已 ship (14 unit / M1→M2→M3) → `docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md`。两次 document-review 已 apply 25+ auto-fixes 含 P0-A R28 范式重审 (storage 持 raw + panel-display redaction)。手动 `/ce:work docs/plans/2026-05-02-001-...` 推进 M1-U1 即可。

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

## 5. 多轮对话上下文（pre-existing gap, 用户 2026-05-02 报告）

**Status**: 非 M1 / M2 / M3 范围。Phase 2 起 SW 端 `background/index.ts:226-227` 只取最后一个 user message 作为 `task` 字符串丢给 `runAgentLoop`，**LLM 每轮都从零开始**——panel 累积的 user/assistant DisplayMessage 在 wire 层被 SW 直接丢弃。从 ChatGPT 风格"多轮对话"视角看是缺陷；从"每个 sendMessage 是独立 task"语义看是 by-design。当前实现倾向后者，但用户体感倾向前者。

**Two halves（必须一起设计，单独修半 A 只是把症状从 100% 降到 50%）**:

- **半 A：纯 chat 多轮**——`handleChatStream` 把整个 `messages` 数组传给 `runAgentLoop`，起手 `history = [system, ...messages]`。`useSession` 已经把 user/assistant DisplayMessage filter 留出来发上来了，纯改 SW 侧 ~10 行
- **半 B：agent 任务多轮（设计决策）**——`useSession.sendMessage` 的 filter 把 agent-step / agent-confirm / agent-summary 全丢掉，导致 agent task 后接着对话时 LLM 看到连续两个 user message（多家 provider 直接 400）。需要决定前一轮 agent task 以什么形态作为 assistant turn 喂给 LLM：
  - 选项 1：用 `agent-summary.summary` 作为 assistant turn
  - 选项 2：完整 agent IR（tool_use + tool_result）翻译——但 M1-U3 tombstone 已清掉
  - 选项 3：合成"上一轮做了 X / 看到了 Y"摘要

**前置依赖**：M1 完成（不阻塞但简化 trade-off 视野）；与 `applySlidingWindow` token 预算策略联动。

**建议路径**：M1 完整 ship 后单独 `/ce:brainstorm` + `/ce:plan`，不塞进 session-persistent-layer plan。

---

## 推荐推进顺序

按"用户痛感 × 解锁后续能力"性价比：

1. **Checkpoint & Resume（C1–C5）** — 解锁 design.md 原始硬需求 + 解决 SW restart 吞任务的最大体感问题；同时是定时工作流的前置
2. **Gemini provider** — 最小补丁，registry 加 entry；履行 design.md 三大 provider 承诺
3. **Ollama 本地模型** — 与 BYOK 定位高度契合；需要 manifest + streaming 协议适配
4. **快捷键支持** — 打磨项，零结构性风险
5. **page-match 自动触发** 或 **操作录制 → skill 生成** — Skill 框架升级方向，但需要先解决 prompt-injection-by-page 防御

定时工作流依赖 Checkpoint，应排在 1 之后。
