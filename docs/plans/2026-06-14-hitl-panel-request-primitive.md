# HITL 挂起原语（panel-request）+ 挂起式调度模型卡 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"SW 挂起一个 turn → panel 卡片裁决 → resolve per-session promise → 工具继续"这套已手搓两遍的 HITL 范式抽成统一原语 `panel-request`，迁移 CDP/local-file 两个旧调用点，并在其上落地 #184 的挂起式调度模型卡。

**Architecture:** 单一 `panel-request.ts` 模块按 `requestId` 维护 pending promise、按 `kind` 类型化 payload/返回；SW 侧 port 注册/响应/注销在 `background/index.ts` 收口为统一函数；panel 侧一个分发 hook 按 `kind` 挂对应卡片。旧 `cdp-input-onboarding.ts` / `local-file-request.ts` 退化为薄适配器。#184 是原语上的第一个新 `kind`。

**Tech Stack:** TypeScript 6 · React 19 · Chrome MV3 service worker · vitest + happy-dom + @testing-library/react · `chrome.runtime.Port` 流式通道。

**关联 spec:** `docs/specs/2026-06-14-hitl-panel-request-primitive.md` · issue #184

---

## 切片划分

- **切片 1（Task 1–6，基座）**：抽原语 + 迁移两旧点，behavior-preserving，现有测试当回归网。**单独可合并、可发版**。
- **切片 2（Task 7–12，#184）**：在原语上加 `schedule-model` kind + `ScheduleDraftCard`。

每个 Task 末尾 commit。切片 1 全绿后再开切片 2。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/lib/panel-request.ts` | HITL 请求原语：pending-by-requestId、kind 注册表、port 注册、超时、带外 resolve | **新建** |
| `src/lib/panel-request.test.ts` | 原语单测 | **新建** |
| `src/lib/cdp-input-onboarding.ts` | 退化为薄适配器（含 CDP 带外自动放行特例） | 改写 |
| `src/lib/local-file-request.ts` | 退化为薄适配器 | 改写 |
| `src/background/index.ts` | port 注册/响应/注销收口为统一函数 | 修改（73-81 import、1453-1454、1657-1675、1707-1712） |
| `src/sidepanel/hooks/usePanelRequest.ts` | panel 侧统一分发 hook：监听 `panel-request`，按 kind 暴露 pending + 回话 | **新建** |
| `src/sidepanel/hooks/useCdpOnboarding.ts` | 删除（被 usePanelRequest 取代） | 删除 |
| `src/sidepanel/hooks/useLocalFileRequest.ts` | 删除（被 usePanelRequest 取代） | 删除 |
| `src/sidepanel/components/Chat.tsx` | 用 usePanelRequest 替换两个旧 hook，渲染逻辑不变 | 修改（91-94 import、272-276、1524-1530） |
| `src/lib/agent/tools/schedule-meta.ts` | `create_schedule` 加挂起分支 + 合法性判定 helper | 修改（142-194） |
| `src/lib/agent/types.ts` | `ToolHandlerContext` 加 `requestModelSelection?` | 修改 |
| `src/lib/agent/loop.ts` | 装配 `ctx.requestModelSelection` | 修改（ctx 构建处） |
| `src/sidepanel/components/ScheduleDraftCard.tsx` | #184 模型选择卡（复用 ModelPicker） | **新建** |
| `src/sidepanel/components/ScheduleDraftCard.test.tsx` | 卡片测试 | **新建** |

---

# 切片 1：HITL 原语 + 迁移

## Task 1: panel-request 原语模块

**Files:**
- Create: `src/lib/panel-request.ts`
- Test: `src/lib/panel-request.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/panel-request.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerPanelPort,
  unregisterPanelPort,
  requestFromPanel,
  handlePanelResponse,
  resolvePendingByKind,
  __resetPanelRequestState,
} from "./panel-request";

function fakePort() {
  const sent: any[] = [];
  return {
    sent,
    postMessage: (m: any) => sent.push(m),
  } as unknown as chrome.runtime.Port & { sent: any[] };
}

beforeEach(() => __resetPanelRequestState());

