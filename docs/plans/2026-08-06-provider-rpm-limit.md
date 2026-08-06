# Provider RPM 限流 + 模型列表行卡化 — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** instance 可配 RPM 上限，聊天全链路主动限流排队（侧栏黄铜色倒计时指示）；顺带把设置页模型列表改为行卡样式。

**Architecture:** 60s 内存滑动窗口限流器挂在 `streamChat`（四条 LLM 请求路径唯一收口），等待时经新 `StreamEvent` variant → loop 转发新 port 消息 → panel slot 状态 → `WorkingIndicator` 等待变体。配置沿 `StoredInstance → resolveModelConfig → ModelConfig` 既有链路透传。

**Tech Stack:** TypeScript 6 / React 19 / vitest（fake timers）/ TailwindCSS v4 主题 token。

**Spec:** `docs/specs/2026-08-06-provider-rpm-limit.md`（决策与 UI 均已确认）

## Global Constraints

- i18n 全 6 门字典 parity（en / zh-CN / zh-TW / ja / es-419 / pt-BR），插值占位符格式 `{seconds}`（参照既有 `{stepCount}`）。
- `provider-test.ts`（直调 `dispatchStreamChat`）不限流，不改。
- managed provider（`provider === "managed"`）表单分支不渲染 RPM 字段。
- 不做服务端 429 重试；`ErrorKind` 不动。
- git：在 `feat/provider-rpm-limit` 分支工作；**只 `git add` 点名文件**（工作区有常驻 untracked 草稿，禁 `git add -A`）；commit message 带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer。
- 提交前门禁：`pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。

---

### Task 0: 分支

- [ ] **Step 1: 建分支**

```bash
cd /Users/wenkang/repos/pie/pie-ai-agent
git checkout -b feat/provider-rpm-limit
```

- [ ] **Step 2: 提交 spec + plan**

```bash
git add docs/specs/2026-08-06-provider-rpm-limit.md docs/plans/2026-08-06-provider-rpm-limit.md
git commit -m "docs: RPM 限流 + 模型列表行卡化 spec/plan"
```

---

### Task 1: rate-limiter 模块

**Files:**
- Create: `src/lib/model-router/rate-limiter.ts`
- Test: `src/lib/model-router/rate-limiter.test.ts`
- Modify: `docs/specs/2026-08-06-provider-rpm-limit.md`（§4.1 末行「可注入时钟」改为「测试用 `vi.useFakeTimers()`（仓库既有模式，见 keep-alive.concurrent.test.ts）」）

**Interfaces:**
- Produces: `peekWait(key: string, limit: number): number | null`（满窗返回 resumeAt epoch ms，否则 null；纯读不记账）；`acquire(key: string, limit: number, signal?: AbortSignal): Promise<void>`（记账或排队；abort 抛 `AbortError` 且不记账）；`_resetForTests(): void`。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/model-router/rate-limiter.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { peekWait, acquire, _resetForTests } from "./rate-limiter";

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});
afterEach(() => vi.useRealTimers());

describe("rate-limiter", () => {
  it("未满窗直通：limit 内的 acquire 立即 resolve，peekWait 为 null", async () => {
    expect(peekWait("k", 2)).toBeNull();
    await acquire("k", 2);
    expect(peekWait("k", 2)).toBeNull();
    await acquire("k", 2);
    expect(peekWait("k", 2)).not.toBeNull(); // 第 3 条会等
  });

  it("满窗排队：60s 后窗口滚动放行", async () => {
    await acquire("k", 1);
    const resumeAt = peekWait("k", 1);
    expect(resumeAt).toBe(Date.now() + 60_000);
    let resolved = false;
    const p = acquire("k", 1).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await p;
    expect(resolved).toBe(true);
  });

  it("多 waiter 按窗口空位逐个放行", async () => {
    await acquire("k", 1); // t=0 占位
    const order: number[] = [];
    const p1 = acquire("k", 1).then(() => order.push(1));
    const p2 = acquire("k", 1).then(() => order.push(2));
    await vi.advanceTimersByTimeAsync(60_100); // t=0 过期 → 放行一个
    expect(order.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_100); // 再过 60s → 放行第二个
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("abort 打断等待：抛 AbortError 且不记账", async () => {
    await acquire("k", 1);
    const ac = new AbortController();
    const p = acquire("k", 1, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // 不记账：窗口滚动后 peekWait 立即变 null（只有最初 1 条）
    await vi.advanceTimersByTimeAsync(60_100);
    expect(peekWait("k", 1)).toBeNull();
  });

  it("已 abort 的 signal → 立即拒绝", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquire("k", 5, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("不同 key 互不影响", async () => {
    await acquire("a", 1);
    expect(peekWait("a", 1)).not.toBeNull();
    expect(peekWait("b", 1)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/rate-limiter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/lib/model-router/rate-limiter.ts
/**
 * Per-instance RPM 滑动窗口限流器。挂在 streamChat（见 index.ts），
 * key = instanceId（RPM 限额绑 API key，instance 即 key 维度）。
 * ponytail: 纯内存窗口，SW 重启计数清零 —— 最坏窗口内多发几条；
 * 若未来要跨重启精确，升级为 IDB 持久化时间戳。
 */
const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

function prune(key: string, now: number): number[] {
  const arr = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  windows.set(key, arr);
  return arr;
}

/** 满窗返回预计恢复时刻（epoch ms），未满返回 null。纯读，不记账。 */
export function peekWait(key: string, limit: number): number | null {
  const arr = prune(key, Date.now());
  return arr.length < limit ? null : arr[0]! + WINDOW_MS;
}

/** 窗口有空位则记账立即返回；满则 sleep 到最早一条过期后重查（while 竞争）。 */
export async function acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const now = Date.now();
    const arr = prune(key, now);
    if (arr.length < limit) {
      arr.push(now);
      return;
    }
    await sleep(arr[0]! + WINDOW_MS - now, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(ms, 0));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function _resetForTests(): void {
  windows.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/model-router/rate-limiter.test.ts`
