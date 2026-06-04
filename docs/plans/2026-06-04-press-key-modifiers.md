# 实现方案：#123 `press_key` 支持组合键（Ctrl/Cmd + 键）

> 状态：实现方案（待评审后开工）。分支 `claude/issue-review-plan-7X1WD`。
> 关联：`docs/plans/2026-06-04-canvas-editor-issues-review.md` 的 **S1**（最低风险、可独立落地，不依赖 MAIN world）。
> 目标：让 `press_key` 能发 `Ctrl+A`/`Cmd+A`（全选）、`Ctrl+Z`（撤销）等组合键，解锁"全选 → 覆盖输入"这条替换编辑器内容的基本路径。

## 0. 范围与非目标

- **范围**：`press_key` 新增 `modifiers` 参数；`KEY_MAP` 补入组合键场景需要的字母键；跨平台主修饰键自适应。
- **非目标**：
  - **不做 `Ctrl+V` 注入任意文本**。CDP `Input.dispatchKeyEvent` 只发按键事件，不会把目标文本塞进系统剪贴板；`Ctrl+V` 只在剪贴板恰好已有目标内容时有效。大段文本写入由 #124 `set_editor_value` / `dispatch_keyboard_input` 负责。工具描述需讲清这点，避免 LLM 反复试无效的 `Ctrl+V`。
  - 不触碰 MAIN world、不改 interactive index（那是 #124/#125/#126）。

## 1. 改动点总览（单文件为主）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/lib/agent/tools/keyboard.ts` | 主改动 | `KEY_MAP` 补字母键；`MODIFIER_BITS` 映射；`press_key` schema + handler 接 `modifiers`；`mod` 平台自适应 |
| `src/lib/agent/tools/keyboard.test.ts` | 加测试 | 组合键 bitmask、`mod` 平台解析、非法 modifier、单键回归 |
| `tool-names.ts` / `redactArgsForPanel` | **不改** | `press_key` 已分类为 `write`；组合键不带 `text`，无需脱敏 |

## 2. 详细设计

### 2.1 `KEY_MAP` 补字母键（保持"刻意"原则）

现 `KEY_MAP` 只有控制键（`keyboard.ts:55-69`）。组合键需要的字母键，**只补编辑器快捷键相关的**，不全量加 A–Z：

```ts
// 追加到 KEY_MAP（vk: A=65, C=67, V=86, X=88, Y=89, Z=90）
A: { code: "KeyA", windowsVirtualKeyCode: 65 },
C: { code: "KeyC", windowsVirtualKeyCode: 67 },
V: { code: "KeyV", windowsVirtualKeyCode: 86 },
X: { code: "KeyX", windowsVirtualKeyCode: 88 },
Y: { code: "KeyY", windowsVirtualKeyCode: 89 },
Z: { code: "KeyZ", windowsVirtualKeyCode: 90 },
```

覆盖：全选(A) / 复制(C) / 粘贴(V) / 剪切(X) / 撤销(Z) / 重做(Y 或 Shift+Z)。后续要加键再按需补，沿用 `KEY_MAP` 注释的"deliberate decision"原则。

### 2.2 修饰符位映射

把现有零散的 `MODIFIER_SHIFT=8`（`keyboard.ts:75`）升级为完整表（CDP `Input.dispatchKeyEvent.modifiers` 位定义）：

```ts
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
```

`dispatch_keyboard_input` 里 soft-break 用的 `MODIFIER_SHIFT` 改为引用 `MODIFIER_BITS.shift`，消除重复常量。

### 2.3 跨平台主修饰键 `mod`（关键设计点）

issue 标题写 "Ctrl/Cmd"——macOS 全选是 **Cmd+A**(meta)，Win/Linux 是 **Ctrl+A**(ctrl)。**LLM 不知道用户 OS**，让它自己选 ctrl/meta 不可靠。

**方案**：`modifiers` 接受 `"ctrl" | "shift" | "alt" | "meta" | "mod"`。其中 **`mod` = 平台主加速键**，handler 按 OS 展开：

```ts
// 在 keyboard.ts 内（SW 上下文）
let cachedIsMac: boolean | null = null;
async function resolveMod(): Promise<number> {
  if (cachedIsMac === null) {
    try {
      const info = await chrome.runtime.getPlatformInfo();
      cachedIsMac = info.os === "mac";
    } catch {
      cachedIsMac = false; // 取不到时按 ctrl 兜底（覆盖 Win/Linux 多数用户）
    }
  }
  return cachedIsMac ? MODIFIER_BITS.meta : MODIFIER_BITS.ctrl;
}
```

- `getPlatformInfo()` 在 `keep-alive.ts` 已验证可用；结果进程内缓存（OS 不会变）。
- 工具描述引导 LLM：**编辑器快捷键（全选/复制/撤销）一律用 `mod`**；只有明确要发物理 ctrl 或 meta 时才用 raw 值。

### 2.4 `press_key` schema

```jsonc
{
  "key": { "type": "string", "enum": [...Object.keys(KEY_MAP)] },   // 已含新字母键
  "modifiers": {
    "type": "array",
    "items": { "type": "string", "enum": ["mod", "ctrl", "shift", "alt", "meta"] },
    "description": "Optional modifier keys held during the press. Use 'mod' for the platform primary accelerator (Cmd on macOS, Ctrl elsewhere) — prefer it for select-all/copy/undo. CDP cannot inject clipboard contents, so Ctrl/Cmd+V only pastes if the clipboard already holds the target text; use set_editor_value or dispatch_keyboard_input for bulk text."
  }
}
// required: ["key"]；additionalProperties: false
```

