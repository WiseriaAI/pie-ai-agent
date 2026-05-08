---
date: 2026-05-02
topic: checkpoint-resume
---

# Checkpoint & Resume — 升级为 Session 持久化层

> **Framing 升级说明**：本文档原始 topic 是 "checkpoint & resume"（Phase 2.6 brainstorm 附录 C1–C5）。Brainstorm 过程中 framing 从"任务断点续跑"升级为 **"session 作为 first-class persistent layer"** —— 所有 chat / agent task / pinned context 都绑定到 session，session 持久化到 storage。C1–C5 是这个新模型的一个特例。

## Problem Frame

当前会话状态没有专属持久层，而是寄生在 React component state 和 Service Worker 内存里：

| 现状 | 触发条件 | 数据丢什么 |
|---|---|---|
| Chat messages 在 React state（`App.tsx:80-91` 条件渲染 `<Chat>`） | 切 sidepanel tab、关 Side Panel | 全部聊天记录 |
| Agent task 在 SW 内存（`background/index.ts:268-316`） | SW idle (30s) / restart | in-flight task + pending confirm + skill 作用域栈 |
| port connection | 上面任意一个 | 流式 stream 中断 |

**同一个根因，三种症状**：
- **高频**：用户改个 provider 配置切到 settings → 整段 Chat 消失
- **中频**：SW idle 30s 终止 → in-flight agent task 直接没了
- **中频**：confirm 卡 pending 期间用户没点 → Side Panel 关 / SW idle 后卡和 task 一起丢

用户原始诉求：(1) 上面三种症状全部消除；(2) 多会话历史可管理（类 ChatGPT）；(3) 为 ROADMAP 中的"定时工作流"铺 schema-first 地基。

> **关于 Goal 3 的范围澄清**（回应 PRD-4 / SG-6）：本 brainstorm 不为定时工作流加专属字段（无 trigger source / scheduled-at / cron expression / alarm origin 等）。Goal 3 的"地基"仅靠 (a) session-as-first-class-object（定时任务可作为新 session 创建）、(b) status 状态机（已含 paused，定时任务复用即可）、(c) R3 持久化机制（替 alarm-driven 任务恢复 reuse）三条间接铺出。任何为定时工作流真正服务的字段、API、UI 都留给那个 milestone 单独 brainstorm。

## Requirements

**Session as First-Class Persistent Layer**

- R1. Session 是顶层对象，每条 session 独立持有：messages 历史、active agent task（若有）、pinned tab + pinned origin、**skillExecutionScopeStack**（per-session 的 skill 调用栈；与 R25 提到的 skill **definition** CRUD 是全局这两件事互不冲突）、createdAt、lastAccessedAt（用户切到该 session / 该 session 收到新 message / 该 session 的 agent step 推进 三种事件触发更新；用于 R15 LRU 排序）、status (`active | paused | done | failed | archived`)
- R2. Chat messages 切 sidepanel tab（chat ↔ settings ↔ agent ↔ tabs）后回来不丢
- R3. Agent in-flight task 的状态在每个 step 边界 snapshot 到 storage（包含完整 agentMessages、当前 step index、pinned context、per-session skillExecutionScopeStack）
- R4. Pending confirm 完整上下文（risk、args、preview、tabTargets、metaSkillPreview）随 session 持久化，**仅用于 SW 未终止场景下 panel 重连后恢复显示**（用户切 sub-view / 暂关 sidepanel 后重开，SW 进程仍 alive、pending Promise 仍 in-memory）。**SW 进程死亡场景下该 pending confirm 不可信任 resume**：见 R10 abort 路径

**Multi-Thread Sandbox（真多 thread）**