Expected: PASS（6 用例全绿）

- [ ] **Step 5: 改 spec 时钟行 + commit**

```bash
git add src/lib/model-router/rate-limiter.ts src/lib/model-router/rate-limiter.test.ts docs/specs/2026-08-06-provider-rpm-limit.md
git commit -m "feat(model-router): RPM 滑动窗口限流器（peekWait/acquire）"
```

---

### Task 2: StreamEvent variant + ModelConfig 字段 + streamChat 挂载

**Files:**
- Modify: `src/lib/model-router/types.ts`（StreamEvent union，~line 55）
- Modify: `src/lib/model-router/index.ts`（ModelConfig ~line 33；streamChat ~line 104）
- Test: `src/lib/model-router/rpm-gate.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `peekWait` / `acquire` / `_resetForTests`。
- Produces: `StreamEvent` 新 variant `{ type: "ratelimit-wait"; resumeAt: number }`；`ModelConfig` 新可选字段 `rpmLimit?: number; rateKey?: string`。Task 3 靠 `resolveModelConfig` 填这两个字段；Task 4 的 loop 消费 `ratelimit-wait` 事件。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/model-router/rpm-gate.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { streamChat, type ModelConfig } from ".";
import type { StreamEvent } from "./types";
import { _resetForTests } from "./rate-limiter";

// mock dispatch 层：每次调用产出一个 text-delta + done
vi.mock("./providers", () => ({
  dispatchStreamChat: vi.fn(() =>
    async function* () {
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", stopReason: "end" };
    },
  ),
}));
// streamChat 前置的 resolveProviderMeta 需要 registry 正常工作（openai 是 builtin）
const config = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  provider: "openai",
  model: "gpt-4o",
  apiKey: "sk-test",
  ...over,
});

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});
afterEach(() => vi.useRealTimers());

describe("streamChat RPM gate", () => {
  it("无 rpmLimit → 直通，不产 ratelimit-wait", async () => {
    const events = await collect(streamChat(config(), [{ role: "user", content: "hi" }]));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });

  it("rpmLimit=1 连发两条 → 第二条先产 ratelimit-wait 再流式", async () => {
    const cfg = config({ rpmLimit: 1, rateKey: "inst-1" });
    await collect(streamChat(cfg, [{ role: "user", content: "a" }]));
    const events: StreamEvent[] = [];
    const gen = streamChat(cfg, [{ role: "user", content: "b" }]);
    const done = (async () => { for await (const e of gen) events.push(e); })();
    await vi.advanceTimersByTimeAsync(0);
    expect(events[0]).toMatchObject({ type: "ratelimit-wait" });
    expect((events[0] as { resumeAt: number }).resumeAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(60_100);
    await done;
    expect(events.map((e) => e.type)).toEqual(["ratelimit-wait", "text-delta", "done"]);
  });

  it("等待中 abort → generator 静默终止（不 throw、不发请求）", async () => {
    const cfg = config({ rpmLimit: 1, rateKey: "inst-2" });
    await collect(streamChat(cfg, [{ role: "user", content: "a" }]));
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    const done = (async () => {
      for await (const e of streamChat(cfg, [{ role: "user", content: "b" }], ac.signal)) events.push(e);
    })();
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await done; // 不应 reject
    expect(events.map((e) => e.type)).toEqual(["ratelimit-wait"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/rpm-gate.test.ts`
