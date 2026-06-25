# 跨标签页录制回放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让录制采集跟随"点击 spawn 出来的新标签页/窗口"继续工作（A），并让蒸馏出的 Skill 运行期能接管 spawn 出来的子标签页（B），消除"点击开新标签页即死局"。

**Architecture:** 录制侧用"流程标签页集合（起始页 ∪ opener 链 spawn）"扩展 `RecordingSession`，每条 action 标 `tabRef`，serialize 按 tabRef 首次出现推断 spawn/switch 转换步骤；运行侧新增按需工具 `switch_to_new_tab` 收编+聚焦 spawn 出来的未 pin 子标签页，switch 回老页复用 `list_tabs`+`focus_tab`，**不引入任何运行期常驻监听**。

**Tech Stack:** TypeScript 6 · Chrome Extension MV3（chrome.tabs / chrome.webNavigation / chrome.scripting）· vitest + happy-dom。

## Global Constraints

- `RecordingSession` **绝不**写入 `chrome.storage`（build-time grep gate；`src/lib/recording/storage-invariant.test.ts`）。新增字段同样只活在 SW 内存。
- serialize 产出 `promptTemplate` ≤ 8192 bytes（`PROMPT_TEMPLATE_MAX_BYTES`，超出抛 `PromptTooLargeError`）。
- 一切进入 serialize 文案的 origin / url / label 必须经 `escapeUntrustedWrappers`（`src/lib/agent/untrusted-wrappers.ts`）。
- 新工具必须同时登记进 `TAB_TOOL_NAMES` + `TOOL_CLASSES` + `TOOL_GROUPS`（`src/lib/agent/tool-names.ts`），否则模块加载 throw。
- 范围外不做：onActivated 监听、运行期全局 onCreated 自动收编、新增 `RecordedActionType`、把具体 origin 硬编进蒸馏 Skill。
- 每个 Task 收尾前跑 `pnpm test <改动的测试文件>`；全部完成后跑 `pnpm test && pnpm typecheck && pnpm build`。

---

### Task 1: serialize — `tabRef` 字段 + `TabRegistry` + spawn/switch 转换步骤

**Files:**
- Modify: `src/lib/recording/types.ts`（给 `RecordedAction` 加 `tabRef?`；新增 `TabRegistry` 类型）
- Modify: `src/lib/recording/serialize.ts`（签名加可选 `tabRegistry`；插入转换行；STEP_TEMPLATES 加两条）
- Test: `src/lib/recording/serialize.test.ts`

**Interfaces:**
- Consumes: 现有 `RecordedAction`（含 `url`）、`STEP_TEMPLATES`、`escapeUntrustedWrappers`。
- Produces:
  - `RecordedAction.tabRef?: number`
  - `export type TabRegistry = Record<number, { origin: string; firstUrl: string }>`
  - `serialize(actions: RecordedAction[], tabRegistry?: TabRegistry): SerializeResult`（第二参可选，缺省 `{}` → 现有单参调用不破）
  - 多标签页时在目标步骤前插入**未编号**的转换行（`—` 前缀），不打乱现有 `第 N 步` 编号。

- [ ] **Step 1: 给 `RecordedAction` 加 `tabRef`，并加 `TabRegistry` 类型**

在 `src/lib/recording/types.ts` 的 `RecordedAction` 接口内、`timestamp` 之前插入：

```ts
  /** v1.1 cross-tab —— 该 action 发生在流程标签页集合里的哪个标签页（内部 key，
   *  按标签页出现顺序分配，0=起始页）。单标签页录制时省略。运行期不靠它（会漂），
   *  仅供 serialize 推断 spawn/switch 转换。 */
  tabRef?: number;
```

在该文件末尾追加：

```ts
/**
 * v1.1 cross-tab —— tabRef → 标签页身份。origin 作运行期匹配 hint，firstUrl 仅可读。
 * 由 recording-orchestrator 在标签页首次 commit 时填充；serialize 作"本流程用到哪些
 * 标签页"的清单参考（逐步精确 origin 取自每条 action 自带的 url，见 serialize.ts）。
 */
export type TabRegistry = Record<number, { origin: string; firstUrl: string }>;
```

- [ ] **Step 2: 写失败测试 —— spawn / switch / 切回起始页**

在 `src/lib/recording/serialize.test.ts` 末尾（最后一个 `});` 之前）追加：