- R5. 支持任意数量并发 active session 的 **logical isolation, shared lifecycle** 模型：每 session 独立 abort signal、独立 pinned tab/origin、独立 CDP context (owner-token = `(sessionId, tabId)`)、独立 confirm queue；**keep-alive 是 SW 单层共享** —— 任一 active session 的 port 维持整个 SW alive。Sidepanel 整体关闭后所有 port 断、SW 30s 终止，统一靠 R3 持久化 + R10 cold restart resume 兜底。**K4 "切走不丢" 的覆盖范围 = sub-view 切换（chat ↔ settings ↔ ...）+ sidepanel 暂关（靠持久化）；不覆盖 OS 重启 / chrome 强杀进程**
- R6. CDP keyboard owner-token 升级为 `(sessionId, tabId)` 二元组；同一 tab 不允许多 session 同时 CDP attach（架构限制）
- R7. Pinned tab 冲突策略 = **读写分流**：
  - **Read 类**（list_tabs / extract / get_tab_content / snapshot DOM）允许同 tab 多 session 并发，跨 session content reach 由 K9 + Phase 3 confirm 兜底
  - **Write 类**（v1 显式 commit 集合：`click` / `type` / `select_option` / `dispatch_keyboard_input` / `press_key` / `close_tabs` / `move_tabs` / `group_tabs` / `ungroup_tabs` / `activate_tab` / 任何触发 navigation 或 chrome.tabs.update 的工具）发现同 tab 已被另一 active session pin 时，后到者拒绝并 toast "Tab '...' 正被会话 X 使用"
  - **R26 P3-J 在 multi-session 下的释义**：`close_tabs` deny 的"pinned tab"指**任意 active session pin 的 tab**（不仅是当前 session）
  - 该列表通过 plan 阶段实现为 BUILT_IN_TOOLS 元数据 `class: 'read' | 'write'` 字段，risk.ts / R7 lock checker / Phase 2.6 P1-G 的 ALL_KNOWN_NON_SKILL_TOOL_NAMES 共享同一登记表
- R8. R10 (Phase 2.6 first-run confirm) 的 `firstRunConfirmedAt` 是 per-skill 字段，跨 session 复用 —— 在 session A 已 confirm 的 agent-authored skill，在 session B 不再二次 confirm。**(reflects existing Phase 2.6 storage shape; no new implementation — see Dependencies)**

**Recovery & Pinned Tab Drift**

- R9. 不提供主动 Pause 按钮（多 thread "切 sub-view / 暂关 sidepanel 不影响 task" 已覆盖手动场景）；**但 SW 进程死亡触发的 cold start 自动转 paused 不静默 resume** —— 见 R10
- R10. SW restart 检测每条 session 的 `status='active'` 且有 in-flight task：
  - **若含未 resolve 的 pending confirm record → 直接标 task=failed**（"任务在等待确认时进程被终止，状态不可信，请重新发起"，session 仍可用）。守住 Phase 2.6 informed-approval 不变量
  - **否则 → 自动转 `status='paused'`，session list 显示 'Resume task' 按钮**；用户手动点击 Resume 才进入 R11 pinned tab 漂移检查 + 续跑路径。守住 BYOK informed-spending —— "Chrome 昨晚崩溃今早自动烧 N tokens" 是默认禁止的体感
  - Side Panel 重开但 SW 未死场景下 panel 重连，task 状态从 SW 内存读取，不走以上路径（沿用 R4 in-memory pending confirm 恢复显示路径）
- R11. Resume 时若 pinned tab 仍存在且 origin 未变 → 静默继续；若 tab 已关 / origin 已变 → 在该 session 顶部弹 informed-approval 卡，**v1 仅 1 个 action: "丢弃任务"**。卡内显示原 pinned tab 标题 + origin + 最后完成的 step 摘要 + tokens-since-start，让用户知道丢了什么；点击 "丢弃" 后任务标 `failed`，session 仍可用，用户可在该 session 输入新 prompt 重起新 task。**"在新 tab 重启" / "在指定 tab 续跑" 显式 out of scope** —— 前者要求 SW 自动打开 URL（隐式权限扩张），后者要求 user-mediated origin re-pin（破 Phase 2 K-1 task-start origin pinning 不变量）。Plan 阶段可评估"在该 session 输入新 prompt 时自动 fork 一份原 agentMessages 上下文给 LLM 看"作为补偿 UX
- R12. LLM stream 单次超 5min 这种边界 v1 不处理（属另一 milestone：长任务分段调度）；resume 不重连已中断的 fetch，从下一个 step 重新规划