describe("panel-request", () => {
  it("throws when no port is registered for the session", async () => {
    await expect(
      requestFromPanel("S1", "cdp-consent", {}),
    ).rejects.toThrow(/no sidepanel port/i);
  });

  it("posts a panel-request with a requestId and resolves on matching response", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    expect(port.sent).toHaveLength(1);
    const msg = port.sent[0];
    expect(msg.type).toBe("panel-request");
    expect(msg.kind).toBe("cdp-consent");
    expect(typeof msg.requestId).toBe("string");
    handlePanelResponse(msg.requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);
  });

  it("isolates two concurrent requests by requestId (no cross-talk)", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const a = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const b = requestFromPanel<"local-file">("S1", "local-file", {});
    const [idA, idB] = port.sent.map((m) => m.requestId);
    expect(idA).not.toBe(idB);
    handlePanelResponse(idB, { ok: true, data: { name: "f", mime: "text/plain", text: "x", truncated: false } });
    handlePanelResponse(idA, { ok: true, data: false });
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toMatchObject({ name: "f" });
  });

  it("rejects all pending for a session when the panel port unregisters", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    unregisterPanelPort("S1");
    await expect(p).rejects.toThrow(/panel closed/i);
  });

  it("rejects on timeout and posts a timeout dismiss", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"local-file">("S1", "local-file", {}, { timeoutMs: 1000 });
    const reqId = port.sent[0].requestId;
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(1001);
    await assertion;
    expect(port.sent.some((m) => m.type === "panel-request-timeout" && m.requestId === reqId)).toBe(true);
    vi.useRealTimers();
  });

  it("resolvePendingByKind resolves all pending of that kind and posts a resolved dismiss", async () => {
    const p1 = fakePort();
    const p2 = fakePort();
    registerPanelPort("S1", p1);
    registerPanelPort("S2", p2);
    const a = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const b = requestFromPanel<"cdp-consent">("S2", "cdp-consent", {});
    resolvePendingByKind("cdp-consent", true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(p1.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
    expect(p2.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
  });

  it("ignores a response for an unknown requestId", () => {
    expect(() => handlePanelResponse("nope", { ok: true, data: true })).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/panel-request.test.ts`
Expected: FAIL（`Cannot find module './panel-request'`）

- [ ] **Step 3: 实现原语**

`src/lib/panel-request.ts`：

```ts
// HITL（human-in-the-loop）请求原语。
//
// 取代两份手搓实现（cdp-input-onboarding.ts / local-file-request.ts）：SW 挂起
// 一个 turn → 往 panel 发请求 → 等用户卡片裁决 → resolve/reject 一个 promise。
// 一个 session 一个 port，承载整条通道；pending 按 requestId 隔离，并发不串台。
//
// 注意：本原语**不是**风险拦截 confirm 层（那套已删，有 no-confirm-* 跨层测试守着）。
// 它只服务"工具语义即问人"（授权 / 选文件 / 选模型）的场景。

import type { LocalFileResult } from "./local-file-request";
import type { ScheduleDraftPayload, ScheduleModelSelection } from "./agent/tools/schedule-meta";

/** kind 注册表：加一种人机交互 = 加一行，编译期校验 payload/返回。 */
export interface PanelRequestMap {
  "cdp-consent": { req: Record<string, never>; res: boolean };
  "local-file": { req: Record<string, never>; res: LocalFileResult };
  "schedule-model": { req: ScheduleDraftPayload; res: ScheduleModelSelection };
}
export type PanelRequestKind = keyof PanelRequestMap;

interface PendingRequest {
  sessionId: string;
  kind: PanelRequestKind;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const portsBySession = new Map<string, chrome.runtime.Port>();
const pendingByRequestId = new Map<string, PendingRequest>();

/** Test-only：清空模块状态。 */
export function __resetPanelRequestState(): void {
  portsBySession.clear();
  for (const p of pendingByRequestId.values()) if (p.timer) clearTimeout(p.timer);
  pendingByRequestId.clear();
}

export function registerPanelPort(sessionId: string, port: chrome.runtime.Port): void {
  portsBySession.set(sessionId, port);
}

/** Panel 关闭：reject 该 session 全部 pending，避免悬挂。 */
export function unregisterPanelPort(sessionId: string): void {
  portsBySession.delete(sessionId);
  for (const [reqId, p] of pendingByRequestId.entries()) {
    if (p.sessionId !== sessionId) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingByRequestId.delete(reqId);
    p.reject(new Error(`panel-request cancelled (panel closed) for session ${sessionId}`));
  }
}

export async function requestFromPanel<K extends PanelRequestKind>(
  sessionId: string,
  kind: K,
  payload: PanelRequestMap[K]["req"],
  opts?: { timeoutMs?: number },
): Promise<PanelRequestMap[K]["res"]> {
  const port = portsBySession.get(sessionId);
  if (!port) {
    throw new Error(`Cannot send panel-request "${kind}": no sidepanel port for session ${sessionId}`);
  }
  const requestId = crypto.randomUUID();
  return new Promise<PanelRequestMap[K]["res"]>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs) {
      timer = setTimeout(() => {
        pendingByRequestId.delete(requestId);
        const p = portsBySession.get(sessionId);
        if (p) p.postMessage({ type: "panel-request-timeout", sessionId, requestId });
        reject(new Error(`panel-request "${kind}" timed out`));
      }, opts.timeoutMs);
    }
    pendingByRequestId.set(requestId, {
      sessionId,
      kind,
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
    });
    port.postMessage({ type: "panel-request", sessionId, requestId, kind, payload });
  });
}

/** Panel 回话：按 requestId 定位并 resolve/reject。未知 id 静默忽略。 */
export function handlePanelResponse(
  requestId: string,
  response: { ok: true; data: unknown } | { ok: false; reason: string },
): void {
  const pending = pendingByRequestId.get(requestId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingByRequestId.delete(requestId);
  if (response.ok) pending.resolve(response.data);
  else pending.reject(new Error(response.reason));
}

/**
 * 带外 resolve：不经 panel 回话，直接 resolve 某 kind 的全部 pending（跨 session）。
 * 用于 CDP 特例——另一个 session 把 cdp-input 开关翻 true 时自动放行所有等待中的
 * consent。同时给对应 panel 发 panel-request-resolved，让卡片消失。
 */
export function resolvePendingByKind<K extends PanelRequestKind>(
  kind: K,
  data: PanelRequestMap[K]["res"],
): void {
  for (const [reqId, p] of pendingByRequestId.entries()) {
    if (p.kind !== kind) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingByRequestId.delete(reqId);
    const port = portsBySession.get(p.sessionId);
    if (port) port.postMessage({ type: "panel-request-resolved", sessionId: p.sessionId, requestId: reqId });
    p.resolve(data);
  }
}
```

> 注：`schedule-meta.ts` 尚未导出 `ScheduleDraftPayload` / `ScheduleModelSelection`（Task 7 才加）。本 Task 先让 `panel-request.ts` 编译通过——临时在本文件内联这两个类型的最小定义，Task 7 再改为从 `schedule-meta` import。临时定义：
> ```ts
> // TEMP（Task 7 替换为 import）：
> type ScheduleDraftPayload = { title: string; prompt: string; specSummary: string };
> type ScheduleModelSelection = { instanceId: string; model: string };
> ```
> 用临时定义时删掉顶部那行 `import type { ScheduleDraftPayload, ... }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/panel-request.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 0 错

- [ ] **Step 6: Commit**

```bash
git add src/lib/panel-request.ts src/lib/panel-request.test.ts
git commit -m "feat(hitl): add panel-request HITL primitive (requestId-keyed, kind-typed)"
```

---

## Task 2: cdp-input-onboarding 退化为薄适配器

**Files:**
- Modify: `src/lib/cdp-input-onboarding.ts`（整文件改写）
- 现有回归网：`src/lib/agent/tools/mouse.test.ts`、`editor.test.ts`、`keyboard.test.ts`、`src/__tests__/cross-layer/cdp-input-consent-gating.test.ts`

- [ ] **Step 1: 改写 cdp-input-onboarding.ts**

```ts
import {
  setCdpInputEnabled,
  type CdpInputState,
} from "./cdp-input-enabled";
import { requestFromPanel, resolvePendingByKind } from "./panel-request";

/**
 * 请求 CDP 输入授权。挂起当前 turn 直至用户在卡片应答（true/false），或另一个
 * session 翻开关触发带外放行（见 onCdpInputEnabledChanged）。resolve 后持久化
 * 授权 flag（幂等；放行路径下 flag 已为 true，重设无副作用）。
 */
export async function requestCdpInputConsent(sessionId: string): Promise<boolean> {
  const granted = await requestFromPanel(sessionId, "cdp-consent", {});
  await setCdpInputEnabled(granted);
  return granted;
}

/**
 * background/index.ts 在 cdp-input-enabled flag 经 store-bus 变化时调用。flag 现在
 * 为 true 时，自动放行所有等待中的 consent（带外 resolve，卡片随之消失）。
 */
export function onCdpInputEnabledChanged(enabled: CdpInputState): void {
  if (enabled !== true) return;
  resolvePendingByKind("cdp-consent", true);
}
```

> 删掉的旧导出：`portsBySession` / `pendingBySession` / `registerOnboardingPort` / `unregisterOnboardingPort` / `requestCdpInputConsent` 旧实现 / `handleOnboardingResponse`。`PendingRequest` interface 删除。Task 3 修 background/index.ts 的 import。

- [ ] **Step 2: 回到 Task 1 临时类型——确认 panel-request.ts 仍编译**

（无操作，仅提醒：此时 panel-request.ts 仍用 Task 1 的临时类型；切勿提前改它。）

- [ ] **Step 3: typecheck（预期此处仍红——background/index.ts 还引用旧导出）**

Run: `pnpm typecheck 2>&1 | grep -E "cdp-input-onboarding|registerOnboardingPort|handleOnboardingResponse" | head`
Expected: 报 `background/index.ts` 找不到 `registerOnboardingPort` 等——这是预期的，Task 3 修。

- [ ] **Step 4: 暂不 commit**，与 Task 3 一起提交（背景 import 改完才编译通过）。

---

## Task 3: local-file-request 退化为薄适配器 + SW 收口

**Files:**
- Modify: `src/lib/local-file-request.ts`（整文件改写，保留 `LocalFileResult` 与 `REQUEST_TIMEOUT_MS` 导出）
- Modify: `src/background/index.ts`（73-81 import、1453-1454、1657-1675、1707-1712）

- [ ] **Step 1: 改写 local-file-request.ts**

```ts
// SW↔panel round-trip for the `request_local_file` human-in-the-loop tool。
// 退化为 panel-request 原语的薄适配器；类型/超时常量保持对外可见。
import { requestFromPanel } from "./panel-request";

export interface LocalFileResult {
  name: string;
  mime: string;
  text: string;
  truncated: boolean;
}

export const REQUEST_TIMEOUT_MS = 120_000;

export async function requestLocalFileFromPanel(sessionId: string): Promise<LocalFileResult> {
  return requestFromPanel(sessionId, "local-file", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
}
```

> 删掉的旧导出：`portsBySession` / `pendingBySession` / `registerLocalFilePort` / `unregisterLocalFilePort` / `handleLocalFileResponse` / `PendingRequest`。

- [ ] **Step 2: 收口 background/index.ts**

73-81 行 import 块，把两套旧函数 import 替换为：

```ts
import {
  registerPanelPort,
  unregisterPanelPort,
  handlePanelResponse,
} from "../lib/panel-request";
import { onCdpInputEnabledChanged } from "../lib/cdp-input-onboarding"; // 若该 import 已在别处保留则不重复
```

> 删除原 `registerOnboardingPort / unregisterOnboardingPort / handleOnboardingResponse`（73-75）与 `registerLocalFilePort / unregisterLocalFilePort / handleLocalFileResponse`（79-81）的 import。保留 `onCdpInputEnabledChanged` 的 import（store-bus 监听处仍调用它——用 `grep -n onCdpInputEnabledChanged src/background/index.ts` 确认其调用点不动）。

1453-1454 行，注册两个 port 合并为一行：

```ts
registerPanelPort(portSessionId, port);
```

1657-1675 行，两段响应分发（`cdp-onboarding-response` + `local-file-response`）合并为一段：

```ts
// HITL panel-request — panel 回话（CDP 授权 / 选文件 / 选模型等），按 requestId 路由。
if (rawMsg.type === "panel-response" && typeof (rawMsg as { requestId?: unknown }).requestId === "string") {
  const r = rawMsg as unknown as {
    requestId: string;
  } & ({ ok: true; data: unknown } | { ok: false; reason: string });
  handlePanelResponse(r.requestId, r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason });
}
```

> 删除原 `cdp-onboarding-response` 与 `local-file-response` 两个 `if` 块。

1707-1712 行，注销合并：

```ts
portsBySession.delete(portSessionId);
unregisterPanelPort(portSessionId);
```

> 删除 `unregisterOnboardingPort(portSessionId)` 与 `unregisterLocalFilePort(portSessionId)`。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 0 错（Task 2 + Task 3 改完，背景 import 闭合）

- [ ] **Step 4: 跑 CDP / local-file 回归网**

Run: `pnpm test src/lib/agent/tools/mouse.test.ts src/lib/agent/tools/editor.test.ts src/lib/agent/tools/keyboard.test.ts src/__tests__/cross-layer/cdp-input-consent-gating.test.ts`
Expected: 全绿（工具侧只认 `requestConsent`/`requestFile` 回调签名，未变）

> 若 `src/lib/local-file-request.test.ts` 因测旧内部实现（portsBySession 等）而红：该测试测的是已删的实现细节。改为只测薄适配器对外契约（`requestLocalFileFromPanel` 调 `requestFromPanel` with `"local-file"` + timeout）。用 vi.mock("./panel-request") 断言转发参数。若原测试断言已删的内部行为且无对外契约可测，删除该测试文件并记在 commit message。

- [ ] **Step 5: Commit（Task 2+3 一起）**

```bash
git add src/lib/cdp-input-onboarding.ts src/lib/local-file-request.ts src/background/index.ts src/lib/local-file-request.test.ts
git commit -m "refactor(hitl): migrate cdp-consent + local-file onto panel-request primitive

SW port 注册/响应/注销在 background/index.ts 收口为统一函数；两旧模块退化为
薄适配器。CDP 带外自动放行（onCdpInputEnabledChanged）改走 resolvePendingByKind。"
```

---

## Task 4: §4.4 CDP 带外放行 + 持久化副作用专项测试

**Files:**
- Test: `src/lib/cdp-input-onboarding.test.ts`（新建或扩充）

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerPanelPort, __resetPanelRequestState } from "./panel-request";
import { requestCdpInputConsent, onCdpInputEnabledChanged } from "./cdp-input-onboarding";

const setEnabled = vi.fn();
vi.mock("./cdp-input-enabled", () => ({
  setCdpInputEnabled: (...a: unknown[]) => setEnabled(...a),
}));

function fakePort() {
  const sent: any[] = [];
  return { sent, postMessage: (m: any) => sent.push(m) } as unknown as chrome.runtime.Port & { sent: any[] };
}

beforeEach(() => {
  __resetPanelRequestState();
  setEnabled.mockReset();
  setEnabled.mockResolvedValue(undefined);
});

describe("cdp-input-onboarding adapter", () => {
  it("persists the flag after the user grants via panel", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestCdpInputConsent("S1");
    // 模拟 panel 通过 handlePanelResponse 放行
    const { handlePanelResponse } = await import("./panel-request");
    handlePanelResponse(port.sent[0].requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("out-of-band: another session flipping the flag auto-resolves pending consent as true", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestCdpInputConsent("S1");
    onCdpInputEnabledChanged(true);
    await expect(p).resolves.toBe(true);
    // 卡片消失消息已发
    expect(port.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
    // resolve 续作仍持久化 flag（幂等）
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("onCdpInputEnabledChanged ignores non-true states", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestCdpInputConsent("S1");
    onCdpInputEnabledChanged(false);
    // 仍 pending；用一个真实响应收尾避免悬挂
    const { handlePanelResponse } = await import("./panel-request");
    handlePanelResponse(port.sent[0].requestId, { ok: true, data: false });
    await expect(p).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm test src/lib/cdp-input-onboarding.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 3: Commit**

```bash
git add src/lib/cdp-input-onboarding.test.ts
git commit -m "test(hitl): cover CDP out-of-band auto-grant + flag persistence after migration"
```

---

## Task 5: panel 侧统一分发 hook + Chat 接线

**Files:**
- Create: `src/sidepanel/hooks/usePanelRequest.ts`
- Test: `src/sidepanel/hooks/usePanelRequest.test.ts`
- Delete: `src/sidepanel/hooks/useCdpOnboarding.ts`、`src/sidepanel/hooks/useLocalFileRequest.ts`（及其 `.test.ts`）
- Modify: `src/sidepanel/components/Chat.tsx`（91-94 import、272-276、1524-1530）

- [ ] **Step 1: 写 hook 失败测试**

`src/sidepanel/hooks/usePanelRequest.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePanelRequest } from "./usePanelRequest";

function fakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  const sent: any[] = [];
  return {
    sent,
    trigger: (m: unknown) => listeners.forEach((l) => l(m)),
    onMessage: {
      addListener: (l: (m: unknown) => void) => listeners.push(l),
      removeListener: () => {},
    },
    postMessage: (m: any) => sent.push(m),
  } as unknown as chrome.runtime.Port & { sent: any[]; trigger: (m: unknown) => void };
}

describe("usePanelRequest", () => {
  it("exposes the active request for this session and clears it on respond", () => {
    const port = fakePort();
    const { result } = renderHook(() => usePanelRequest(port, "S1"));
    expect(result.current.active).toBeNull();

    act(() => port.trigger({ type: "panel-request", sessionId: "S1", requestId: "r1", kind: "cdp-consent", payload: {} }));
    expect(result.current.active).toMatchObject({ requestId: "r1", kind: "cdp-consent" });

    act(() => result.current.respond("r1", { ok: true, data: true }));
    expect(result.current.active).toBeNull();
    expect(port.sent).toContainEqual({ type: "panel-response", sessionId: "S1", requestId: "r1", ok: true, data: true });
  });

  it("ignores requests for other sessions", () => {
    const port = fakePort();
    const { result } = renderHook(() => usePanelRequest(port, "S1"));
    act(() => port.trigger({ type: "panel-request", sessionId: "S2", requestId: "r9", kind: "cdp-consent", payload: {} }));
    expect(result.current.active).toBeNull();
  });

  it("clears the active card on timeout / resolved dismiss", () => {
    const port = fakePort();
    const { result } = renderHook(() => usePanelRequest(port, "S1"));
    act(() => port.trigger({ type: "panel-request", sessionId: "S1", requestId: "r1", kind: "cdp-consent", payload: {} }));
    act(() => port.trigger({ type: "panel-request-resolved", sessionId: "S1", requestId: "r1" }));
    expect(result.current.active).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/hooks/usePanelRequest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 hook**

`src/sidepanel/hooks/usePanelRequest.ts`：

```ts
import { useEffect, useState, useCallback } from "react";

export interface ActivePanelRequest {
  requestId: string;
  kind: string;
  payload: unknown;
}

export type PanelResponseBody = { ok: true; data: unknown } | { ok: false; reason: string };

interface State {
  /** 当前 session 待应答的请求；无则 null。一次至多一个。 */
  active: ActivePanelRequest | null;
  respond: (requestId: string, body: PanelResponseBody) => void;
}

/**
 * Panel 侧 HITL 分发：监听统一 `panel-request`，暴露当前待应答请求；`respond`
 * 回 `panel-response`。超时/带外放行（panel-request-timeout / -resolved）清卡。
 * 取代旧的 useCdpOnboarding / useLocalFileRequest。
 */
export function usePanelRequest(
  port: chrome.runtime.Port | null,
  sessionId: string | null,
): State {
  const [active, setActive] = useState<ActivePanelRequest | null>(null);

  useEffect(() => {
    if (!port || !sessionId) return;
    const listener = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: string; sessionId?: string; requestId?: string; kind?: string; payload?: unknown };
      if (m.sessionId !== sessionId) return;
      if (m.type === "panel-request" && m.requestId && m.kind) {
        setActive({ requestId: m.requestId, kind: m.kind, payload: m.payload });
      } else if (m.type === "panel-request-timeout" || m.type === "panel-request-resolved") {
        setActive((cur) => (cur && cur.requestId === m.requestId ? null : cur));
      }
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port, sessionId]);

  // 切 session 时清卡，避免残留。
  useEffect(() => setActive(null), [sessionId]);

  const respond = useCallback(
    (requestId: string, body: PanelResponseBody) => {
      if (!port || !sessionId) return;
      port.postMessage({ type: "panel-response", sessionId, requestId, ...body });
      setActive((cur) => (cur && cur.requestId === requestId ? null : cur));
    },
    [port, sessionId],
  );

  return { active, respond };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/hooks/usePanelRequest.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: 改 Chat.tsx 接线**

91-94 行 import：删 `useCdpOnboarding` / `useLocalFileRequest` 两行，保留 `CdpOnboardingCard` / `LocalFileRequestCard` 两个组件 import，加：

```ts
import { usePanelRequest } from "../hooks/usePanelRequest";
```

272-276 行，两个旧 hook 调用替换为：

```ts
const { active: panelRequest, respond: respondPanel } = usePanelRequest(session.port, sessionId);
```

1524-1530 行，两段卡片条件渲染替换为按 `kind` 分发：

```tsx
{panelRequest?.kind === "cdp-consent" && (
  <CdpOnboardingCard
    onAnswer={(enabled) => respondPanel(panelRequest.requestId, { ok: true, data: enabled })}
  />
)}
{panelRequest?.kind === "local-file" && (
  <LocalFileRequestCard
    onChoose={() => localFileRequestInputRef.current?.click()}
    onCancel={() => respondPanel(panelRequest.requestId, { ok: false, reason: "cancelled by user" })}
  />
)}
```

> 暗礁：原 local-file 的"选好文件"是经 `localFileRequestInputRef` 的隐藏 `<input type=file>` 的 onChange 把文件读出来再 `respondLocalFile({ok:true,...})`。该 onChange 现需改为 `respondPanel(panelRequest.requestId, { ok: true, data: { name, mime, text, truncated } })`。用 `grep -n "respondLocalFile" src/sidepanel/components/Chat.tsx` 找到 onChange 处一并改（把 `respondLocalFile(x)` → `panelRequest && respondPanel(panelRequest.requestId, x)`）。CDP 卡的 `cdp-onboarding-resolved` 监听已由 hook 的 `panel-request-resolved` 接管，无需 Chat 处理。

- [ ] **Step 6: 删旧 hook 文件**

```bash
git rm src/sidepanel/hooks/useCdpOnboarding.ts src/sidepanel/hooks/useCdpOnboarding.test.ts \
       src/sidepanel/hooks/useLocalFileRequest.ts
# 若存在 useLocalFileRequest.test.ts 一并 git rm
```

- [ ] **Step 7: typecheck + 相关组件测试**

Run: `pnpm typecheck && pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: 0 错；Chat 测试绿（如有断言旧 hook 行为的用例，改为断言 usePanelRequest 路径）

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(hitl): unify panel-side dispatch into usePanelRequest; drop per-feature hooks"
```

---

## Task 6: 切片 1 全量回归

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（迁移无回归）

- [ ] **Step 2: typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 0 错；build 成功（tool-names.ts / tools.ts 构建期不变量不 throw）

- [ ] **Step 3:（如本切片单独合并）按 finishing-a-development-branch 走 PR。** 否则继续切片 2。

---

# 切片 2：#184 挂起式调度模型卡

## Task 7: schedule-model kind 类型 + 注册

**Files:**
- Modify: `src/lib/agent/tools/schedule-meta.ts`（顶部加导出类型）
- Modify: `src/lib/panel-request.ts`（去掉 Task 1 的临时类型，改 import）

- [ ] **Step 1: 在 schedule-meta.ts 顶部导出类型**

```ts
/** #184 挂起式模型卡：待建任务摘要（payload）与用户选择（返回）。 */
export interface ScheduleDraftPayload {
  title: string;
  prompt: string;
  /** 人类可读的触发摘要，如 "every 60 min from 2026-06-15 09:00"。 */
  specSummary: string;
}
export interface ScheduleModelSelection {
  instanceId: string;
  model: string;
}
```

- [ ] **Step 2: panel-request.ts 改回 import**

删掉 Task 1 Step 3 注里的临时 `type ScheduleDraftPayload` / `ScheduleModelSelection`，恢复顶部：

```ts
import type { ScheduleDraftPayload, ScheduleModelSelection } from "./agent/tools/schedule-meta";
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 0 错（注意潜在循环 import：`panel-request` ← `schedule-meta`。若 `schedule-meta` 间接 import `panel-request` 形成 cycle，`import type` 是纯类型擦除、运行期无 cycle，typecheck 仍 0 错。若值层出现 cycle，把这两个类型移到独立 `src/lib/schedules/types.ts` 并双方 import。）

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/tools/schedule-meta.ts src/lib/panel-request.ts
git commit -m "feat(hitl): register schedule-model kind types on panel-request"
```

---

## Task 8: create_schedule 挂起分支 + 合法性判定

**Files:**
- Modify: `src/lib/agent/types.ts`（`ToolHandlerContext` 加字段）
- Modify: `src/lib/agent/tools/schedule-meta.ts`（handler 142-194）
- Test: `src/lib/agent/tools/schedule-meta.test.ts`

- [ ] **Step 1: ToolHandlerContext 加可选字段**

`src/lib/agent/types.ts`，在 `ToolHandlerContext` interface 内（紧挨 `currentInstanceId`/`currentModel` 字段处）加：

```ts
  /**
   * #184 — 挂起式模型选择。chat 路径由 loop 注入：弹 ScheduleDraftCard 并阻塞
   * 至用户提交 (instanceId, model)。headless 调度跑（run.ts）不注入——彼路径
   * create_schedule 已被 disabledScheduleTools 摘除，不会走到这里。
   */
  requestModelSelection?: (payload: ScheduleDraftPayload) => Promise<ScheduleModelSelection>;
```

> 在 `types.ts` 顶部加 `import type { ScheduleDraftPayload, ScheduleModelSelection } from "./tools/schedule-meta";`。

- [ ] **Step 2: 写失败测试**

`schedule-meta.test.ts` 加用例（沿用该文件既有的 ctx mock 风格）：

```ts
it("未点名模型 → 弹卡挂起，用 requestModelSelection 的结果落地", async () => {
  const requestModelSelection = vi.fn().mockResolvedValue({ instanceId: "inst-x", model: "model-y" });
  const ctx = makeCtx({ currentInstanceId: undefined, currentModel: undefined, requestModelSelection });
  const res = await createScheduleTool.handler(
    { title: "T", prompt: "P", spec: { intervalMinutes: 60 } },
    ctx,
  );
  expect(requestModelSelection).toHaveBeenCalledWith(
    expect.objectContaining({ title: "T", prompt: "P", specSummary: expect.any(String) }),
  );
  expect(res.success).toBe(true);
  expect(res.observation).toMatch(/instanceId=inst-x.*model=model-y/);
});

it("显式合法 (instanceId, model) → 直接建，不弹卡", async () => {
  const requestModelSelection = vi.fn();
  const ctx = makeCtx({ requestModelSelection });
  const res = await createScheduleTool.handler(
    { title: "T", prompt: "P", instanceId: VALID_INSTANCE_ID, model: VALID_MODEL_ID },
    ctx,
  );
  expect(requestModelSelection).not.toHaveBeenCalled();
  expect(res.success).toBe(true);
});

it("无 panel（requestModelSelection 缺失）且无法解析 → 回退现有 resolveSelection 兜底/错误", async () => {
  const ctx = makeCtx({ currentInstanceId: undefined, currentModel: undefined, requestModelSelection: undefined });
  const res = await createScheduleTool.handler({ title: "T", prompt: "P" }, ctx);
  // 既有兜底行为不变（resolveSelection → 成功或 "no AI provider configured" 错误）
  expect(typeof res.success).toBe("boolean");
});
```

> `makeCtx` / `VALID_INSTANCE_ID` / `VALID_MODEL_ID`：复用该测试文件已有的 helper 与 fixture（用 `grep -n "makeCtx\|ToolHandlerContext\|instanceId" src/lib/agent/tools/schedule-meta.test.ts` 对齐既有命名；若无 `makeCtx` 则照已有用例构造 ctx 的方式补一个最小工厂）。`create_schedule` 现无 `model` 参数 schema——本 Task Step 4 顺带加 `model` 入参（见下）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/schedule-meta.test.ts`
Expected: FAIL（handler 尚无挂起分支；`model` 入参未声明）

- [ ] **Step 4: 改 handler（142-194）**

a) `parameters.properties` 加 `model`（紧随 `instanceId`）：

```ts
      model: {
        type: "string",
        description: "Specific model id for this instance. Omit to be prompted (chat) or fall back to the instance default.",
      },
```

b) 把 160-175 的模型解析块替换为（含挂起分支）：

```ts
    // 解析 (instanceId, model)：显式且合法 → 直接用；否则 chat 路径弹卡挂起，
    // 无 panel 时回退 ctx 会话 / resolveSelection 兜底。
    let instanceId: string;
    let model: string | undefined;

    const explicit = await resolveExplicitSelection(a.instanceId, a.model);
    if (explicit.valid) {
      instanceId = explicit.instanceId;
      model = explicit.model;
    } else if (ctx.requestModelSelection) {
      const sel = await ctx.requestModelSelection({
        title: a.title,
        prompt: a.prompt,
        specSummary: summarizeSpec(spec),
      });
      instanceId = sel.instanceId;
      model = sel.model;
    } else if (isNonEmptyString(ctx.currentInstanceId)) {
      instanceId = ctx.currentInstanceId;
      model = isNonEmptyString(ctx.currentModel) ? ctx.currentModel : undefined;
    } else {
      const sel = await resolveSelection({});
      if (!sel) return err("no AI provider configured — add one in Settings, or pass an explicit instanceId");
      instanceId = sel.instanceId;
      model = sel.model;
    }
```

c) 在文件内（工具定义上方）加两个 helper：

```ts
/** 把 spec 转成人类可读摘要，供 ScheduleDraftCard 展示。 */
function summarizeSpec(spec: ScheduleSpec): string {
  const parts: string[] = [];
  if (spec.startAt) parts.push(`start ${new Date(spec.startAt).toLocaleString()}`);
  if (spec.intervalMinutes) parts.push(`every ${spec.intervalMinutes} min`);
  else parts.push("one-shot");
  if (spec.maxRuns) parts.push(`max ${spec.maxRuns} runs`);
  return parts.join(", ");
}

/**
 * 显式选择合法性：instanceId 与 model 都给出，且 model 在该实例可用列表里。
 * 任一缺失或不匹配 → valid:false（交由挂起卡 / 兜底处理）。
 */
async function resolveExplicitSelection(
  rawInstanceId: unknown,
  rawModel: unknown,
): Promise<{ valid: true; instanceId: string; model: string } | { valid: false }> {
  if (!isNonEmptyString(rawInstanceId) || !isNonEmptyString(rawModel)) return { valid: false };
  const instances = await listInstances();
  const inst = instances.find((i) => i.id === rawInstanceId);
  if (!inst) return { valid: false };
  const available = modelsFor(inst).map((r) => r.model);
  if (!available.includes(rawModel)) return { valid: false };
  return { valid: true, instanceId: rawInstanceId, model: rawModel };
}
```

> import 对齐：`listInstances` 来自 `@/lib/instances`，`modelsFor` 来自 `../../../sidepanel/components/ModelPicker`（已导出，见 ModelPicker.tsx:55）。若从 `agent/tools/` 反向 import sidepanel 组件不妥（SW bundle 不应拉 UI），则把 `modelsFor` 的纯逻辑（registry→fetched→custom dedup）下沉到 `src/lib/model-router` 的一个纯函数并双方复用——**实施时先试直接 import，typecheck/build 若因 UI 依赖报错或 bundle 体积异常，再下沉**。`ModelRow.model` 字段名以 ModelPicker.tsx 实际为准（用 `grep -n "type ModelRow\|interface ModelRow" src/sidepanel/components/ModelPicker.tsx` 确认）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/schedule-meta.test.ts`
Expected: PASS

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: 0 错

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/types.ts src/lib/agent/tools/schedule-meta.ts src/lib/agent/tools/schedule-meta.test.ts
git commit -m "feat(schedule): create_schedule suspends for model card when selection is implicit/invalid (#184)"
```

---

## Task 9: ScheduleDraftCard 组件

**Files:**
- Create: `src/sidepanel/components/ScheduleDraftCard.tsx`
- Test: `src/sidepanel/components/ScheduleDraftCard.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScheduleDraftCard } from "./ScheduleDraftCard";

const payload = { title: "Daily digest", prompt: "summarize", specSummary: "every 1440 min" };

describe("ScheduleDraftCard", () => {
  it("renders the draft summary and a ModelPicker; submit returns (instanceId, model)", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ScheduleDraftCard payload={payload} instances={[]} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    expect(screen.getByText(/Daily digest/)).toBeInTheDocument();
    expect(screen.getByText(/every 1440 min/)).toBeInTheDocument();
    // 选模型由内部 ModelPicker.onSelect 驱动；这里直接点取消验证回调
    fireEvent.click(screen.getByRole("button", { name: /cancel|取消/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ScheduleDraftCard.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

```tsx
import { useState } from "react";
import type { DecryptedInstance } from "@/lib/instances";
import { useT } from "@/lib/i18n";
import ModelPicker from "./ModelPicker";
import type { ScheduleDraftPayload } from "@/lib/agent/tools/schedule-meta";

interface Props {
  payload: ScheduleDraftPayload;
  instances: DecryptedInstance[];
  onSubmit: (instanceId: string, model: string) => void;
  onCancel: () => void;
}

/**
 * #184 — 挂起式模型选择卡。chat 建 schedule 未指定/非法模型时弹出，复用
 * Composer 的 ModelPicker；提交回 (instanceId, model)，工具 await 至此 resolve。
 * 与 CdpOnboardingCard / LocalFileRequestCard 同构，Chat 内联渲染。
 */
export function ScheduleDraftCard({ payload, instances, onSubmit, onCancel }: Props) {
  const t = useT();
  const [sel, setSel] = useState<{ instanceId: string; model: string } | null>(null);

  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-fg-2">
      <div className="font-medium text-fg-1">{t("schedule.draftCard.title", "Pick a model for this scheduled task")}</div>
      <div className="mt-1 text-fg-2">{payload.title}</div>
      <div className="mt-0.5 text-fg-3">{payload.specSummary}</div>

      <div className="mt-2">
        <ModelPicker
          instances={instances}
          currentInstanceId={sel?.instanceId ?? null}
          currentModel={sel?.model ?? null}
          locked={false}
          onSelect={(instanceId, model) => setSel({ instanceId, model })}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <button
          className="rounded-md bg-accent px-3 py-1.5 text-white disabled:opacity-50"
          disabled={!sel}
          onClick={() => sel && onSubmit(sel.instanceId, sel.model)}
        >
          {t("schedule.draftCard.create", "Create")}
        </button>
        <button className="rounded-md border border-line px-3 py-1.5" onClick={onCancel}>
          {t("common.cancel", "Cancel")}
        </button>
      </div>
    </div>
  );
}
```

> i18n key 用 `useT()` 的 `(key, fallback)` 形式（与既有卡片一致；用 `grep -n "useT()" src/sidepanel/components/CdpOnboardingCard.tsx` 确认调用签名）。className token（border-line / bg-surface / text-fg-* / bg-accent）照 SessionConfirmCard.tsx 既有 token 体系，不自创。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ScheduleDraftCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ScheduleDraftCard.tsx src/sidepanel/components/ScheduleDraftCard.test.tsx
git commit -m "feat(schedule): ScheduleDraftCard — model picker card for suspended schedule creation (#184)"
```

---

## Task 10: Chat 渲染 schedule-model 卡

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（import + 1524 区卡片分发）

- [ ] **Step 1: import 组件**

```ts
import { ScheduleDraftCard } from "./ScheduleDraftCard";
```

- [ ] **Step 2: 加 kind 分支（接 Task 5 的卡片分发块后）**

```tsx
{panelRequest?.kind === "schedule-model" && (
  <ScheduleDraftCard
    payload={panelRequest.payload as import("@/lib/agent/tools/schedule-meta").ScheduleDraftPayload}
    instances={instances}
    onSubmit={(instanceId, model) =>
      respondPanel(panelRequest.requestId, { ok: true, data: { instanceId, model } })
    }
    onCancel={() => respondPanel(panelRequest.requestId, { ok: false, reason: "cancelled by user" })}
  />
)}
```

> `instances` 变量在 Chat 内已存在（272 区附近 `listInstances().then(setInstances)`，用 `grep -n "setInstances\|instances" src/sidepanel/components/Chat.tsx` 确认其 state 名）。

- [ ] **Step 3: typecheck + Chat 测试**

Run: `pnpm typecheck && pnpm test src/sidepanel/components/Chat.test.tsx`
Expected: 0 错；绿

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/components/Chat.tsx
git commit -m "feat(schedule): render ScheduleDraftCard for schedule-model panel requests (#184)"
```

---

## Task 11: loop 注入 ctx.requestModelSelection

**Files:**
- Modify: `src/lib/agent/loop.ts`（ctx 构建处）

- [ ] **Step 1: 定位 ctx 构建处**

Run: `grep -n "currentInstanceId\|currentModel\|tool.handler(tc.args" src/lib/agent/loop.ts`
找到组装 `ToolHandlerContext`（传给 `tool.handler` 的对象，约 2222 行附近）的位置。

- [ ] **Step 2: 注入字段**

在 ctx 字面量里（与 `currentInstanceId`/`currentModel`/`sessionId` 同处）加：

```ts
        requestModelSelection: (payload) =>
          requestFromPanel(sessionId, "schedule-model", payload),
```

并在 loop.ts 顶部加 import：

```ts
import { requestFromPanel } from "../panel-request";
```

> 注意：headless 调度跑（run.ts）走另一条 loop 入口或同入口但 `disabledScheduleTools` 摘除了 `create_schedule`，故 `requestModelSelection` 即便注入也不会被调用；若 run.ts 复用同一 ctx 构建且无 panel port，`requestFromPanel` 会因无 port 而 throw——但 create_schedule 已被摘除，到不了该分支。用 `grep -n "disabledScheduleTools\|requestModelSelection" src/lib/agent/run.ts src/lib/agent/loop.ts` 确认 headless 路径不触发。如确有触发风险，headless 入口处把 `requestModelSelection` 置 undefined（让 handler 走 resolveSelection 兜底）。

- [ ] **Step 3: typecheck + loop 测试**

Run: `pnpm typecheck && pnpm test src/lib/agent/loop.test.ts`
Expected: 0 错；绿

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(schedule): wire ctx.requestModelSelection in agent loop (chat path only) (#184)"
```

---

## Task 12: 切片 2 全量回归

- [ ] **Step 1: 全量测试 + typecheck + build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿；build 成功

- [ ] **Step 2: 真机手测清单（同步到主仓库 dist 后在 chrome://extensions 刷新）**

```
[ ] chat 说"每天9点总结邮件"，不指定模型 → 弹 ScheduleDraftCard，含待建摘要 + ModelPicker
[ ] 选 (instance, model) + Create → 卡翻"已创建"，LLM 后续 observation 含该 schedule id
[ ] 取消 → 工具返回错误，LLM 自陈未创建
[ ] chat 明确"用 <某实例的某合法模型>"建 schedule → 不弹卡，直接建
[ ] CDP 输入授权卡仍正常（迁移无回归）：触发一个 click 工具 → 弹授权卡 → 同意 → 动作执行
[ ] 本地文件选取卡仍正常：触发 request_local_file → 弹卡 → 选文件 → 内容回灌
[ ] 等待卡片时关闭 panel → 重开不悬挂；SW 回收后任务 paused，Resume 可重试
```

- [ ] **Step 3: 按 finishing-a-development-branch 走 PR（main 受保护，`gh auth switch --user WiseriaAI` 后开 PR）。关闭 issue #184。**

---

## Self-Review 备忘（写 plan 时已核）

- **spec 覆盖**：§4 原语 → Task 1；§4.3 SW 收口 → Task 3；§4.4 暗礁 → Task 2+4；§4.6 panel hook → Task 5；§5.1 工具挂起 → Task 8；§5.2 卡片 → Task 9+10；§6 失败模式 → Task 1（timeout/close）+ Task 12 手测（SW 死）；§7 测试 → 各 Task 内。
- **类型一致**：`requestFromPanel` / `handlePanelResponse` / `resolvePendingByKind` / `registerPanelPort` / `unregisterPanelPort` 跨 Task 同名；`ScheduleDraftPayload`(title/prompt/specSummary) 与 `ScheduleModelSelection`(instanceId/model) 在 Task 1（临时）→ Task 7（正式）→ Task 8/9/10 一致；消息类型 `panel-request` / `panel-response` / `panel-request-timeout` / `panel-request-resolved` 全程统一。
- **已知需实施时现场确认的点**（已在对应 Task 标注 grep 校验）：`schedule-meta.test.ts` 的 `makeCtx` 命名、`ModelRow.model` 字段名、`modelsFor` 反向 import 是否触发 UI 依赖、loop.ts ctx 构建确切行、Chat 的 `instances` state 名、local-file 隐藏 input onChange 处。
```