```ts
  it("renders a spawn transition before the first step in a newly-opened tab", () => {
    const r = serialize([
      action({ type: "click", label: "结账按钮", url: "https://shop.com/cart", tabRef: 0 }),
      action({ type: "type", label: "卡号", value: "4242", url: "https://pay.stripe.com/x", tabRef: 1 }),
    ]);
    expect(r.promptTemplate).toContain("第 1 步：点击结账按钮");
    expect(r.promptTemplate).toContain("切换到它继续（目标站点：https://pay.stripe.com）");
    expect(r.promptTemplate).toContain("第 2 步：在卡号中输入");
  });

  it("renders a switch transition when returning to an earlier tab", () => {
    const r = serialize([
      action({ type: "click", label: "结账按钮", url: "https://shop.com/cart", tabRef: 0 }),
      action({ type: "type", label: "卡号", value: "4242", url: "https://pay.stripe.com/x", tabRef: 1 }),
      action({ type: "click", label: "查看订单", url: "https://shop.com/done", tabRef: 0 }),
    ]);
    expect(r.promptTemplate).toContain("切回 https://shop.com 的标签页");
  });

  it("emits no transition line for single-tab recordings (tabRef absent)", () => {
    const r = serialize([
      action({ type: "click", label: "A" }),
      action({ type: "click", label: "B" }),
    ]);
    expect(r.promptTemplate).not.toContain("切换到它继续");
    expect(r.promptTemplate).not.toContain("切回");
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/lib/recording/serialize.test.ts`
Expected: FAIL（新增 3 个用例报 promptTemplate 不含转换文案）

- [ ] **Step 4: 实现转换逻辑**

在 `src/lib/recording/serialize.ts`：

(a) import 处加 `TabRegistry` 类型：

```ts
import type { RecordedAction, TabRegistry } from "./types";
```

(b) `STEP_TEMPLATES` 对象内追加两条（`keypress` 之后）：

```ts
  spawnTab: (origin: string) =>
    `— 上一步的点击会打开一个新标签页，切换到它继续（目标站点：${origin}）。`,
  switchTab: (origin: string) => `— 切回 ${origin} 的标签页继续。`,
```

(c) 顶部加一个 origin 提取小工具（`serialize` 函数之前）：

```ts
function safeOriginOf(url: string): string {
  try {
    const o = new URL(url).origin;
    return !o || o === "null" ? url : o;
  } catch {
    return url;
  }
}
```

(d) 改 `serialize` 签名 + 在 forEach 内插入转换行。把签名改为：

```ts
export function serialize(
  actions: RecordedAction[],
  _tabRegistry: TabRegistry = {},
): SerializeResult {
```

在 `actions.forEach((action, idx) => {` 之前声明转换追踪状态：

```ts
  const seenRefs = new Set<number>();
  let prevRef: number | undefined;
```

在 forEach body 顶部（`const stepN = idx + 1;` 之后）插入：

```ts
    const ref = action.tabRef;
    if (ref !== undefined && idx > 0 && ref !== prevRef) {
      const origin = escapeUntrustedWrappers(safeOriginOf(action.url));
      lines.push(
        seenRefs.has(ref)
          ? STEP_TEMPLATES.switchTab(origin)
          : STEP_TEMPLATES.spawnTab(origin),
      );
    }
    if (ref !== undefined) {
      seenRefs.add(ref);
      prevRef = ref;
    }
```

> 说明：转换行是未编号的 `—` context 行，插在目标步骤**之前**；现有 `第 N 步` 编号（`idx+1`）不动，既有单标签页测试不受影响。`_tabRegistry` 本期不参与逐步渲染（逐步 origin 取自 `action.url`，更准），保留参数供蒸馏侧/未来用，下划线前缀避免 unused 告警。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/recording/serialize.test.ts`
Expected: PASS（含原有用例 + 新增 3 个）

- [ ] **Step 6: Commit**

```bash
git add src/lib/recording/types.ts src/lib/recording/serialize.ts src/lib/recording/serialize.test.ts
git commit -m "feat(recording): serialize spawn/switch tab transitions from tabRef"
```

---

### Task 2: recording-orchestrator — 流程标签页集合 + tabRef 标注 + 注册表 + abort-when-empty

**Files:**
- Modify: `src/lib/recording/types.ts`（改 `RecordingSession`：加流程集合/注册表字段）
- Modify: `src/background/recording-orchestrator.ts`（纯逻辑 helper + 改各 handler）
- Test: `src/background/recording-orchestrator.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `TabRegistry`、`RecordedAction.tabRef`。
- Produces（供 Task 3 的 index.ts 接线消费）：
  - `RecordingSession` 新形状（含 `tabRefByTabId: Map<number, number>`、`nextTabRef: number`、`tabRegistry: TabRegistry`；保留 `tabId` 表示起始页）
  - `export function registerFlowTab(sess: RecordingSession, tabId: number): number`
  - `export function recordFlowTabUrl(sess: RecordingSession, tabId: number, url: string): void`
  - `export function removeFlowTab(sess: RecordingSession, tabId: number): { removed: boolean; empty: boolean }`
  - `export function handleRecordingTabCreated(tab: chrome.tabs.Tab): RecordingSession | null`
  - `findSessionByTabId` 改为按流程集合查找（行为：tab 在任一 session 的流程集合内即命中）