**Confirm 卡多 session 定向**

- R13. Confirm 卡仅在该 session active 视图内显示；其他 session 在 list 加 'pending confirm' badge（黄色 dot + 文本）；切回该 session 才能看到完整 confirm context
- R14. 守住 Phase 2.6 "informed approval = 用户看到完整内容 = 立即生效" 不变量 —— 不引入全局通知中心式聚合 confirm 卡（避免 context 丢失风险）

**Storage & Lifecycle**

- R15. LRU 自动 archive：当 `chrome.storage.local.getBytesInUse()` **总字节数**（含非-session 数据）超 8MB **或** active session 数超 50 时，自动把 `lastAccessedAt` 最早的 active session 标 `status='archived'`。**Archive 操作必须实际释放空间**（移到 archived-bucket key + 压缩 / 清理 messages 大字段），不能仅翻 status 标志
- R16. Archived session 默认不在主 list 显示，'Show archived' 按钮可展开；可恢复为 active
- R17. Archived session 30 天后硬删（按 `archivedAt` 字段排序）；在 storage budget 内手动恢复不重置 archive 时钟
- R18. 用户主动删除 session = 软删（标 archived + archivedAt = now），与 LRU archive 进入同一 30 天硬删队列
- R19. Storage 预留 ≥2MB 给非-session 数据（Phase 2.6 的 1MB skill 配额 + provider 配置 + 未来 checkpoint metadata 等）

**UI / Onboarding**

- R20. Session list 在 sidepanel **左侧可折叠抽屉** 中（默认 collapsed 仅一列窄 icon, 展开 ~200px 宽显示完整 list）。每条 session 显示标题 + lastAccessedAt 时间 + 状态图标（`active / paused / running / pending confirm / done / failed`）。Bottom nav (chat / settings) 保留；废弃 agent / tabs 两个 placeholder tab。**sidepanel 顶部加一个 'N pending' 总 badge** —— 汇总所有 session 的 pending confirm 数；用户切到 settings 时仍可见，守住 K3 informed-approval 跨 sub-view 可见性。`paused` 状态 session 在行内显示 'Resume task' 按钮（点击进入 R11 pinned tab 漂移检查）
- R21. 'New Session' 按钮在 session list 顶部 + sidepanel 顶栏 + (空 list 状态) 主区域 onboarding hint 三处入口；插件首次安装 / 首次打开 sidepanel 时自动建一条 'New Session'
- R22. Session 标题 = 首条 user message 发出后后台异步调 LLM 总结 5-10 字；总结失败 fallback 到首条 message 前 30 字；用户可手动编辑标题
- R23. 通过 `/<skill>` 触发时，若当前 active session 已 archived → 自动建新 session 后再触发

**Cross-Phase Invariant Preservation** *(acceptance gates; per-invariant adaptation trace 表 deferred to plan — see Outstanding Questions)*

- R24. Phase 2.5 CDP keyboard 5-path idempotent detach 在 multi-session 下仍成立（per-session detach 不影响其他 session 的 CDP 状态）
- R25. Phase 2.6 全部 8 条 capability-grant invariants 在 multi-session 下仍成立（skill **definition** CRUD 是全局的，不分 session；skill **execution** scope stack per-session 见 R1 / R3）
- R26. Phase 3 全部 19 条 cross-tab invariants（P3-A 到 P3-V）在 multi-session 下仍成立；其中 K-1 origin 漂移检测、K-8 confirm-time origin re-verify 升级为 per-session

**Newly-Added Invariants（mechanical inheritance from prior phases）**

