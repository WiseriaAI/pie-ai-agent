# 工具调用失败诊断提示（issue #127）

**日期**: 2026-06-24
**Issue**: WiseriaAI/pie-ai-agent#127 — P2 · feature
**结论先行**: issue 提交于 2026-06-04，此后大量 editor / 诊断工作已落地，issue 描述的诉求**绝大部分已实现**。本 spec 先给审计结论，再只补真正残留的缺口。

## 现状审计（issue 诉求 vs 已有实现）

| issue / triage 诉求 | 现状 | 位置 |
|---|---|---|
| IME 检测到键盘捕获 → 建议 dispatch_keyboard_input | ✅ 已实现 | `act-core.ts` type 路径 `looksLikeIMEBuffer`（行 364-368） |
| 编辑器只吃真键盘事件 → 路由到 dispatch_keyboard_input | ✅ 已实现（9 类编辑器） | `act-core.ts` `detectEditor` + `!retained` 分支（行 371-382） |
| 元素找不到 → 提示重新快照 | ✅ 已实现 | `act-core.ts` 行 52-56 |
| select 选项不存在 → 列出可用值 | ✅ 已实现 | `act-core.ts` 行 420-427 |
| Agent 侧「别盲目重试 / 反复失败就上报」 | ✅ 已实现 | `prompt.ts:94`「Diagnose before retrying」 |
| Monaco/CodeMirror 用 read_editor，canvas 用 vision+keyboard | ✅ 已实现 | `prompt.ts` `EDITOR_TOOLS_GUIDANCE`（行 157-161） |
| CDP 不可用时追加启用提示 | ✅ 已实现 | `loop.ts` 行 1233-1239 |

**因此本 spec 不重做以上任何一项**（triage-bot 建议的「step 1: 补 system prompt 降级规范」已是既成事实，不再动）。

## 真正残留的缺口

### Gap A（主要，匹配 issue 复现场景）

issue 复现：「Agent 尝试操作 Monaco 编辑器，反复点击/type 失败」。当 agent 对一个**编辑器渲染面**（Monaco 的 `.view-line` div、或裸 `<canvas>`）调用 `type` 时，命中 `act-core.ts` 行 192-196 的早返回：

```
Element [N] is a <div> which is not typeable (expected input, textarea, or contenteditable).
```

这条消息**不带编辑器/canvas 诊断**——编辑器识别（`editorType`）发生在行 209，在这个早返回**之后**，所以这条路径漏掉了「这是 Monaco，请用 read_editor / dispatch_keyboard_input」的引导。Agent 只能盲目换 index 重试。

`detectEditor` 函数定义在行 139（在 type op 块内、早返回之前），**当前作用域可直接调用**，无需 hoist。

### Gap B（次要，issue 标题的「Canvas」一词）

`act-core.ts` 合成点击路径（行 457-492，子 frame 用）对**裸 `<canvas>`** 元素点击后返回 `Clicked element [N]`，无任何信号表明 canvas 内容不是标准 DOM。Agent 易误以为点击「成功」却毫无效果。补一条 advisory 注记。

## 设计

遵循仓库既有「错误字符串内嵌引导」约定（参照 `read-page.ts` 的 `pdf_tab:` 前缀范式）——**不新增 `hint` 字段、不改类型、不动 loop.ts**。全部改动在 `act-core.ts` 一个文件、两处。

### Gap A — type 早返回分支（行 192-196）

把单一 message 拆为三态：

1. `tag === "canvas"` → canvas 专项引导：
   > `Element [N] is a <canvas> — canvas surfaces have no DOM text. Read them via screenshot + vision, and write via dispatch_keyboard_input after clicking to focus.`
2. 否则 `detectEditor(el)` 命中 → 编辑器专项引导：
   > `Element [N] is inside a <Editor> editor surface, which is not directly typeable. Use read_editor / set_editor_value (Monaco / CodeMirror) or dispatch_keyboard_input — not type.`
3. 否则 → 保留原有 generic message（不退化）。

### Gap B — 合成点击成功路径（行 491-492）

点击后若 `el.tagName === "CANVAS"`，在 observation 追加 advisory（不改 `ok: true`，仅附注）：
> `Clicked element [N]. (Note: this is a <canvas> — its content isn't standard DOM; if nothing happened, read it via screenshot + vision and interact via the keyboard tools.)`

裸 canvas 用 `tagName` 内联判断即可，**不为 Gap B 引入 detectEditor**（保持改动局部，无需 hoist）。

## 明确排除（YAGNI / 风险）

- **CDP 顶层 frame 点击的 canvas 检测**：主点击走 CDP real-mouse 路径，加检测需改坐标解析路径、面更大、风险高；`prompt.ts` 的 editor 指南已缓解。排除。
- **未注册进 interactive index 的编辑器**（issue 第 2 条 hint「未在 index 中注册」）：属 probe/索引能力问题，非错误提示问题，改动风险高。排除。
- **「失败 2 次」硬阈值数字**：`prompt.ts:94` 已有定性的「别盲目重复 / 反复失败就上报」。加一个魔法数字 `2` 反而更僵，不加。

## 测试

`act-core.test.ts` 补：
- type 一个 `.monaco-editor` 内的 `<div>` → 错误含编辑器引导（read_editor / dispatch_keyboard_input）。
- type 一个裸 `<canvas>` → 错误含 canvas + screenshot/vision 引导。
- type 一个普通 `<div>`（非编辑器）→ 仍是原 generic message（不退化）。
- 合成 click 一个 `<canvas>` → observation 含 canvas advisory；click 普通元素 → observation 不变。

## 验收标准

- 上述 4 类测试通过；`pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。
- 对一个真实 Monaco / canvas 页面 type，错误信息能让 LLM 直接路由到正确工具（人工验收）。