- [ ] **Step 1: 改 `RecordingSession` 形状**

在 `src/lib/recording/types.ts`，把 `RecordingSession` 接口替换为（保留 `tabId` 字段语义改为"起始页"）：

```ts
export interface RecordingSession {
  /** 绑定到 active sessionId（M3 multi-session sandbox）。 */
  sessionId: string;
  /** 起始标签页。v1.1 起它只是流程集合的种子 + recording-started 广播展示用；
   *  录制逻辑改用下面的流程集合判定归属。 */
  tabId: number;
  /** 起始 origin。惰性：仅 recording-started 广播展示用，录制逻辑不读它。 */
  origin: string;
  startedAt: number;
  /** v1.1 cross-tab —— 流程标签页集合：tabId → tabRef（出现顺序，0=起始页）。 */
  tabRefByTabId: Map<number, number>;
  /** 下一个待分配的 tabRef。 */
  nextTabRef: number;
  /** tabRef → 标签页身份。标签页首次 commit 时填充。 */
  tabRegistry: TabRegistry;
  actions: RecordedAction[];
}
```

在该文件顶部 import 区不需改（`TabRegistry` 同文件定义）；若 `RecordingSession` 定义在 `TabRegistry` 之前，把 Task 1 追加的 `TabRegistry` 类型移到 `RecordingSession` 之前。

- [ ] **Step 2: 写失败测试 —— 纯 helper（注册 / 填 url / 移除空集合）**

新建 `src/background/recording-orchestrator.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  registerFlowTab,
  recordFlowTabUrl,
  removeFlowTab,
} from "./recording-orchestrator";
import type { RecordingSession } from "@/lib/recording/types";

function sess(): RecordingSession {
  return {
    sessionId: "s1",
    tabId: 10,
    origin: "https://shop.com",
    startedAt: 0,
    tabRefByTabId: new Map([[10, 0]]),
    nextTabRef: 1,
    tabRegistry: { 0: { origin: "https://shop.com", firstUrl: "https://shop.com/cart" } },
    actions: [],
  };
}

describe("recording flow-set helpers", () => {
  it("registerFlowTab assigns sequential tabRefs and is idempotent", () => {
    const s = sess();
    const ref = registerFlowTab(s, 11);
    expect(ref).toBe(1);
    expect(registerFlowTab(s, 11)).toBe(1); // idempotent
    expect(registerFlowTab(s, 12)).toBe(2);
    expect(s.nextTabRef).toBe(3);
  });

  it("recordFlowTabUrl fills registry origin once, then leaves it", () => {
    const s = sess();
    registerFlowTab(s, 11);
    recordFlowTabUrl(s, 11, "https://pay.stripe.com/checkout?x=1");
    expect(s.tabRegistry[1]).toEqual({
      origin: "https://pay.stripe.com",
      firstUrl: "https://pay.stripe.com/checkout?x=1",
    });
    recordFlowTabUrl(s, 11, "https://pay.stripe.com/success");
    expect(s.tabRegistry[1].firstUrl).toBe("https://pay.stripe.com/checkout?x=1"); // unchanged
  });

  it("removeFlowTab reports empty only when the last tab leaves", () => {
    const s = sess();
    registerFlowTab(s, 11);
    expect(removeFlowTab(s, 11)).toEqual({ removed: true, empty: false });
    expect(removeFlowTab(s, 10)).toEqual({ removed: true, empty: true });
    expect(removeFlowTab(s, 99)).toEqual({ removed: false, empty: true });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/background/recording-orchestrator.test.ts`
Expected: FAIL（`registerFlowTab` 等未导出）

- [ ] **Step 4: 实现 helper + 改造各 handler**

在 `src/background/recording-orchestrator.ts`：

(a) import 加 `TabRegistry`（已有 `RecordedAction, RecordingSession` import 行）：

```ts
import type { RecordedAction, RecordingSession, TabRegistry } from "@/lib/recording/types";
```

(b) 在 `recordingState` 声明之后追加三个纯 helper：