- R27. **A11y baseline inheritance**: Session list 是 `role="list"` 容器、每行 `role="listitem"`；'pending confirm' badge 携带 `aria-label`；R11 informed-approval 卡继承 Phase 3 R13/P3-V baseline (`role="dialog"` + `aria-labelledby` + 焦点管理 + per-option `aria-describedby`)；write-conflict toast 用 `role="alert"`
- R28. **Panel-display redaction 不变量 + R4 pending-confirm raw 即时 scrub (P0-A v2 plan-阶段重审, 原文档错误已修订)**: Phase 2.5 binary channel 原意 = panel 显 redacted (防 shoulder-surf) + LLM 看 raw (需要 semantic context 规划下一步); storage 持 raw agentMessages 为 LLM resume 提供完整 context (本地 attacker 已能读 storage 与 Phase 1 一致, 加 redact 仅"双重不安全"+ break LLM resume); **panel display 路径** (任何渲染 agentMessages 给 UI 的代码) 必须走 redactArgsForPanel; R4 pending confirm raw 字段一旦 confirm resolved (approve/reject/abort) 必须立即从 storage 移除, 不进入 archived 状态; 不存 API key (C4 原文)。**变更原因**: 此 R 在 brainstorm 写作时把"Phase 2.5 redaction 不变量"误推广为"storage 也 redact"; plan-阶段 review (ADV-1 + PRD-5) 发现这会破坏 LLM resume 的 semantic memory; 重审后回到 Phase 2.5 binary channel 原意
- R29. **LLM 标题 input/output sanitize (Phase 3 P3-O inheritance)**: R22 标题生成的 LLM input 必须把首条 user message 用 `<untrusted_user_message>` wrapper 包裹（防 prompt injection 操控标题）；output 必须经 `escapeUntrustedWrappers` 处理后渲染（防 wrapper 闭合标签逃逸）；标题渲染走纯文本通道（不经 markdown / HTML）；fallback 路径（首条 message 前 30 字）同样走 sanitize

## Success Criteria

- 用户在跑 agent task 时切到 settings 改 provider 再切回 chat → task 仍在跑，完整 chat 历史和 agent step 都在
- SW idle 30s 后被回收 → 重新打开 Side Panel，未完成 session 自动恢复（或 pinned tab 已关时弹 informed-approval 卡）
- 在 session A 跑长 task 时，能开 session B 跑独立的 task；两条互不干扰；CDP / pinned tab 写冲突时后到者收到清晰的拒绝提示
- Session B 弹了 confirm 卡，用户在 session A 时 session list 出现 'pending confirm' badge；切回 B 看到完整 confirm context
- 50 条 session 累积后自动 archive 最早的；archived 30 天后从 storage 消失
- v1 ship 后无需 manifest 加 `unlimitedStorage` 权限

## Scope Boundaries

**In scope**：
- Session 数据层（schema、storage、CRUD、archive 状态机）
- Multi-thread 沙箱化改造（per-session pinned tab/origin、CDP owner-token 升级、abort signal、keep-alive）
- Sidepanel UI 改造（session list、切换、命名、归档、'pending confirm' badge）
- Resume 流程（SW restart 检测 + pinned tab 漂移 informed-approval 卡）
- LLM 标题异步总结
- LRU archive + 30 天硬删

**v1 ship order (commitment)**: plan 阶段必须组织为 M1 → M2 → M3 三个独立可 ship 的 milestone，前一个未完成不开始下一个：
- **M1 单 session 持久化**: R3 + R4 + R10 + R11 + R28 + Auto-fix R1 lastAccessedAt — 解三大用户症状（切 sub-view 不丢 / SW restart 自动恢复 / pending confirm 不丢）
- **M2 多 session UI 但同时仅 1 active task**: R1 + R2 + R20–R23 + R27 + R29 + R15–R19 (LRU + archive + 软删) — list / 命名 / 归档完整体验
- **M3 真多 thread sandbox**: R5 + R6 + R7 + R8 + R13 + R14 + R26 + 跨 phase invariant trace 表 — 完成 ChatGPT-like 并发能力

**Out of scope（明确 v1 不做）**：
- 主动 Pause 按钮（用户主动停 task 烧 token 的能力；与 SW 死亡触发的隐式 paused 不同）—— 属定时工作流范畴留 v2
- LLM stream 中途 5min 超时续传（属"长任务分段调度"另一 milestone）
- 跨设备同步（chrome.storage.sync）
- IndexedDB 分层存储（v1 全走 chrome.storage.local，超 quota 走 LRU archive）
- 定时工作流 / scheduled resume（schema-first 铺地，但不做 alarm-driven）
- 全局 confirm 通知中心 / Chrome notifications API
- Per-session 独立 provider 配置（active provider 仍全局，避免 settings 也 session 化的复杂度）
- Session 共享 / 导出 / marketplace
- LLM 标题生成的多语言 / 风格定制
- R11 resume 卡的 "在新 tab 重启" / "在指定 tab 续跑" 分支（仅保留 "丢弃任务"；前者隐式权限扩张，后者破 Phase 2 K-1 origin pinning 不变量）