Expected: FAIL（`ratelimit-wait` 类型不存在 / gate 未实现）

- [ ] **Step 3: 实现**

`src/lib/model-router/types.ts` — StreamEvent union（`| { type: "done"; ... }` 之前）加：

```ts
  | { type: "ratelimit-wait"; resumeAt: number }
```

`src/lib/model-router/index.ts` — ModelConfig 加字段（`vision?: boolean` 之后）：

```ts
  /** 用户自设的每分钟请求上限（instance 维度）。undefined = 不限。 */
  rpmLimit?: number;
  /** 限流计数 key，resolveModelConfig 填 instanceId；缺省回落 apiKey。 */
  rateKey?: string;
```

`streamChat` 在 `yield* dispatchStreamChat(...)` 之前插入（import `peekWait, acquire` from `./rate-limiter`）：

```ts
  if (config.rpmLimit && config.rpmLimit > 0) {
    const key = config.rateKey ?? config.apiKey;
    const resumeAt = peekWait(key, config.rpmLimit);
    if (resumeAt !== null) yield { type: "ratelimit-wait", resumeAt };
    try {
      await acquire(key, config.rpmLimit, signal);
    } catch {
      return; // 等待中被 abort —— 静默终止，loop 走既有 abort 收尾
    }
  }
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm test src/lib/model-router/rpm-gate.test.ts && pnpm typecheck`
Expected: 测试 PASS；typecheck 0 错（若 `chat()` / `compact-react-window.ts` 等消费方有穷举 switch 报错，给它们补 no-op 忽略分支——预期都是 if/else 链，应无报错）

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/types.ts src/lib/model-router/index.ts src/lib/model-router/rpm-gate.test.ts
git commit -m "feat(model-router): streamChat RPM gate + ratelimit-wait 事件"
```

---

### Task 3: instances 持久化 + resolveModelConfig 透传

**Files:**
- Modify: `src/lib/instances.ts`（StoredInstance ~line 13；createInstance input ~line 48；updateInstance patch ~line 280；resolveModelConfig ~line 191）
- Test: `src/lib/instances.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `ModelConfig.rpmLimit` / `rateKey`。
- Produces: `StoredInstance.rpmLimit?: number`；`createInstance` input 接受 `rpmLimit?: number`；`updateInstance` patch 接受 `rpmLimit: number | null`（null/0 = 清除，参照 endpointVariant 模式）；`resolveModelConfig` 返回值带 `rpmLimit`（有值时）与 `rateKey`（恒 = instanceId）。Task 6 的表单靠这三个入口。

- [ ] **Step 1: 写失败测试（追加到 instances.test.ts 末尾）**

```ts
describe("rpmLimit（RPM 限流配置）", () => {
  it("createInstance 带 rpmLimit → resolveModelConfig 透出 rpmLimit + rateKey", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k", rpmLimit: 30 });
    const cfg = await resolveModelConfig(id, "claude-sonnet-4-5");
    expect(cfg?.rpmLimit).toBe(30);
    expect(cfg?.rateKey).toBe(id);
  });

  it("未配 rpmLimit → config 无 rpmLimit 字段，rateKey 仍在", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "claude-sonnet-4-5");
    expect(cfg?.rpmLimit).toBeUndefined();
    expect(cfg?.rateKey).toBe(id);
  });

  it("updateInstance 设置与清除（null）", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    await updateInstance(id, { rpmLimit: 10 });
    expect((await getInstance(id))?.rpmLimit).toBe(10);
    await updateInstance(id, { rpmLimit: null });
    expect((await getInstance(id))?.rpmLimit).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/instances.test.ts`