```ts
/** 把标签页纳入流程集合，分配/返回 tabRef（幂等）。registry 条目先占位，
 *  origin 待 recordFlowTabUrl 在 commit 时填。 */
export function registerFlowTab(sess: RecordingSession, tabId: number): number {
  const existing = sess.tabRefByTabId.get(tabId);
  if (existing !== undefined) return existing;
  const ref = sess.nextTabRef++;
  sess.tabRefByTabId.set(tabId, ref);
  if (!sess.tabRegistry[ref]) sess.tabRegistry[ref] = { origin: "", firstUrl: "" };
  return ref;
}

/** 标签页首次 commit 时填 registry 的 origin/firstUrl（只填一次，避免页内导航覆盖）。 */
export function recordFlowTabUrl(sess: RecordingSession, tabId: number, url: string): void {
  const ref = sess.tabRefByTabId.get(tabId);
  if (ref === undefined) return;
  const entry = sess.tabRegistry[ref];
  if (!entry || entry.origin) return; // already filled
  let origin = "";
  try {
    const o = new URL(url).origin;
    origin = !o || o === "null" ? "" : o;
  } catch {
    origin = "";
  }
  if (origin) sess.tabRegistry[ref] = { origin, firstUrl: url };
}

/** 从流程集合移除标签页，返回是否移除 + 集合是否已空。 */
export function removeFlowTab(
  sess: RecordingSession,
  tabId: number,
): { removed: boolean; empty: boolean } {
  const removed = sess.tabRefByTabId.delete(tabId);
  return { removed, empty: sess.tabRefByTabId.size === 0 };
}
```

(c) `findSessionByTabId` 改为按流程集合查找：

```ts
function findSessionByTabId(tabId: number | undefined): RecordingSession | null {
  if (tabId === undefined) return null;
  for (const sess of recordingState.values()) {
    if (sess.tabRefByTabId.has(tabId)) return sess;
  }
  return null;
}
```

(d) `handleRecordingStart` 里构造 session 处（现 `const session: RecordingSession = {...}`）改为初始化流程集合，并填起始页 registry：

```ts
  const session: RecordingSession = {
    sessionId: msg.sessionId,
    tabId: tab.id!,
    origin,
    startedAt: Date.now(),
    tabRefByTabId: new Map([[tab.id!, 0]]),
    nextTabRef: 1,
    tabRegistry: { 0: { origin, firstUrl: url } },
    actions: [],
  };
```

(e) `handleRecordingAction` 里 push 前给 action 标 `tabRef`：

```ts
  const action: RecordedAction = {
    ...msg.payload,
    tabRef: sess.tabRefByTabId.get(sender.tab?.id ?? -1),
    timestamp: nextActionId(),
  };
```

(f) `handleRecordingFinish` 里把 registry 传进 serialize：

```ts
    serialized = serialize(sess.actions, sess.tabRegistry);
```

(g) 新增 `handleRecordingTabCreated`（onCreated 时登记新标签页入集合，**不**注 capture）：

```ts
/** opener ∈ 某 session 流程集合的新标签页（含跨窗口）→ 纳入该 session 流程集合。
 *  capture 注入推迟到该标签页首次 onCommitted（避开 about:blank 被冲掉）。 */
export function handleRecordingTabCreated(tab: chrome.tabs.Tab): RecordingSession | null {
  const opener = tab.openerTabId;
  if (opener === undefined || tab.id === undefined) return null;
  for (const sess of recordingState.values()) {
    if (sess.tabRefByTabId.has(opener)) {
      registerFlowTab(sess, tab.id);
      return sess;
    }
  }
  return null;
}
```

(h) `handleRecordingTabClosed` 改为流程集合移除 + 仅空集合才 abort：

```ts
export function handleRecordingTabClosed(port: chrome.runtime.Port, closedTabId: number): void {
  for (const sess of Array.from(recordingState.values())) {
    if (!sess.tabRefByTabId.has(closedTabId)) continue;
    const { empty } = removeFlowTab(sess, closedTabId);
    if (empty) abortRecordingForSession(port, sess.sessionId, "tab-closed");
  }
}
```

(i) `handleRecordingNavCommitted` 里，在 `injectCapture` 之前补一行填 registry（commit 拿到真实 url）：

```ts
  recordFlowTabUrl(sess, details.tabId, details.url);
  try {
    await injectCapture(details.tabId);
  } catch {
    abortRecordingForSession(port, sess.sessionId, "csp-blocked");
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/background/recording-orchestrator.test.ts src/lib/recording/storage-invariant.test.ts`
Expected: PASS（helper 测试通过；storage-invariant 仍绿——未引入 storage 写）

- [ ] **Step 6: Commit**

```bash
git add src/lib/recording/types.ts src/background/recording-orchestrator.ts src/background/recording-orchestrator.test.ts
git commit -m "feat(recording): track flow tab-set, stamp tabRef, abort only when empty"
```