## Key Decisions

- **K1 真多 thread + 资源沙箱化**：选最贵的方案。理由：单 active 限制（K3 选项 1）和"切自动 pause"（选项 2）都让 ChatGPT-like UX 不彻底；既然要做就做透。CDP owner-token / pinned tab 等共享资源升级为 per-session 是必要工作量
- **K2 Pinned tab 读写分流**：write 互斥避免数据 race，read 并发避免"同时浏览同一页面"被无谓阻塞。代价是 risk.ts 需要新增 read/write tool-class 标记 —— plan 阶段细化
- **K3 Confirm 卡定向 = active session 内 + badge**：守住 Phase 2.6 "informed approval = 看到完整 context" 不变量比 UX 便利更重要；'pending confirm' badge 提供发现路径
- **K4 v1 不做主动 Pause 按钮，但 SW 进程死亡触发隐式 paused**：多 thread 解决"用户手动切 sub-view 不丢"。SW restart 后无 pending confirm 的 task 默认转 `paused`（用户手动点 Resume 才续）—— 这是对 BYOK informed-spending 的硬约束，不是主动 Pause 能力。主动 Pause 按钮（"现在停止烧 token, 我稍后回来"）属定时工作流范畴, 留 v2
- **K5 Pinned tab 漂移弹 informed-approval 卡而非静默 abort**：Phase 2 的"origin 漂移 → abort"在恢复场景太严苛（用户随便 navigate 一下 task 就废了 token）。用 informed-approval 卡让用户决定 = Phase 2.6 范式自然延伸
- **K6 LRU archive 而非加 unlimitedStorage 权限**：BYOK 信任模型下，少一个权限提示就少一个用户犹豫点；archive 状态机和软删可复用
- **K7 LLM 后台总结标题**：BYOK 用户已付 token，单次额外调用成本可忽略；后台异步不阻塞首次发送；fallback 到首条 message 前 30 字保证总能有标题
- **K8 首次自动建 'New Session'**：复用 ChatGPT 第一次进入习惯；避免空 list 引发的 "下一步该点哪" 迷失
- **K9 Session 边界不是 trust boundary（接受 SEC-3 风险，依赖 Phase 3 confirm 兜底）**：用户拥有 agent，session 间 read 不限制 —— session B 的 agent 可通过 list_tabs / get_tab_content 接触 session A pinned 的 tab。Mitigation 是 Phase 3 已有的不变量：cross-origin args 自动 → high risk + informed-approval confirm 卡（用户在 session B 能看到 "Read tab 'Bank XYZ'?" 后 reject）；不再加 session-scope 过滤。Trade-off：prompt-injection 抹走高价值页面的攻击需要绕过 confirm 卡，受 K3 active-session-only 显示进一步约束

## Dependencies / Assumptions

- 假设 chrome.storage.local 写入性能足够每 step snapshot（实际 < 1KB / step，远低于配额限速）
- 假设 LLM provider 都支持低 token 标题生成请求（已验证 6 个 provider 都支持，无新接口）
- 假设 manifest 不需要新增权限（unlimitedStorage 不加 / notifications 不加）
- Phase 2 的 origin pinning 代码集中在 `src/lib/agent/loop.ts:188-308`，per-session 化是 task → session 上下文传递改造，不是协议重设
- Phase 2.5 的 `cdp-session.ts` 已有 owner-token 抽象，升级为 (sessionId, tabId) 是数据结构 + key 改造
- Phase 2.6 的 `firstRunConfirmedAt` 持久化在 skill 对象上，跨 session 复用零改动
- **Multi-session port routing**: one port per active session (`port name = \`chat-stream-${sessionId}\``)；background `onConnect` handler 的 closure 自然 scope 到 sessionId，per-session abortController + pendingConfirmations Map + keep-alive interval 通过 port lifecycle 自然管理。不走 multiplex / message envelope routing
- **Storage at-rest**：v1 不加密 message 体 / agent snapshot —— 与 Phase 1 "API key AES-GCM 但 key 同位存储" 选择一致，本地 attacker 已可访问 storage，加密形同 obfuscation。受 R28 redaction 不变量保护敏感字段；BYOK 信任模型已 Documented in K9 范式