### 2.5 handler 改动

在现有 `press_key` handler（`keyboard.ts:404-456`）里，`sendKeyPress(session, a.key)` 之前算出 bitmask：

```ts
const a = args as { key: string; modifiers?: string[] };
// ...KEY_MAP 校验不变...

// 计算 modifiers bitmask（含 mod 平台展开 + 校验）
let modBits = 0;
for (const m of a.modifiers ?? []) {
  if (m === "mod") { modBits |= await resolveMod(); continue; }
  const bit = MODIFIER_BITS[m as keyof typeof MODIFIER_BITS];
  if (bit === undefined) {
    return { success: false, error: `Unsupported modifier '${m}'. Allowed: mod, ctrl, shift, alt, meta` };
  }
  modBits |= bit;
}

// 护栏：字母键裸按（无修饰）应走 dispatch_keyboard_input
const isLetter = /^[A-Z]$/.test(a.key);
if (isLetter && modBits === 0) {
  return { success: false, error: `press_key('${a.key}') with no modifiers does nothing useful; use dispatch_keyboard_input to type text, or add a modifier (e.g. modifiers:["mod"] for select-all).` };
}

await sendKeyPress(session, a.key, modBits);
```

observation 文案带上修饰键，便于 panel 可读：
```ts
const combo = (a.modifiers?.length ? a.modifiers.join("+") + "+" : "") + a.key;
return { success: true, observation: `Pressed ${combo} via keyboard simulation` };
```

**CDP 正确性**：`sendKeyPress` 已把 `modifiers` 写进 keyDown/keyUp 的 `modifiers` 字段（`keyboard.ts:94`）。Monaco/CodeMirror 等读 `event.ctrlKey/metaKey/shiftKey` 来识别 chord，因此**只需在字母键事件上带 modifiers 位即可，无需为修饰键本身额外发 keyDown/keyUp**。`sendKeyPress` 也不设 `text` 字段——这正确：`Ctrl+A` 不应插入字符 "a"。

### 2.6 不需要改的地方（已核实）

- **分类**：`press_key` 已在 `KNOWN_KEYBOARD_TOOL_NAMES`（`tool-names.ts:111`）+ `TOOL_CLASSES.press_key="write"`（:178），无新工具名 → build-time exhaustive check 不受影响。
- **脱敏**：`redactArgsForPanel`（`loop.ts:867-877`）只在有 `text` 字段时脱敏；组合键参数是 `key`/`modifiers`，非敏感，原样展示更利于调试。
- **origin 重检 / CDP gate / settle wrap**：handler 现有逻辑全保留，组合键复用同一路径。

## 3. 安全 / 边界

- **校验**：未知 modifier 值显式报错（见 2.5）；`key` 仍受 `KEY_MAP` enum 约束。
- **bidi/控制字符过滤**：那是 `dispatch_keyboard_input` 的文本通道关注点；`press_key` 不走文本，无新增风险面。
- **`Ctrl/Cmd+V` 误区**：已在 schema description + 本文 §0 写明，CDP 不注入剪贴板。
- **跨平台兜底**：`getPlatformInfo` 失败时 `mod`→ctrl（覆盖多数用户），不致 throw。

## 4. 测试计划（`keyboard.test.ts`）

新增 `describe("press_key — modifiers")`：

1. `modifiers:["ctrl"], key:"A"` → 断言 `Input.dispatchKeyEvent` keyDown/keyUp 的 `params.modifiers === 2` 且 `code === "KeyA"`、无 `text` 字段。
2. `mod` 平台解析：stub `chrome.runtime.getPlatformInfo` 返回 `{os:"mac"}` → `modifiers:["mod"]` 得 bit 4(meta)；`{os:"win"}` → bit 2(ctrl)。（若 `chromeMock.runtime` 无 `getPlatformInfo`，在 `src/test/setup` 补一个可被 `vi.spyOn` 的 stub。）
3. 多修饰符 `["mod","shift"], key:"Z"`（重做）→ bitmask 合并正确。
4. 非法 modifier `["hyper"]` → `success:false`，报错含 "Unsupported modifier"。
5. 护栏：`key:"A"` 无 modifiers → `success:false`，提示用 dispatch_keyboard_input。
6. 回归：原单键 `key:"Enter"`（无 modifiers）行为不变，`params.modifiers` 为 undefined。

## 5. 验收清单

- [ ] `pnpm test`（含新增 keyboard 用例）通过
- [ ] `pnpm typecheck` 0 error（schema 与 handler 的 modifiers 类型对齐）
- [ ] `pnpm build` 通过（build-time invariants 不受影响）
- [ ] 手验：在含 Monaco/CodeMirror 的页面，`press_key(key:"A", modifiers:["mod"])` 触发全选，随后 `dispatch_keyboard_input` 覆盖成功

## 6. 工作量与风险

- **工作量**：小。单文件主改 + 测试，无新工具注册、无 MAIN world、无新依赖。
- **风险**：低。底层 `sendKeyPress` 早已支持 modifiers，本质是把已存在能力暴露到 schema + 补字母键 + 跨平台 `mod`。
- **可独立合入**：是。不阻塞、不被 S2–S6 阻塞，落地即给用户价值（替换编辑器已有内容的基本路径）。