---

### Task 3: index.ts —— 接线 onCreated + 把 onCommitted/onRemoved 扩到流程集合

**Files:**
- Modify: `src/background/index.ts`（listener 接线；纯 wiring，无单测，靠 Task 2 helper 测试 + 手测覆盖）

**Interfaces:**
- Consumes: Task 2 导出的 `handleRecordingTabCreated`、改造后的 `handleRecordingTabClosed`、`recordingState`、既有 `findRecordingSessionByTabId`。
- Produces: 无新导出。

- [ ] **Step 1: import 新增 `handleRecordingTabCreated`**

在 `src/background/index.ts` 顶部已有的 recording-orchestrator import 块里追加 `handleRecordingTabCreated`（与 `recordingState` / `handleRecordingTabClosed` 等同源导入）。

- [ ] **Step 2: 接 onCreated（登记 spawn 子标签页）**

在 `chrome.tabs.onRemoved.addListener(...)`（约 `:1768`）之前插入：

```ts
// Recording v1.1 — adopt tabs spawned by a tab already in a recording flow-set
// (target=_blank / window.open / popups, cross-window included). Capture is
// NOT injected here — it lands on the new tab's first webNavigation.onCommitted
// (the existing handler), which fires after about:blank is replaced.
chrome.tabs.onCreated.addListener((tab) => {
  handleRecordingTabCreated(tab);
});
```

- [ ] **Step 3: onRemoved 已委托给 Task 2 的 handler —— 收紧条件**

把现有 `chrome.tabs.onRemoved` 监听体（`:1768-1775`）替换为（不再用 `sess.tabId !== closedTabId` 粗判，交给 flow-set 感知的 handler）：

```ts
chrome.tabs.onRemoved.addListener((closedTabId) => {
  for (const sess of Array.from(recordingState.values())) {
    if (!sess.tabRefByTabId.has(closedTabId)) continue;
    const port = portsBySession.get(sess.sessionId);
    if (port) handleRecordingTabClosed(port, closedTabId);
    else removeFlowTab(sess, closedTabId); // no panel port: drop from set silently
  }
});
```

并在 Step 1 的 import 里一并引入 `removeFlowTab`。

> onCommitted / onHistoryStateUpdated 监听（`:1746-1765`）**无需改动**：它们已用 `findRecordingSessionByTabId(details.tabId)`，Task 2 已把该函数改成流程集合感知 → 新标签页首次 commit 自动命中、走 `handleRecordingNavCommitted`（含 `recordFlowTabUrl` + `injectCapture`）。

- [ ] **Step 4: 验证编译 + 全量录制相关测试**

Run: `pnpm typecheck && pnpm test src/background/recording-orchestrator.test.ts src/lib/recording`
Expected: typecheck 0 错；测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts
git commit -m "feat(recording): wire onCreated adoption + flow-set-aware onRemoved"
```

---

### Task 4: `create_skill_from_recording` —— 蒸馏时保留跨标签页步骤

**Files:**
- Modify: `src/lib/skills/builtin.ts`（`create_skill_from_recording` 的 instructions 文本）
- Test: `src/lib/skills/builtin.test.ts`

**Interfaces:**
- Consumes: 无（纯文本）。
- Produces: 蒸馏 skill 指令含多标签页处理说明。

- [ ] **Step 1: 写失败测试**

在 `src/lib/skills/builtin.test.ts` 末尾追加：

```ts
it("create_skill_from_recording instructs preserving cross-tab steps", () => {
  const pkg = BUILT_IN_SKILL_PACKAGES.find((p) => p.id === "create_skill_from_recording");
  expect(pkg).toBeTruthy();
  const md = pkg!.files["SKILL.md"] ?? Object.values(pkg!.files)[0];
  const text = JSON.stringify(pkg);
  expect(text).toContain("switch_to_new_tab");
  expect(text).toMatch(/标签页|tab/);
});
```

> 注：`builtin.test.ts` 已 import `BUILT_IN_SKILL_PACKAGES`。若 pkg 内容字段名不同，用 `JSON.stringify(pkg)` 兜底匹配（上面已这么做）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/skills/builtin.test.ts`
Expected: FAIL（指令未含 `switch_to_new_tab`）

- [ ] **Step 3: 补指令文本**

在 `src/lib/skills/builtin.ts` 的 `create_skill_from_recording` instructions 里，`Constraints:` 段之前插入一段：