Expected: 新增 3 用例 FAIL（类型/字段不存在）

- [ ] **Step 3: 实现**

`StoredInstance` 加（`maxTokens?: number` 之后）：

```ts
  /** 每分钟请求上限（RPM）。undefined = 不限。计数在 streamChat 层按 instanceId 滑动窗口。 */
  rpmLimit?: number;
```

`createInstance` input 类型加 `rpmLimit?: number;`，构造 StoredInstance 时加 `...(input.rpmLimit != null && input.rpmLimit > 0 && { rpmLimit: input.rpmLimit }),`。

`updateInstance` patch 类型加 `rpmLimit: number | null;`，处理逻辑（参照 endpointVariant 分支）：

```ts
  if (patch.rpmLimit !== undefined) {
    // null / 0 / 负数 = 显式清除（不限流）；正整数 = 设置。可选字段不留空值。
    if (!patch.rpmLimit || patch.rpmLimit <= 0) delete next.rpmLimit;
    else next.rpmLimit = Math.floor(patch.rpmLimit);
  }
```

`resolveModelConfig` 返回对象加两行（与 `maxTokens` 的展开写法并排）：

```ts
    ...(inst.rpmLimit != null && { rpmLimit: inst.rpmLimit }),
    rateKey: instanceId,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/instances.test.ts`
Expected: PASS（全文件，含既有用例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(instances): StoredInstance.rpmLimit 持久化 + resolveModelConfig 透传"
```

---

### Task 4: port 消息类型 + loop 转发

**Files:**
- Modify: `src/types/messages.ts`（ChatErrorMessage 附近加接口；PortMessageToPanel union ~line 604）
- Modify: `src/lib/agent/loop.ts`（streamChat 事件消费链 ~line 2088，`event.type === "error"` 分支之前）
- Test: `src/lib/agent/loop.emit.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `ratelimit-wait` StreamEvent。
- Produces: `ChatRatelimitWaitMessage { type: "chat-ratelimit-wait"; resumeAt: number; sessionId: string }`，已并入 `PortMessageToPanel`。Task 5 的 port-handlers 消费它。

- [ ] **Step 1: 写失败测试（追加到 loop.emit.test.ts）**

```ts
describe("ratelimit-wait 转发（RPM 限流）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streamChat 产 ratelimit-wait → loop emit chat-ratelimit-wait（带 sessionId/resumeAt）", async () => {
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");
    vi.mocked(streamChat).mockImplementation(async function* () {
      yield { type: "ratelimit-wait", resumeAt: 1234567 } as const;
      yield { type: "text-delta", text: "Hello" } as const;
      yield { type: "done", stopReason: "end" } as const;
    });
    const emitted: Array<{ type: string; resumeAt?: number; sessionId?: string }> = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg as (typeof emitted)[number]); };
    const controller = new AbortController();
    await runAgentLoop({
      emit,
      task: "t",
      modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "sk", vision: false },
      signal: controller.signal,
      sessionId: "s-rl",
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
    });
    const rl = emitted.find((m) => m.type === "chat-ratelimit-wait");
    expect(rl).toBeDefined();
    expect(rl!.resumeAt).toBe(1234567);
    expect(rl!.sessionId).toBe("s-rl");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/loop.emit.test.ts`
Expected: 新用例 FAIL（消息未 emit）

- [ ] **Step 3: 实现**

`src/types/messages.ts`（ChatErrorMessage 之后）：

```ts
/** SW → Panel：streamChat 撞到用户自设 RPM 上限，正在排队等待。panel 显示
 *  黄铜色倒计时（WorkingIndicator 等待变体），收到任一真实进展消息即清除。 */
export interface ChatRatelimitWaitMessage {
  type: "chat-ratelimit-wait";
  /** 预计恢复时刻（epoch ms）。waiter 竞争下实际可能更晚，panel 钳 ≥0 显示。 */
  resumeAt: number;
  sessionId: string;
}
```

union `PortMessageToPanel`（~line 604）加一行 `| ChatRatelimitWaitMessage`。

