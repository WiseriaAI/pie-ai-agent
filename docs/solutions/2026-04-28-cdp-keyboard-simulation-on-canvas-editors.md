---
date: 2026-04-28
topic: cdp-keyboard-simulation-on-canvas-editors
related_plan: docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md
---

# Spike — chrome.debugger + Input.insertText 在 canvas 编辑器中的实测

## 目的

Phase 2.5 plan 的 Hard gate verification 物证。验证三件事：

1. `chrome.debugger.attach` + `Input.insertText` 是否真能在飞书 Docs 等 canvas 编辑器中产生可见文字（CDP 路径可行性）
2. `Input.dispatchKeyEvent` 控制键（Enter）是否同样能被识别（press_key 路径可行性）
3. `navigator.clipboard + document.execCommand('paste')` 替代路径是否可在飞书 Docs 上工作（AF6 alternative 决断）

未通过 (1) 则 Phase 2.5 plan 失效；(3) 通过则可拆分 Phase 2.5a/2.5b 降低 risk surface。

## Spike 实施

Throwaway harness 见提交 `eac651f`（已 revert）：

- `src/background/spike.ts`：SW 端调用 chrome.debugger.attach + sendCommand
- `src/sidepanel/components/SpikeHarness.tsx`：UI 提供文本输入和 3 个按钮（CDP insertText / CDP press Enter / Clipboard paste）
- 全部走 `chrome.runtime.sendMessage` 单次请求-响应通道，不污染 Phase 2 port 协议

测试时间：2026-04-28 凌晨

## Verdict

| 站点 | CDP `Input.insertText` | CDP `Input.dispatchKeyEvent` (Enter) | Clipboard + `execCommand('paste')` |
|---|---|---|---|
| **飞书 Docs（新版 Docx 引擎）** | ✅ pass | ✅ pass（光标处插入新行） | ❌ fail |
| Google Docs | （未测，stretch） | （未测） | （未测） |
| Notion | （未测，stretch） | （未测） | （未测） |

飞书 Docs 单站验证 pass，已满足 plan Hard gate 解锁判据（"至少在飞书 Docs 上验证 Input.insertText 文字可见"）。Stretch 站点 Google Docs / Notion 在实施期可补测，不阻塞 Unit 1+。

### 飞书 CDP insertText 详细观察

- attach 成功，attach 耗时 < 100ms（手感即时）
- 黄色调试条显示在 tab 顶部（Chrome 内置 UI，不可隐藏）
- `Input.insertText` sent 后，文档可见字符正确出现，**无需** `Runtime.evaluate("document.activeElement?.focus()")` 显式调 focus
- 前置 click（用户在编辑区点击一下）即可让 IME buffer 取到 focus，CDP 下 attach 后 send 即生效
- 黄条在 detach 后 ~0.5s 内消失（手感无感）

### 飞书 CDP press Enter 详细观察

- `keyDown` + `keyUp` Enter 在文档光标处产生新行
- 行为与真实键盘一致

### Clipboard paste 失败原因（实测 log）

```
clipboard-paste · fail
activeElement before paste: div
activeElement after paste: div
clipboard set via: execCommand-copy
document.execCommand('paste') returned: false
```

诊断：

- 剪贴板成功写入（`execCommand-copy` hack 工作）
- `document.execCommand('paste')` 返回 `false`，且文档无可见变化
- 飞书 Docs 不接受 `execCommand('paste')` 触发的 paste 事件（即使 isTrusted=true，飞书的编辑器似乎绑定到 `keydown` / IME composition 而非 `paste` 事件）

## 决断

1. **Phase 2.5 CDP 路径解锁实施**：Unit 1+2+3+4+5 按 plan 推进
2. **AF6 拆分方案否决**：clipboard+paste 不能替代 chrome.debugger，无法用 paste-only Phase 2.5a 避开 debugger 权限。完整 plan 范围保持
3. **Unit 3 Approach 中"焦点保证"简化**：现有 `after_element_index` 先走 `clickByIndex` 即可让 IME buffer focus，无需引入 `Runtime.evaluate`。Plan 的 Runtime.evaluate 强约束保留作未来扩展兜底，但 Unit 3 实现不引用
4. **未在本 spike 验证的项**（实施期补）：
   - Stretch 站点 Google Docs / Notion 的相同三项测试（建议在 Unit 3 PR 描述中跑一次并记录）
   - sessionMap.delete vs onDetach delivery 时序（plan F4 残余风险，需在 Unit 2 实测中观察）
   - 长文本（接近 5000 字符上限）和 Unicode 边界（emoji ZWJ、bidi controls）

## 影响 plan 的更新

- Open Questions Deferred：第 1 项（Input.insertText vs Runtime.evaluate）→ 已 resolved（不需要 Runtime.evaluate）
- Open Questions Deferred：clipboard+paste 替代路径 → 已 resolved（不可行）
- Hard gate：飞书 pass，解锁 Unit 3 实施