```
Multi-tab flows:
- The trace may contain tab-transition lines (— "切换到新打开的标签页…" /
  — "切回 <site> 的标签页…"). PRESERVE these as workflow steps; do NOT flatten
  the flow into a single-tab sequence.
- At run time the agent switches tabs with switch_to_new_tab (for a tab the
  previous step opened) and list_tabs + focus_tab (to return to an earlier
  tab; use list_tabs({allWindows:true}) if it may be in another window).
- Keep tab identity generic in the prose (e.g. "in the opened payment tab")
  rather than hardcoding the exact origin; the origin is only a hint.
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/skills/builtin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/builtin.ts src/lib/skills/builtin.test.ts
git commit -m "feat(recording): teach create_skill_from_recording about cross-tab steps"
```

---

### Task 5: `switch_to_new_tab` 工具 —— 收编+聚焦 spawn 出来的未 pin 子标签页

**Files:**
- Modify: `src/lib/agent/tools/tabs.ts`（新增 `switchToNewTabTool`；加入 `TAB_TOOLS`）
- Modify: `src/lib/agent/tool-names.ts`（`TAB_TOOL_NAMES` + `TOOL_CLASSES` + `TOOL_GROUPS`）
- Test: `src/lib/agent/tools/tabs.test.ts`

**Interfaces:**
- Consumes: `ToolHandlerContext`（`pinnedTabs` / `appendPinnedTab` / `setCurrentFocusTabId`）、`chrome.tabs.query` / `chrome.tabs.get`、`Tool` 类型。
- Produces: 工具 `switch_to_new_tab`（read-class，group=core）。

- [ ] **Step 1: 登记工具名/类/组**

在 `src/lib/agent/tool-names.ts`：
- `TAB_TOOL_NAMES` 数组末尾（`"unpin_tab",` 之后）加 `"switch_to_new_tab", // v1.1 cross-tab replay`
- `TOOL_CLASSES` 里 `unpin_tab` 行之后加：
  ```ts
  switch_to_new_tab: "read", // adopts a child tab this session spawned + sets focus; no page mutation
  ```
- `TOOL_GROUPS` 里 `unpin_tab: "core",` 同处加 `switch_to_new_tab: "core",`

- [ ] **Step 2: 写失败测试**

在 `src/lib/agent/tools/tabs.test.ts` 末尾追加（沿用该文件既有的 `chrome` stub 模式；若文件用 `vi.stubGlobal("chrome", ...)`，按其现有写法 mock `chrome.tabs.query`/`get`）：

```ts
import { switchToNewTabTool } from "./tabs";

describe("switch_to_new_tab", () => {
  const baseCtx = () => {
    const calls: { pin?: { tabId: number; origin: string }; focus?: number } = {};
    return {
      ctx: {
        tabId: 10,
        pinnedTabs: [{ tabId: 10, origin: "https://shop.com" }],
        appendPinnedTab: async (p: { tabId: number; origin: string }) => { calls.pin = p; },
        setCurrentFocusTabId: async (id: number) => { calls.focus = id; },
      } as any,
      calls,
    };
  };

  it("adopts the child tab matching the origin hint and focuses it", async () => {
    (globalThis as any).chrome = {
      tabs: {
        query: async () => [
          { id: 10, openerTabId: undefined, url: "https://shop.com/cart" },
          { id: 21, openerTabId: 10, url: "https://ads.example/x" },
          { id: 22, openerTabId: 10, url: "https://pay.stripe.com/checkout" },
        ],
        get: async (id: number) =>
          ({ 21: { id: 21, url: "https://ads.example/x" }, 22: { id: 22, url: "https://pay.stripe.com/checkout" } } as any)[id],
      },
    };
    const { ctx, calls } = baseCtx();
    const r = await switchToNewTabTool.handler({ origin: "https://pay.stripe.com" }, ctx);
    expect(r.success).toBe(true);
    expect(calls.pin).toEqual({ tabId: 22, origin: "https://pay.stripe.com" });
    expect(calls.focus).toBe(22);
  });

  it("falls back to the newest child when no origin matches", async () => {
    (globalThis as any).chrome = {
      tabs: {
        query: async () => [
          { id: 10, openerTabId: undefined, url: "https://shop.com/cart" },
          { id: 31, openerTabId: 10, url: "https://a.com/x" },
          { id: 33, openerTabId: 10, url: "https://b.com/y" },
        ],
        get: async (id: number) =>
          ({ 31: { id: 31, url: "https://a.com/x" }, 33: { id: 33, url: "https://b.com/y" } } as any)[id],
      },
    };
    const { ctx, calls } = baseCtx();
    const r = await switchToNewTabTool.handler({}, ctx);
    expect(r.success).toBe(true);
    expect(calls.focus).toBe(33); // highest tabId
  });

  it("returns a non-fatal observation when no child tab exists", async () => {
    (globalThis as any).chrome = { tabs: { query: async () => [{ id: 10, openerTabId: undefined, url: "https://shop.com" }] } };
    const { ctx } = baseCtx();
    const r = await switchToNewTabTool.handler({}, ctx);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("未检测到新标签页");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/tabs.test.ts`