`src/lib/agent/loop.ts` 事件消费链（`else if (event.type === "error")` 之前）加：

```ts
        } else if (event.type === "ratelimit-wait") {
          emit(withSession({ type: "chat-ratelimit-wait", resumeAt: event.resumeAt }, sessionId));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/loop.emit.test.ts && pnpm typecheck`
Expected: PASS；typecheck 0 错

- [ ] **Step 5: Commit**

```bash
git add src/types/messages.ts src/lib/agent/loop.ts src/lib/agent/loop.emit.test.ts
git commit -m "feat(agent): loop 转发 ratelimit-wait → chat-ratelimit-wait port 消息"
```

---

### Task 5: panel slot 状态 + WorkingIndicator 等待变体 + chat i18n

**Files:**
- Modify: `src/sidepanel/hooks/useSession/runtime-map.ts`（SessionRuntimeSlot + 默认值）
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`（新增 handler + 各真实进展消息清除）
- Modify: `src/sidepanel/components/Chat.tsx`（WorkingIndicator ~line 1812 + 调用点 ~line 1190）
- Modify: 6 门字典 `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,ja,es-419,pt-BR}.ts`（chat 段）
- Test: `src/sidepanel/hooks/useSession/port-handlers.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 4 的 `ChatRatelimitWaitMessage`。
- Produces: `SessionRuntimeSlot.ratelimitResumeAt: number | null`（默认 null）；i18n key `chat.ratelimitWait`（`{seconds}` 插值）。

- [ ] **Step 1: 写失败测试（追加到 port-handlers.test.ts，沿用该文件既有 deps/slot 构造 helper）**

```ts
describe("chat-ratelimit-wait（RPM 限流等待）", () => {
  it("设置 ratelimitResumeAt", () => {
    const { handlers, slotsRef } = setup(); // 沿用文件内既有 setup helper 命名
    handlers.handleMessage({ type: "chat-ratelimit-wait", resumeAt: 999, sessionId: "s1" });
    expect(slotsRef.current.get("s1")?.ratelimitResumeAt).toBe(999);
  });

  it("chat-chunk / thinking-chunk / agent-step / chat-error / chat-done 均清除", () => {
    const { handlers, slotsRef } = setup();
    const clearers = [
      { type: "chat-chunk", text: "x", sessionId: "s1" },
      { type: "thinking-chunk", text: "x", sessionId: "s1" },
      { type: "chat-done", sessionId: "s1" },
      { type: "chat-error", error: "e", sessionId: "s1" },
    ] as const;
    for (const msg of clearers) {
      handlers.handleMessage({ type: "chat-ratelimit-wait", resumeAt: 999, sessionId: "s1" });
      handlers.handleMessage(msg as Parameters<typeof handlers.handleMessage>[0]);
      expect(slotsRef.current.get("s1")?.ratelimitResumeAt).toBeNull();
    }
  });
});
```

（注：`setup` 为示意名——按 port-handlers.test.ts 现有构造方式改写，保持文件内一致。若该文件无共享 helper，则内联构造 `createPortHandlers` 所需的 `slotsRef`/`setSlots`/`persistMessages` stub。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现 slot + handlers**

`runtime-map.ts`：`SessionRuntimeSlot` 加 `ratelimitResumeAt: number | null;`，默认值对象加 `ratelimitResumeAt: null,`。

`port-handlers.ts`：
- 新 handler：`if (msg.type === "chat-ratelimit-wait") { patchSlot(msg.sessionId, { ratelimitResumeAt: msg.resumeAt }); return; }`
- 在 `chat-chunk` / `thinking-chunk` / `chat-done` / `chat-error` / `agent-step` / `agent-done-task` 各自的 patchSlot patch 里并入 `ratelimitResumeAt: null`。

- [ ] **Step 4: 实现 WorkingIndicator 等待变体**

`Chat.tsx` 调用点（~line 1190）改为：

```tsx
            {streaming && !panelRequest && (
              <WorkingIndicator
                thinking={!!streamingThinking && !streamingText}
                ratelimitResumeAt={ratelimitResumeAt}
              />
            )}
```

（`ratelimitResumeAt` 从当前 session slot 取——与 `streamingThinking` 同源解构。）

`WorkingIndicator`（~line 1812）改为：