## Outstanding Questions

### Resolve Before Planning

- 无（document-review 后的 4 个 P0 + 部分 P1 strategic 全部 resolve；剩余 deferred 项均为 plan-阶段技术细节）

### Deferred to Planning

**from origin brainstorm**:
- [Affects R3 / R4][Technical] Checkpoint 频率：每 step 完成后立即写 vs 节流（每 N 秒）vs 每 confirm 后写。选择影响 storage 写入压力 vs crash 时丢多少状态；R3 snapshot 是否走 delta 模式而非 full agentMessages（feasibility F14）
- [Affects R6][Technical] CDP owner-token 升级到 (sessionId, tabId) 的具体 schema + 5-path detach 路径在多 session 下的归并逻辑（feasibility F2）
- [Affects R7][Technical] Tool read/write 分类元数据落地：扩展 BUILT_IN_TOOLS 加 `class` 字段，risk.ts / R7 lock-checker / Phase 2.6 P1-G 共享同一登记表（v1 工具列表已在 R7 commit）
- [Affects R15 / R17][Technical] LRU 触发的具体定时点（每 N 个 session 操作后 / 每打开 sidepanel 时 / chrome.alarms 周期）；30 天硬删的清理同上 —— Out of Scope 排除了 alarm-driven scheduled resume，但 cleanup 用 chrome.alarms 不冲突 (feasibility F11)
- [Affects R24-R26][Technical] 跨 phase invariants 的 multi-session 适配 trace 表（plan 阶段必须做的全量审计：每条 invariant × multi-session 下是否仍成立 / 需要怎么改）
- [Affects R10][Technical] Resume 检测时机（SW startup / sidepanel mount / 二者都触发）+ 重复 resume 防御
- [Affects all][Technical] Session schema 在 chrome.storage.local 的具体 key 命名 + indexing 策略（每 session 一个 key vs 拆 messages / metadata 两个 key 以避免大 session 写入抖动）

**added from document-review**:
- [Affects R20 / R10][UX] Session 状态机完整枚举：8+ 状态（active / paused / running / pending-confirm / done / failed / archived / soft-deleted）画转移图，列每态的 row affordances + 触发条件（design-lens）
- [Affects R10 / R11][Technical] Confirm protocol non-tool form：R11 informed-approval 卡 + R10 paused-resume 卡都不绑 tool_use_id；AgentConfirmRequestMessage schema 需新 variant 或 pseudo-tool。R11 收窄到单 button 后复杂度大降，但仍需 schema (feasibility F3)
- [Affects R5 / R10][Technical] Per-session pinned tab anchor 时机：session 创建时 capture 用户当时 active tab + 持久化，不在每次 runAgentLoop 内 re-query（feasibility F13）
- [Affects R8][Security] Cross-session `firstRunConfirmedAt` 复用是否需在 high-risk 场景下加 per-session 二次 confirm（low-stakes session 自动放行 high-stakes 场景的风险接受 vs mitigate 决策；SEC-9）
- [Affects R7][UX] Write-conflict toast 文本是否暴露 session 名 / tab id（信息渠道泄露 vs 用户实用性的权衡，SEC-7）
- [Affects R18][UX] 软删 vs Delete 的用户心智冲突（凭证场景"30 天可恢复"是否反 expectation）；是否独立"Delete forever" action（SEC-8）
- [Affects R29][Implementation] LLM 标题 prompt 设计 + 失败回退细节 + 标题异步返回前的"loading title" UX

## Next Steps

→ `/ce:plan` for structured implementation planning
