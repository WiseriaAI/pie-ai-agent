# Record & Replay v1 — Invariant Trace

落地的所有 invariant + 验证点，给后续维护参考。

> **Reframe (2026-05-05)**：原 v1 设计是 "录制完成 → SaveSkillDialog 让用户填
> name/desc/edit → SW saveSkill 直接落 user-authored skill"。基于用户反馈，重构为
> "录制完成 → chat 输入框 chip → user 加自由 prompt → LLM 调用新增 built-in skill
> `create_skill_from_recording` → 该 skill 调 create_skill meta tool → 走 R10
> first-run confirm 卡片"。**REC-A / REC-B2 / REC-C / REC-E 重写**；其它 invariant
> 不变。

## Invariant 列表

| Code | 描述 | 验证点 |
|---|---|---|
| REC-A | ~~录制 skill author='user'~~ → **Reframe**：录制 skill 由 LLM 调用 `create_skill` meta tool 创建 → 自动 author='agent'（Phase 2.6 P0-C）→ R10 first-run-confirm 自动 fire | recording-orchestrator.test.ts case "handleRecordingFinish broadcasts serializedTrace + clears session"（验证 SW 不再 saveSkill）+ Phase 2.6 既有 R10 测试覆盖卡片显示 |
| REC-B | promptTemplate ≤ 8KB（复用 Phase 2.6 P0-D） | serialize.test.ts "throws PromptTooLargeError" + recording-orchestrator.test.ts case "rejects when serialized trace exceeds 8KB" |
| ~~REC-B2~~ | ~~parameters schema strings ≤ 2KB~~ → **Reframe 后由 skill-meta.ts validateSkillContent 强制**（LLM 调 create_skill 时 P0-B 自然检查），SW orchestrator 不再 duplicate 检查 | skill-meta.test.ts P0-B coverage（Phase 2.6 既有） |
| ~~REC-C~~ | ~~allowedTools ⊂ ALL_KNOWN_NON_SKILL_TOOL_NAMES~~ → **Reframe 后同 REC-B2**：由 create_skill meta tool 写入路径强制；built-in skill `create_skill_from_recording` 自身的 allowedTools 由 `ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES`（superset 含 meta tools）import-time 校验 | builtin.ts import-time assertion + skill-meta.ts validateSkillContent |
| REC-D | 录制 SW state in-memory only — 绝不 chrome.storage.set | storage-invariant.test.ts grep 检测 |
| REC-E | ~~Save dialog = capability review surface~~ → **Reframe**：R10 first-run confirm 卡片是 capability review surface（Phase 2.6 既有 metaSkillPreview 已显示完整 SkillDefinition）。删 SaveSkillDialog | Phase 2.6 既有 R10 confirm card metaSkillPreview 渲染 + AgentConfirmCard 测试 |
| REC-F | Multi-session sandbox：sender.tab.id 决定归属 session，panel 仿造 sessionId 不生效 | recording-orchestrator.test.ts case "rejects action from non-recorded tabId" |
| REC-G | Sensitive 字段绝不带 selectorHint（即使有 id/name） | selector.test.ts case "NEVER attaches selectorHint for sensitive fields" |
| REC-H | 录制中点链接（hard nav）→ webNavigation.onCommitted 重 inject + record navigate action | recording-orchestrator.test.ts case "handleRecordingNavCommitted records navigate + re-injects" |
| REC-I | session 切换 / panel disconnect / SW restart / tab close → 自动 abort + 无残留 state | useRecording.test.ts case "session change while recording fires discard automatically" + recording-orchestrator.test.ts cases for tabClosed / abortRecording。**测试覆盖 panel-side 主动 discard，production 主路径其实是 SW onDisconnect 触发 abortRecordingForSession(panel-disconnect)**——重构 useSession.port 生命周期时注意这块由两条腿撑着 |
| ~~REC-J~~ | ~~重录覆盖时走 saveSkill (delete-then-create)~~ → **Reframe 后无意义**：每次录制都是 LLM 重新生成 skill 走 R10；用户可以在 prompt 里说"覆盖之前的 X skill"让 LLM 调 update_skill / delete + create | 无 |
| REC-K | promptTemplate 中文（决议 3）；i18n 切换只动 STEP_TEMPLATES | serialize.ts 顶部 `STEP_TEMPLATES` 常量 |
| REC-L | Agent task streaming 时 reject 录制（双层 gate：panel RecordButton disabled + SW handleRecordingStart 校验 inFlightSessionIds） | recording-orchestrator.test.ts case "rejects start when active session is streaming agent task (SW-side gate)" |
| REC-M | capture.ts ↔ selector.ts label 双实现 parity | capture.integration.test.ts PARITY case，比对 describeElement 输出 |
| REC-N | capture.ts ↔ redact.ts redact parity | capture.integration.test.ts PARITY case `redacted` / `placeholderName` 断言 |
| REC-O | installCaptureListener idempotent（防 SW 重启 / 二次 inject 双倍 capture） | capture.integration.test.ts case "idempotent install: a second installCaptureListener() does not double-attach listeners" |
| **REC-P** | **Reframe 新增**：built-in skill `create_skill_from_recording` 拥有 `create_skill` 作为 allowedTools 之一；这是唯一允许 meta-tool-in-skill-scope 的合法用例（其它 user/agent skill 仍被 ALL_KNOWN_NON_SKILL_TOOL_NAMES 阻断） | tool-names.ts `ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES` 注释 + builtin.ts import-time assertion + skill-meta.ts P1-G 仍用 NON_SKILL set |
| **REC-Q** | **Reframe 新增**：recording trace 通过 chat user message 的 `expandedForLLM` 字段送达 LLM，**不**走持久化 — pendingRecording state 是 React 内存态，× 即丢；Send 后 onPendingRecordingConsumed 立即清空 | App.tsx pendingRecording state；Chat.tsx sendMessage 调 onPendingRecordingConsumed |
| **REC-R** | **Reframe 新增**：trace 内的 page DOM 文本已经过 serialize.ts 的 `escapeUntrustedWrappers` 处理（escape 了 `untrusted_*` family），加 `<recordingTrace>` 自定义包裹只是给 LLM 标记边界，并非安全边界 | serialize.ts `escapeUntrustedWrappers` 调用 + Chat.tsx sendMessage 包裹格式 |