```tsx
function WorkingIndicator({ thinking, ratelimitResumeAt }: { thinking: boolean; ratelimitResumeAt?: number | null }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ratelimitResumeAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ratelimitResumeAt]);
  if (ratelimitResumeAt != null) {
    const seconds = Math.max(0, Math.ceil((ratelimitResumeAt - now) / 1000));
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t("chat.agentWorking")}
        className="flex items-center gap-2 px-1 py-0.5"
      >
        <PieFace state="thinking" size={22} />
        <span className="caps tabular text-pending">{t("chat.ratelimitWait", { seconds })}</span>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("chat.agentWorking")}
      className="flex items-center gap-2 px-1 py-0.5"
    >
      <PieFace state={thinking ? "thinking" : "working"} size={22} />
      <span className="caps text-fg-3">
        {thinking ? t("chat.thinking") : t("chat.working")}
      </span>
    </div>
  );
}
```

- [ ] **Step 5: 字典（6 门全加，chat 段 `thinking:` 键旁）**

| 字典 | `ratelimitWait` |
|---|---|
| en | `"Rate limited · {seconds}s"` |
| zh-CN | `"限流等待 · {seconds} 秒"` |
| zh-TW | `"限流等待 · {seconds} 秒"` |
| ja | `"レート制限待機 · {seconds} 秒"` |
| es-419 | `"Límite de tasa · {seconds} s"` |
| pt-BR | `"Limite de taxa · {seconds} s"` |

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts && pnpm test src/lib/i18n && pnpm typecheck`
Expected: PASS（含 i18n parity 测试）

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/hooks/useSession/runtime-map.ts src/sidepanel/hooks/useSession/port-handlers.ts src/sidepanel/hooks/useSession/port-handlers.test.ts src/sidepanel/components/Chat.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts src/lib/i18n/dictionaries/zh-TW.ts src/lib/i18n/dictionaries/ja.ts src/lib/i18n/dictionaries/es-419.ts src/lib/i18n/dictionaries/pt-BR.ts
git commit -m "feat(panel): 限流等待指示（黄铜倒计时）+ chat.ratelimitWait i18n"
```

---