Expected: FAIL（`switchToNewTabTool` 未导出）

- [ ] **Step 4: 实现工具**

在 `src/lib/agent/tools/tabs.ts`，`export { openUrlTool };` 之后、`export const TAB_TOOLS` 之前插入：

```ts
// ── v1.1 cross-tab replay — switch_to_new_tab ────────────────────────────────

/** 有界轮询：等候选标签页 url 脱离 about:blank/空（origin 未知，故不用 waitForUrlSettle）。 */
async function readSettledUrl(tabId: number, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // ponytail: 50ms 轮询；spawn 子页通常下一迭代已 commit，循环极少超过 1-2 轮。
  for (;;) {
    let url = "";
    try {
      url = (await chrome.tabs.get(tabId)).url ?? "";
    } catch {
      return ""; // tab gone
    }
    if (url && url !== "about:blank") return url;
    if (Date.now() >= deadline) return url;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function originOf(url: string): string {
  try {
    const o = new URL(url).origin;
    return !o || o === "null" ? "" : o;
  } catch {
    return "";
  }
}

/**
 * switch_to_new_tab — adopt a tab THIS session spawned (openerTabId ∈ pinned,
 * not yet pinned; cross-window included) and focus it. For replay of a step
 * whose original click opened a new tab. Read-class (no page mutation; only
 * pins+focuses a tab the session already caused to exist).
 */
const switchToNewTabTool: Tool = {
  name: "switch_to_new_tab",
  description:
    `Adopt and focus a tab that one of your pinned tabs just opened (e.g. the previous click opened a new tab/popup, including in another window). Pass the expected site origin as a hint when known. Takes effect on the NEXT iteration — call it, then read_page/click on the new tab afterwards.

USE WHEN:
- A step's click opened a new tab/popup and you need to continue inside it.

**DO NOT USE WHEN:**
- The tab is already pinned — use focus_tab.
- You know the exact URL and no tab was opened — use open_url.`,
  parameters: {
    type: "object",
    properties: {
      origin: {
        type: "string",
        description:
          "Optional expected origin of the newly-opened tab (e.g. https://pay.stripe.com), used to disambiguate when several tabs were opened.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = (args ?? {}) as { origin?: unknown };
    const wantOrigin = typeof a.origin === "string" ? a.origin : "";
    const pinnedIds = new Set((ctx.pinnedTabs ?? []).map((p) => p.tabId));
    if (pinnedIds.size === 0) {
      return { success: false, error: "switch_to_new_tab: no pinned tabs in this session." };
    }
    let all: chrome.tabs.Tab[];
    try {
      all = await chrome.tabs.query({});
    } catch (e) {
      return { success: false, error: `switch_to_new_tab: chrome.tabs.query failed — ${e instanceof Error ? e.message : String(e)}` };
    }
    // Candidates: opened by a tab we own, not yet pinned.
    const candidates = all.filter(
      (t) => typeof t.id === "number" && t.openerTabId !== undefined && pinnedIds.has(t.openerTabId) && !pinnedIds.has(t.id),
    );
    if (candidates.length === 0) {
      return { success: true, observation: "未检测到新标签页（上一步可能没有打开新标签页）。可在当前标签页继续，或调 fail。" };
    }
    // Settle URLs, then prefer origin match → newest (highest id) fallback.
    const settled = await Promise.all(
      candidates.map(async (t) => ({ id: t.id!, origin: originOf(await readSettledUrl(t.id!)) })),
    );
    const byOrigin = wantOrigin ? settled.filter((c) => c.origin === wantOrigin) : [];
    const pool = byOrigin.length > 0 ? byOrigin : settled;
    pool.sort((x, y) => y.id - x.id);
    const chosen = pool[0]!;

    if (ctx.appendPinnedTab) {
      try {
        await ctx.appendPinnedTab({ tabId: chosen.id, origin: chosen.origin });
      } catch {
        // non-fatal; continue to focus
      }
    }
    if (ctx.setCurrentFocusTabId) await ctx.setCurrentFocusTabId(chosen.id);

    const others = settled.filter((c) => c.id !== chosen.id).map((c) => `${c.id}@${c.origin || "?"}`);
    return {
      success: true,
      observation:
        `Adopted tab ${chosen.id} (origin ${chosen.origin || "?"}) and set focus; its snapshot is available next iteration.` +
        (others.length ? ` Other new tabs: [${others.join(", ")}] — if wrong, use list_tabs + focus_tab.` : ""),
    };
  },
};

export { switchToNewTabTool };
```