## 复用现有 invariant 列表

录制 v1 不引入新的 risk / capability / dispatch 路径——以下既有 invariant 自动覆盖回放：

- Phase 2 dom-actions 整套（click/type/scroll/select 工具签名 + 风险等级）
- Phase 2.5 CDP keyboard（canvas editor 录制中如果走 type 工具，依然走 CDP path）
- **Phase 2.6 R10 first-run-confirm（Reframe 后录制 skill 也 fire — 因为 LLM 通过 create_skill 创建 → author='agent' → R10 自动 fire）**
- Phase 2.6 capability-grant 8 项（P0-A...P1-H 全适用）
- Phase 3 cross-tab + Phase 5 screenshot risk classifier（回放期 LLM 调 cross-tab 工具自然走 confirm card）
- M1 paused/resume（录制 session 不进 paused/resume，因为不持久化）
- M3 multi-session sandbox（每 RecordingSession 绑 sessionId + tabId，跨 session 不串味）
- v1.5 multi-pin（开新 tab/cross-origin nav 录制依赖 webNavigation；回放期开 url 走 open_url 工具）

## v1 显式不做（v1.1+）

- Cross-tab 录制（用户在录制中开新 tab 也录入）
- 数据循环（N 行 csv → 跑 N 次同一步骤）
- promptTemplate i18n（仅切换 STEP_TEMPLATES 即可）
- selector.ts 与 capture.ts 之间的 ambiguous-region disambiguation parity（capture 没有 snapshot 上下文计算 regionSiblingCount）

## Reframe diff summary

- **+** 3 个 built-in skill：`create_skill_from_recording` / `take_screenshot` / `open_url_in_tab`
- **+** `ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES` superset (tool-names.ts) — built-in skill 可引用 meta tool；user/agent skill 仍受 `ALL_KNOWN_NON_SKILL_TOOL_NAMES` 限制
- **+** SkillsList 顶部概念说明
- **−** SaveSkillDialog.tsx + SaveSkillDialog.test.tsx (~270 lines)
- **简化** RecordingFinishMessage / RecordingFinishedBroadcast wire schema
- **简化** orchestrator handleRecordingFinish（~100 lines → ~50 lines；不再 saveSkill）
- **简化** useRecording.finishRecording API（不再接 args）
- **+** Chat.tsx pendingRecording chip + sendMessage 时构造 expandedForLLM 显式调用 create_skill_from_recording
