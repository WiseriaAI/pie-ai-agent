# Record & Replay v1 — 网页操作录制 + AI 创建 Skill

**版本**：0.5.3 (录制 v1)
**日期**：2026-05-05

## 用户视角

- Top bar 新加 **Record** 按钮（在 Settings 旁）
- 点 Record → sidepanel 进入 RecordingMode：实时显示你在当前 tab 的每步操作
  （click / type / scroll / select / submit / 翻页）
- 完成后点 **Finish** → 自动回到 chat，输入框上方出现 chip
  "📼 已录制 N 步 ✕"
- 在输入框写自由提示（如"参数化 username/password" / "跳过最后那个验证码步骤" /
  留空让 LLM 自由发挥）→ Send
- LLM 收到完整 trace + 你的提示 → 调用 built-in skill `create_skill_from_recording`
  → 该 skill 引导 LLM 调用 `create_skill` meta tool 创建新 skill
- **R10 first-run confirm 卡片**弹出 → 你 review 完整 skill 内容（promptTemplate /
  allowedTools / parameters）→ Approve 后 skill 落盘
- 该 skill 出现在 SkillsList，下次用 `/skillname` 在 chat 调用
- 回放时 LLM 看 promptTemplate 跟着步骤走，每步重新 snapshot 找元素，调用
  现有 click/type 工具——所有 risk 与 cross-origin invariant 不变

## 安全 / 隐私

- 密码 / cc-* / API token / 验证码 字段**绝不**写入 promptTemplate；统一替换
  成 `{{password}}` 等占位（capture 阶段就 redact）
- 录制 SW state 完全在内存中，绝不持久化；SW 重启 / panel 关闭 / 切到别的
  session 都会自动 abort
- **R10 first-run confirm 卡片是 capability review surface** —— 你 approve 之前能
  看到 LLM 推断的完整 skill 内容（步骤、工具、参数）。R10 是 Phase 2.6 既有
  invariant，录制 v1 直接复用，不引入新审查路径

## 同时更新

为让 SkillsList 入口更全，本版本顺手补了 2 个 built-in skill：
- **Take Screenshot**（Phase 5 capture_visible_tab + 描述图片）
- **Open URL in Tab**（v1.5 open_url 演示用）

并在 SkillsList 顶部加了概念说明：底层工具（click / type / open_url 等）由
LLM 自动选用，不在此列表；列表里只显示**可复用工作流**（skill）。

## 已知限制（v1.1+）

- v1 只录单 tab：用户在录制中开新 tab / `open_url` 创建的 tab 不被记录。
  跨 tab 录制 deferred 到 v1.1
- v1 不录数据循环（"对每行记录都做这一组操作"）—— 固定步骤序列，没有 N
  行循环
- 录制 SPA route change 依赖 `history.pushState`/`replaceState`；某些自定义
  router 跳过这俩 API 时不被记录（fallback：用户手动 demo 一个 click 触发跳转）
- 录制 trace ≤ 8KB（promptTemplate 上限）。超长录制 SW 会拒绝并提示
  "Discard and re-record a shorter flow"

## Trace

- Plan: `docs/superpowers/plans/2026-05-05-record-and-replay.md`
- Spec: `docs/superpowers/specs/2026-05-04-record-and-replay-design.md`
- Invariant trace: `docs/solutions/2026-05-05-record-and-replay-v1-invariant-trace.md`