把 `switchToNewTabTool` 加入 `TAB_TOOLS` 数组（`openUrlTool` 之后）：

```ts
export const TAB_TOOLS: Tool[] = [
  listTabsTool,
  closeTabsTool,
  activateTabTool,
  groupTabsTool,
  ungroupTabsTool,
  moveTabsTool,
  focusTabTool,
  unpinTabTool,
  openUrlTool,
  switchToNewTabTool,
];
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/tabs.test.ts`
Expected: PASS（含原有 tabs 测试 + 新增 3 个）

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/tools/tabs.ts src/lib/agent/tool-names.ts src/lib/agent/tools/tabs.test.ts
git commit -m "feat(tabs): add switch_to_new_tab to adopt+focus spawned child tabs"
```

---

### Task 6: 全量验证 + 文档

**Files:**
- 无代码改动（验证 + 可选 README/solutions trace doc）

- [ ] **Step 1: 全量测试 + 类型 + 构建**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿；tool-names build-time invariant（read/write class + group）不 throw；manifest 不变。

- [ ] **Step 2: 同步 dist 供真机回归**

Run: `pnpm sync:dist`（若在 worktree，先 `pnpm build` 再同步到主仓库 dist），然后到 `chrome://extensions` 刷新。

- [ ] **Step 3: 真机回归清单**

逐项手测：
- 单标签页录制 → 蒸馏 → 运行：无回归。
- 录制时点链接开新标签页（`target=_blank`）→ 在新标签页操作 → trace 含"切换到它继续"转换 + 新标签页步骤。
- 录制时 `window.open` 弹窗（跨窗口）→ 同上覆盖。
- 录制时切回起始页继续操作 → trace 含"切回 … 的标签页"。
- 录制中关掉子标签页(非起始)→ 录制继续不中止；关掉所有流程标签页 → abort。
- 运行蒸馏出的多标签页 skill：spawn 步骤触发 `switch_to_new_tab` 收编子标签页、switch 步骤经 list_tabs+focus_tab 回起始页。

- [ ] **Step 4: Commit（如有 trace doc）**

```bash
git add docs/solutions/ 2>/dev/null || true
git commit -m "docs(recording): cross-tab recording/replay solution trace" || true
```

---

## Self-Review

**Spec coverage（逐 spec 节点对照）：**
- §3 流程标签页集合 → Task 2（`tabRefByTabId` 种子=起始页 + onCreated opener 判定）✅
- §4.1 tabRef → Task 1 ✅；§4.2 tabRegistry → Task 1（类型）+ Task 2（填充）✅；§4.3 转换 origin 取自 action.url → Task 1 Step 4(d) ✅
- §5.1 onCreated 仅登记 / onCommitted 注入扩集合 / 无 onActivated → Task 2(g)+Task 3 ✅
- §5.2 action 标 tabRef → Task 2(e) ✅
- §5.3 abort 仅空集合 / 起始页关闭不特殊 / origin 锚点惰性 → Task 2(h)+Task 3 Step 3 ✅
- §6.1 serialize 文案 → Task 1 ✅；§6.2 蒸馏 skill 多标签页说明 → Task 4 ✅
- §7.1 switch_to_new_tab（候选/origin 配对/newest 兜底/settle/零候选观测/报告）→ Task 5 ✅
- §7.2 switch 回老页 list_tabs+focus_tab → 复用既有工具（Task 4 指令告知 LLM）✅
- §7.3 loop 每轮重读 pin → 既有机制，无需改动（Task 5 依赖它）✅
- §8 单元边界 → Task 1/2/4/5 各对应一文件职责 ✅

**偏离 spec 处（已在 plan 内标注）：** §7.1 原写"复用 waitForUrlSettle/interpretPinnedTabUrl"，实测这俩需已知 origin；发现未知子标签页 origin 改用 `readSettledUrl` 有界轮询（Task 5 Step 4）。

**Placeholder scan:** 无 TBD/TODO；每个 code step 含完整代码。

**Type consistency:** `TabRegistry`（Task 1 定义）↔ Task 2 使用一致；`switchToNewTabTool` 导出名 ↔ Task 5 测试 import 一致；`registerFlowTab`/`recordFlowTabUrl`/`removeFlowTab`/`handleRecordingTabCreated` 签名 ↔ Task 2/3 一致。

**已知风险/ceiling（spec 已记，不阻塞）：** 同源多流程标签页配对歧义（newest 兜底）· junk 与目标同源 · 显式关页不入 trace。