### Task 6: InstanceForm RPM 字段 + 宿主透传 + form i18n

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`（payload ~line 12；props ~line 33；表单字段插在 API Key Field 与「模型」FieldDiv 之间 ~line 246）
- Modify: `src/sidepanel/components/settings/pages/ModelsPage.tsx`（`handleSaveEdit` ~line 83；`<InstanceForm mode="edit">` props ~line 219）
- Modify: 6 门字典（instanceForm 段）
- Test: `src/sidepanel/components/InstanceForm.test.tsx`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 `createInstance({ rpmLimit })` / `updateInstance(id, { rpmLimit: number | null })` / `StoredInstance.rpmLimit`。
- Produces: `InstanceFormPayload.rpmLimit?: number`；props `initialRpmLimit?: number`。NewConfigWizard 无需改动（payload 经 `onCreate → handleCreate → createInstance({provider, ...payload})` 自动透传）。

- [ ] **Step 1: 写失败测试（追加到 InstanceForm.test.tsx，沿用该文件既有 render helper 与 i18n wrapper）**

```tsx
describe("rpmLimit 字段", () => {
  it("输入 30 → onSave payload.rpmLimit=30", async () => {
    const onSave = vi.fn();
    renderForm({ mode: "create", provider: "anthropic", onSave }); // 沿用文件内既有 render helper
    await userEvent.type(screen.getByLabelText(/每分钟请求上限|Requests per minute/i), "30");
    await userEvent.type(screen.getByLabelText(/API Key/i), "sk-x");
    await userEvent.click(screen.getByRole("button", { name: /保存|Save/i }));
    expect(onSave.mock.calls[0][0].rpmLimit).toBe(30);
  });

  it("留空 / 非法输入 → payload.rpmLimit undefined", async () => {
    const onSave = vi.fn();
    renderForm({ mode: "create", provider: "anthropic", onSave });
    await userEvent.type(screen.getByLabelText(/每分钟请求上限|Requests per minute/i), "abc");
    await userEvent.type(screen.getByLabelText(/API Key/i), "sk-x");
    await userEvent.click(screen.getByRole("button", { name: /保存|Save/i }));
    expect(onSave.mock.calls[0][0].rpmLimit).toBeUndefined();
  });

  it("edit 模式 initialRpmLimit 回显", () => {
    renderForm({ mode: "edit", provider: "anthropic", initialRpmLimit: 15, existingApiKey: "sk-old" });
    expect(screen.getByDisplayValue("15")).toBeInTheDocument();
  });
});
```

（`renderForm` 为示意名——按 InstanceForm.test.tsx 现有构造改写；断言选择器按实际 label/aria 调整，保持文件内风格。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

`InstanceFormPayload` 加 `rpmLimit?: number;`；Props 加 `initialRpmLimit?: number;`。

组件内（`endpointVariant` state 旁）：

```tsx
  const [rpmText, setRpmText] = useState(props.initialRpmLimit != null ? String(props.initialRpmLimit) : "");
  const parsedRpm = (() => {
    const n = parseInt(rpmText.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
```

payload 构造（~line 125）改为：

```tsx
  const payload: InstanceFormPayload = { nickname: props.initialNickname, apiKey, customModels, endpointVariant, rpmLimit: parsedRpm };
```

字段 JSX（API Key `</Field>` 之后、「模型」FieldDiv 之前）：

```tsx
      <Field label={t("instanceForm.rpmLimit")} hint="RPM">
        <div className="flex flex-col gap-1.5">
          <input
            aria-label={t("instanceForm.rpmLimit")}
            type="text"
            inputMode="numeric"
            value={rpmText}
            onChange={(e) => setRpmText(e.target.value)}
            placeholder={t("instanceForm.rpmLimitPlaceholder")}
            className="min-w-0 rounded-[10px] bg-field border border-line focus:border-accent-line px-3 py-2.5 text-[13px] text-fg-1"
          />
          <div className="text-[11px] leading-relaxed text-fg-3">{t("instanceForm.rpmLimitDesc")}</div>
        </div>
      </Field>
```

`ModelsPage.tsx`：
- `<InstanceForm mode="edit">` props 加 `initialRpmLimit={inst.rpmLimit}`。
- `handleSaveEdit` 的 patch 类型与构造加 `rpmLimit: payload.rpmLimit ?? null,`（与 endpointVariant 同款「undefined → null 显式清除」语义）。

- [ ] **Step 4: 字典（6 门，instanceForm 段）**

| key | en | zh-CN | zh-TW | ja | es-419 | pt-BR |
|---|---|---|---|---|---|---|
| `rpmLimit` | Requests per minute limit | 每分钟请求上限 | 每分鐘請求上限 | 毎分リクエスト上限 | Límite de solicitudes por minuto | Limite de solicitações por minuto |
| `rpmLimitPlaceholder` | Unlimited | 不限 | 不限 | 無制限 | Sin límite | Sem limite |
| `rpmLimitDesc` | Match your provider's rate limit; leave empty for no limit. When the limit is reached, new requests queue and wait instead of failing. | 按服务商限额填写，留空则不限制。达到上限时新请求自动排队等待，不会报错中断。 | 依服務商限額填寫，留空則不限制。達到上限時新請求自動排隊等待，不會報錯中斷。 | プロバイダーの制限に合わせて設定してください。空欄の場合は制限なし。上限到達時は新しいリクエストが自動的に順番待ちになり、エラーにはなりません。 | Configura según el límite de tu proveedor; déjalo vacío para no limitar. Al alcanzar el límite, las solicitudes nuevas esperan en cola en lugar de fallar. | Configure conforme o limite do seu provedor; deixe vazio para não limitar. Ao atingir o limite, novas solicitações aguardam na fila em vez de falhar. |

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx && pnpm test src/lib/i18n && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstanceForm.test.tsx src/sidepanel/components/settings/pages/ModelsPage.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts src/lib/i18n/dictionaries/zh-TW.ts src/lib/i18n/dictionaries/ja.ts src/lib/i18n/dictionaries/es-419.ts src/lib/i18n/dictionaries/pt-BR.ts
git commit -m "feat(settings): instance RPM 上限配置字段"
```

---

### Task 7: ProviderModelList 行卡化

**Files:**
- Modify: `src/sidepanel/components/ProviderModelList.tsx`（纯样式，行为与 props 不变）
- Test: `src/sidepanel/components/ProviderModelList.test.tsx`（既有用例应保持绿；class 断言如有则更新）

**Interfaces:** 无——对外 props 不变。

- [ ] **Step 1: 重写渲染样式（对照 spec §6 表）**

外层容器 `<div className="flex flex-col overflow-hidden rounded-[10px] bg-field">` → `<div className="flex flex-col gap-1.5">`。

懒加载刷新条（保持信息与位置，去容器化）：

```tsx
        <div className="flex items-center justify-between px-1 text-[10px] text-fg-3">
```

（内部 span/button 不变，去掉 `border-b border-line`。）

builtin 行：

```tsx
        <div key={m.id} className="flex items-center gap-1.5 rounded-[10px] border border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2">{m.id}</span>
          {m.vision && <Chip>{t("modelDropdown.vision")}</Chip>}
          {m.tools && <Chip>{t("modelDropdown.tools")}</Chip>}
        </div>
```

「自定义」分组头：

```tsx
        <div className="px-0.5 pt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-fg-3">
          {t("modelDropdown.custom")}
        </div>
```

custom 行：外层 `className="flex items-center gap-1.5 rounded-[10px] border border-line px-3 py-2"`，内部 span/图标不变（`text-fg-1` 保持）。

添加按钮：

```tsx
        <button
          onClick={() => setEditing({})}
          className="flex items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-line px-3 py-2 text-[11px] text-accent hover:border-accent-line"
        >
          {t("modelDropdown.addCustomModel")}
        </button>
```

Chip 组件：

```tsx
function Chip({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-[4px] border border-line px-[5px] py-px font-mono text-[9px] text-fg-3">{children}</span>;
}
```

`ModelMetaEditor` 挂载处不动（如原先依赖容器背景，视觉上允许它自然跟随新布局）。

- [ ] **Step 2: 跑既有测试**

Run: `pnpm test src/sidepanel/components/ProviderModelList.test.tsx`
Expected: PASS（若有 class 字符串断言失败，更新断言为新 class——只许改样式断言，行为断言失败=实现错了）

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/ProviderModelList.tsx src/sidepanel/components/ProviderModelList.test.tsx
git commit -m "style(settings): 模型列表行卡化（独立描边行 + 方角标签 + 虚线添加行）"
```

---

### Task 8: 全量验证

- [ ] **Step 1: 三门禁**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿。任一失败先修再继续（勿跳过）。

- [ ] **Step 2: Commit（如有修正）并推分支**

```bash
git push -u origin feat/provider-rpm-limit
```

---

### Task 9: 真机验收（按 spec §8 清单）

主目录已在 `feat/provider-rpm-limit` 分支，`pnpm build` 后让用户在 `chrome://extensions` 刷新扩展。逐项验：

- [ ] instance 配 RPM=2，连续发 3 个任务 → 第 3 个请求起出现黄铜「限流等待 · N 秒」倒计时，窗口空出自动继续，无报错
- [ ] 等待中点停止 → 立即中断，无悬挂
- [ ] RPM=1 观察 title 生成与首轮串行（同窗口计数）
- [ ] 留空 RPM → 行为与现状一致
- [ ] 设置页模型列表行卡新样式；custom 模型编辑/删除/添加、懒加载刷新正常
- [ ] 全部通过后：走 PR（`gh auth switch --user WiseriaAI` → `gh pr create`），合入 main

---

## Self-Review 记录

- Spec 覆盖：§3→Task 3/6，§4→Task 1/2，§5→Task 4/5，§6→Task 7，§7 分散在各 task 测试步，§8→Task 9。spec §4.1「可注入时钟」一行在 Task 1 Step 5 修正为 fake timers（仓库既有模式）。
- 类型一致性：`peekWait/acquire`（T1）→ T2 消费；`rpmLimit/rateKey`（T2 定义）→ T3 填充；`ratelimit-wait`（T2）→ T4 转发；`chat-ratelimit-wait`（T4）→ T5 消费；`InstanceFormPayload.rpmLimit`（T6）→ T3 的 create/update 入口。命名全程一致。
- 测试代码中 `setup`/`renderForm` 为示意名并已标注「沿用文件既有 helper」——实现者需按目标文件现状对齐，不是占位符。
