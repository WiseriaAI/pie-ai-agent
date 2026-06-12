# Managed Provider 客户端接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 让 Pie 扩展用户在配置表单切到「官方订阅」即可用 Google 登录 → 订阅 → 自动获得可用 provider 配置，聊天直连 `https://api.pie.chat`，无需自带 API key；BYOK 完全不受影响。

**Architecture:** managed 作为底层一个 builtin provider（`provider:"managed"`，virtual key 存进现有加密 `StoredInstance`，聊天复用 OpenAI-compat 管线），但只通过配置表单顶部的【BYOK↔官方订阅】切换进入，不进 ProviderDropdown。429 错误按 `error.type` 区分「额度耗尽 vs 限流」并贯穿到 UI 的订阅 CTA。

**Tech Stack:** React 19 + TS + Vite + @crxjs · vitest（happy-dom）· 新模块用依赖注入（fetch/identity 可注入）以便单测。

**权威设计：** `docs/specs/2026-06-12-managed-provider-client-design.md`；后端契约：`pie-managed-backend/docs/contract.md`。

**关键约定（贯穿全程）：**
- 两个基址：`ACCOUNT_BASE="https://account.pie.chat"`（账号/订阅）、`GATEWAY_BASE="https://api.pie.chat"`（聊天网关）。
- managed instance 的 model 恒为 tier 别名 `"default"`（真实模型由后端决定，客户端无感）。
- 错误语义：`401`+`error.type:"auth_error"`=key 失效/被封；`429`+`error.type:"budget_exceeded"`=额度耗尽（非限流，无 402）；`429` 其它=限流。
- 每 provider 仅一个 config（`createInstance` 已强制，见 `instances.ts:53-59`）。
- 新增 UI 文案用内联英文（沿用 provider name/endpoint label「不做 i18n」的既有先例，见 `registry.ts`），避免触碰 i18n 构建不变量。

**模型选择建议（subagent-driven）：** Task 1–6（model-router 层 + 纯逻辑模块）多为机械实现，可用较廉价模型；Task 7–10（UI 组件 + 多文件 wire）用标准/较强模型；Task 11–12 收尾用标准模型。

---

### Task 1: 配置常量 `managed-config.ts`

**Files:**
- Create: `src/lib/managed-config.ts`
- Test: `src/lib/managed-config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/managed-config.test.ts
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE, GATEWAY_BASE } from "./managed-config";

describe("managed-config", () => {
  it("exposes the official account + gateway base URLs without trailing slash", () => {
    expect(ACCOUNT_BASE).toBe("https://account.pie.chat");
    expect(GATEWAY_BASE).toBe("https://api.pie.chat");
    expect(ACCOUNT_BASE.endsWith("/")).toBe(false);
    expect(GATEWAY_BASE.endsWith("/")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/lib/managed-config.ts
/** 官方托管服务基址。改 staging/prod 只改这一处。 */
export const ACCOUNT_BASE = "https://account.pie.chat";
export const GATEWAY_BASE = "https://api.pie.chat";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/managed-config.ts src/lib/managed-config.test.ts
git commit -m "feat(managed): add account/gateway base URL constants"
```

---

### Task 2: Provider 层 — 注册 managed + dispatch + wrapper

**Files:**
- Modify: `src/lib/model-router/index.ts:13-25`（`BuiltinProvider` union）
- Modify: `src/lib/model-router/providers/registry.ts:112`（`PROVIDER_REGISTRY` 追加条目）
- Modify: `src/lib/model-router/providers/index.ts:8,25-38`（import + dispatch map）
- Create: `src/lib/model-router/providers/managed.ts`
- Test: `src/lib/model-router/providers/managed.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/model-router/providers/managed.test.ts
import { describe, expect, it } from "vitest";
import { streamChatByProvider } from "./index";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";
import { getProviderMeta } from "./registry";

describe("managed provider registration", () => {
  it("dispatches managed through the OpenAI-compat core", () => {
    // managed 是纯 OpenAI 兼容直透，wrapper 仅转发到共享 core
    expect(typeof streamChatByProvider.managed).toBe("function");
  });

  it("registry has managed with a single 'default' tier alias and the gateway base", () => {
    const meta = getProviderMeta("managed");
    expect(meta).toBeDefined();
    expect(meta!.defaultBaseUrl).toBe("https://api.pie.chat");
    expect(meta!.models.map((m) => m.id)).toEqual(["default"]);
    expect(meta!.models[0]!.tools).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/providers/managed.test.ts`
Expected: FAIL（`streamChatByProvider.managed` undefined / `getProviderMeta("managed")` undefined / `"managed"` 不在 `BuiltinProvider`，TS 报错）

- [ ] **Step 3a: `BuiltinProvider` 加 `"managed"`**

`src/lib/model-router/index.ts` —— 在 union 末尾（`| "stepfun";` 之前/之后）加：

```ts
export type BuiltinProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini"
  | "deepseek"
  | "mimo"
  | "moonshot"
  | "moonshot-cn"
  | "stepfun"
  | "managed";
```

- [ ] **Step 3b: registry 追加 managed 条目**

`src/lib/model-router/providers/registry.ts` —— 在 `PROVIDER_REGISTRY` 数组末尾（`stepfun` 条目之后、闭合 `]` 之前）追加。`GATEWAY_BASE` 用字面量（registry 不引入 `managed-config` 以免循环；常量真值与 Task 1 一致）：

```ts
  {
    id: "managed",
    name: "Pie 官方订阅",
    // 网关基址 = GATEWAY_BASE（见 managed-config.ts）。聊天打 /v1/chat/completions。
    defaultBaseUrl: "https://api.pie.chat",
    placeholder: "", // managed 不手填 key（virtual key 由登录签发）
    // 单一 tier 别名：真实模型由后端 config.yaml 决定，客户端无感。
    // vision=false（当前 default tier 上游为文本模型）；contextTokens 取保守值。
    models: [
      { id: "default", vision: false, tools: true, maxContextTokens: 128_000 },
    ],
  },
```

- [ ] **Step 3c: 新建 wrapper `managed.ts`**（与 `zhipu.ts` 同构，纯直透）

```ts
// src/lib/model-router/providers/managed.ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

// 官方托管网关是标准 OpenAI 兼容端点（LiteLLM）。virtual key 走默认
// `Authorization: Bearer`，model 字段送 tier 别名 "default"，无需任何 hook。
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}
```

- [ ] **Step 3d: dispatch map 注册**

`src/lib/model-router/providers/index.ts` —— import 区加（在 `stepfun` import 后）：

```ts
import { streamChat as managedChat } from "./managed";
```

`streamChatByProvider` map 加一行（在 `stepfun: stepfunChat,` 后）：

```ts
  managed: managedChat,
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm test src/lib/model-router/providers/managed.test.ts`
Expected: PASS
Run: `pnpm build`（确认 `streamChatByProvider: Record<BuiltinProvider, ...>` 因新增成员仍完备，无 TS 缺键错误）
Expected: 构建通过

- [ ] **Step 5: 提交**

```bash
git add src/lib/model-router/index.ts src/lib/model-router/providers/registry.ts src/lib/model-router/providers/index.ts src/lib/model-router/providers/managed.ts src/lib/model-router/providers/managed.test.ts
git commit -m "feat(managed): register managed provider (default tier, gateway base, OpenAI-compat dispatch)"
```

---

### Task 3: 错误语义升级 — `kind` 字段 + 解析 `error.type`

**Files:**
- Modify: `src/lib/model-router/types.ts:52-65`（`StreamEvent` error 加 `kind`，导出 `ErrorKind`）
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.ts:153-170,299-302`（解析 body + 打标）
- Test: `src/lib/model-router/providers/_shared/openai-compat-core.error.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/model-router/providers/_shared/openai-compat-core.error.test.ts
import { describe, expect, it, vi } from "vitest";
import { streamChatOpenAICompat } from "./openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";

const cfg: ModelConfig = {
  provider: "managed", providerName: "Pie 官方订阅",
  model: "default", apiKey: "sk-virtual", baseUrl: "https://api.pie.chat",
};

function mockResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: false, status,
    text: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

async function firstEvent(resp: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => resp));
  const gen = streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }]);
  const { value } = await gen.next();
  vi.unstubAllGlobals();
  return value;
}

describe("openai-compat error.type → kind", () => {
  it("401 → kind:auth", async () => {
    expect(await firstEvent(mockResponse(401, '{"error":{"type":"auth_error"}}')))
      .toMatchObject({ type: "error", kind: "auth" });
  });
  it("429 + budget_exceeded → kind:budget", async () => {
    expect(await firstEvent(mockResponse(429, '{"error":{"type":"budget_exceeded"}}')))
      .toMatchObject({ type: "error", kind: "budget" });
  });
  it("429 plain → kind:ratelimit", async () => {
    expect(await firstEvent(mockResponse(429, '{"error":{"type":"rate_limit"}}', { "retry-after": "3" })))
      .toMatchObject({ type: "error", kind: "ratelimit" });
  });
  it("500 → kind:http", async () => {
    expect(await firstEvent(mockResponse(500, "boom")))
      .toMatchObject({ type: "error", kind: "http" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test openai-compat-core.error.test.ts`
Expected: FAIL（无 `kind` 字段）

- [ ] **Step 3a: types.ts 导出 `ErrorKind` 并扩展 error 事件**

`src/lib/model-router/types.ts` —— 在 `StreamEvent` 定义前加类型，并改 error 成员：

```ts
export type ErrorKind = "auth" | "budget" | "ratelimit" | "http" | "network";

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-start"; replay: boolean }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end"; signature?: string }
  | { type: "tool-call-start"; id: string; index: number; name: string }
  | { type: "tool-call-delta"; index: number; argsDelta: string }
  | { type: "tool-call-end"; index: number }
  | {
      type: "done";
      stopReason?: "end" | "tool_calls" | "length";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; error: string; kind?: ErrorKind };
```

并在 `index.ts` 的 re-export 行（`export type { StreamEvent, ... } from "./types";`）加上 `ErrorKind`：

```ts
export type { StreamEvent, ErrorKind, AgentMessage, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, ToolDefinition } from "./types";
```

- [ ] **Step 3b: openai-compat-core 解析 body + 打标**

`src/lib/model-router/providers/_shared/openai-compat-core.ts` —— 替换 `if (!response.ok) { ... }` 整块（行 159-170）：

```ts
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = displayProviderName(config);
    let errorType: string | undefined;
    try { errorType = JSON.parse(text)?.error?.type; } catch { /* 非 JSON body */ }
    if (response.status === 401) {
      yield { type: "error", error: `Invalid ${name} API key`, kind: "auth" };
    } else if (response.status === 429) {
      if (errorType === "budget_exceeded") {
        yield { type: "error", error: `${name}: quota exhausted — manage your subscription`, kind: "budget" };
      } else {
        const retryAfter = response.headers.get("retry-after");
        yield { type: "error", error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}`, kind: "ratelimit" };
      }
    } else {
      yield { type: "error", error: `${name} API error (${response.status}): ${text}`, kind: "http" };
    }
    return;
  }
```

并把网络错误分支（行 155）也打标 `kind:"network"`：

```ts
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${displayProviderName(config)} API`}`, kind: "network" };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test openai-compat-core.error.test.ts`
Expected: PASS
Run: `pnpm test src/lib/model-router`（确认未破坏既有 provider 测试）
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/model-router/types.ts src/lib/model-router/index.ts src/lib/model-router/providers/_shared/openai-compat-core.ts src/lib/model-router/providers/_shared/openai-compat-core.error.test.ts
git commit -m "feat(managed): tag stream errors with kind, parse error.type (budget_exceeded vs ratelimit)"
```

---

### Task 4: 把 `kind` 透传到 slot

**Files:**
- Modify: `src/types/messages.ts:132-137`（`ChatErrorMessage` 加 `kind`）
- Modify: `src/lib/agent/loop.ts:1600`（发送时带 `kind`）
- Modify: `src/sidepanel/hooks/useSession/runtime-map.ts:12-36`（slot 加 `errorKind`）+ `EMPTY_SLOT`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts:120-137`（patch `errorKind`）
- Test: `src/sidepanel/hooks/useSession/port-handlers.error-kind.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/sidepanel/hooks/useSession/port-handlers.error-kind.test.ts
import { describe, expect, it, vi } from "vitest";
import { createPortHandlers } from "./port-handlers";
import type { SessionRuntimeSlot } from "./runtime-map";

describe("chat-error carries kind into slot", () => {
  it("sets slot.errorKind from the wire message", () => {
    const slots = new Map<string, SessionRuntimeSlot>();
    const slotsRef = { current: slots };
    const { handleMessage } = createPortHandlers({
      slotsRef: slotsRef as never,
      setSlots: () => {},
      persistMessages: async () => {},
    });
    handleMessage({ type: "chat-error", error: "quota exhausted", kind: "budget", sessionId: "s1" } as never);
    expect(slotsRef.current.get("s1")).toMatchObject({ error: "quota exhausted", errorKind: "budget" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test port-handlers.error-kind.test.ts`
Expected: FAIL（`errorKind` 未设置 / 类型不含 `kind`）

- [ ] **Step 3a: messages.ts**

`src/types/messages.ts` —— `ChatErrorMessage` 加 `kind`（import `ErrorKind`）：

```ts
import type { ErrorKind } from "@/lib/model-router/types";

export interface ChatErrorMessage {
  type: "chat-error";
  error: string;
  /** 错误分类，用于 UI 分流（额度耗尽弹订阅 CTA 等）。仅 LLM-stream 错误带，本地错误省略。 */
  kind?: ErrorKind;
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
}
```

- [ ] **Step 3b: loop.ts 发送带 kind**

`src/lib/agent/loop.ts:1600` —— 该行改为透传 `event.kind`（`event` 此处即 StreamEvent error）：

```ts
          port.postMessage(withSession({ type: "chat-error", error: event.error, kind: event.kind }, sessionId));
```

（行 1685 的本地截断错误不带 kind，保持原样。）

- [ ] **Step 3c: runtime-map.ts slot 加字段**

`src/sidepanel/hooks/useSession/runtime-map.ts` —— `SessionRuntimeSlot` 在 `error` 后加：

```ts
  error: string | null;
  /** 最近一次 chat-error 的分类（见 ErrorKind）。null = 无/未分类。 */
  errorKind: import("@/lib/model-router/types").ErrorKind | null;
```

并在该文件的 `EMPTY_SLOT` 常量里补默认值 `errorKind: null,`（与 `error: null` 并列）。

- [ ] **Step 3d: port-handlers patch errorKind**

`src/sidepanel/hooks/useSession/port-handlers.ts` —— `chat-error` 分支的 `patchSlot(id, { ... })`（行 126-134）加 `errorKind`：

```ts
      patchSlot(id, {
        error: msg.error,
        errorKind: msg.kind ?? null,
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
```

> 同时检查：`chat-start` / 重试路径若有 `patchSlot({ error: null })` 处，一并加 `errorKind: null`，避免旧分类残留（搜 `error: null` 在 port-handlers 与 useSession 内的复位点）。

- [ ] **Step 4: 跑测试确认通过 + 构建**

Run: `pnpm test port-handlers.error-kind.test.ts`
Expected: PASS
Run: `pnpm build`
Expected: 通过（`EMPTY_SLOT` 补齐字段后 `SessionRuntimeSlot` 完备）

- [ ] **Step 5: 提交**

```bash
git add src/types/messages.ts src/lib/agent/loop.ts src/sidepanel/hooks/useSession/runtime-map.ts src/sidepanel/hooks/useSession/port-handlers.ts src/sidepanel/hooks/useSession/port-handlers.error-kind.test.ts
git commit -m "feat(managed): thread error kind through wire → slot.errorKind"
```

---

### Task 5: 登录模块 `managed-auth.ts`

**Files:**
- Create: `src/lib/managed-auth.ts`
- Test: `src/lib/managed-auth.test.ts`

依赖注入设计：`launchWebAuthFlow` / `getRedirectURL` / `fetchFn` 均可注入，测试不依赖 `chrome.identity`（setup.ts 未提供）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/managed-auth.test.ts
import { describe, expect, it, vi } from "vitest";
import { startManagedLogin } from "./managed-auth";

const redirectUri = "https://abc.chromiumapp.org/";
const deps = (over: Partial<Parameters<typeof startManagedLogin>[0]> = {}) => ({
  getRedirectURL: () => redirectUri,
  launchWebAuthFlow: vi.fn(async () => `${redirectUri}?code=AUTHCODE`),
  fetchFn: vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ apiKey: "sk-virtual", entitlement: { plan: "none", email: "u@x.com", budgetRemainingUsd: 0 } }),
  })) as unknown as typeof fetch,
  ...over,
});

describe("startManagedLogin", () => {
  it("exchanges the code and returns apiKey + entitlement", async () => {
    const d = deps();
    const res = await startManagedLogin(d);
    expect(d.launchWebAuthFlow).toHaveBeenCalledWith({
      url: `https://account.pie.chat/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
      interactive: true,
    });
    expect(d.fetchFn).toHaveBeenCalledWith("https://account.pie.chat/auth/exchange", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "AUTHCODE", redirectUri }),
    }));
    expect(res).toEqual({ apiKey: "sk-virtual", entitlement: { plan: "none", email: "u@x.com", budgetRemainingUsd: 0 } });
  });

  it("throws when the user cancels (no code in redirect)", async () => {
    await expect(startManagedLogin(deps({
      launchWebAuthFlow: vi.fn(async () => `${redirectUri}?error=access_denied`),
    }))).rejects.toThrow();
  });

  it("throws when exchange returns non-200", async () => {
    await expect(startManagedLogin(deps({
      fetchFn: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch,
    }))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-auth.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/lib/managed-auth.ts
import { ACCOUNT_BASE } from "./managed-config";

export interface Entitlement {
  plan: "none" | "active" | "blocked";
  email: string;
  budgetRemainingUsd: number;
}
export interface LoginResult {
  apiKey: string;
  entitlement: Entitlement;
}

export interface ManagedAuthDeps {
  /** 缺省走 chrome.identity.launchWebAuthFlow（MV3 返回 Promise<string> redirectURL）。 */
  launchWebAuthFlow?: (opts: { url: string; interactive: boolean }) => Promise<string>;
  /** 缺省走 chrome.identity.getRedirectURL()（https://<EXTENSION_ID>.chromiumapp.org/）。 */
  getRedirectURL?: () => string;
  fetchFn?: typeof fetch;
}

/**
 * Google 一键登录 → 兑换长效 virtual key。
 * redirect_uri 在 start 与 exchange 两处必须完全一致（含尾斜杠）。
 * 幂等：同一 Google 账号重复登录返回同一把 key（后端保证），中途放弃可安全重登。
 */
export async function startManagedLogin(deps: ManagedAuthDeps = {}): Promise<LoginResult> {
  const launch =
    deps.launchWebAuthFlow ??
    ((opts) => chrome.identity.launchWebAuthFlow(opts) as unknown as Promise<string>);
  const getRedirectURL = deps.getRedirectURL ?? (() => chrome.identity.getRedirectURL());
  const fetchFn = deps.fetchFn ?? fetch;

  const redirectUri = getRedirectURL();
  const authUrl = `${ACCOUNT_BASE}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const resultUrl = await launch({ url: authUrl, interactive: true });
  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) throw new Error("Login cancelled or not authorized");

  const resp = await fetchFn(`${ACCOUNT_BASE}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!resp.ok) throw new Error(`Login exchange failed (${resp.status})`);
  return (await resp.json()) as LoginResult;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-auth.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/managed-auth.ts src/lib/managed-auth.test.ts
git commit -m "feat(managed): Google OAuth login → virtual key exchange (managed-auth)"
```

---

### Task 6: 账号/订阅模块 `managed-account.ts`

**Files:**
- Create: `src/lib/managed-account.ts`
- Test: `src/lib/managed-account.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/managed-account.test.ts
import { describe, expect, it, vi } from "vitest";
import { getEntitlement, openCheckout, openPortal } from "./managed-account";

describe("managed-account", () => {
  it("getEntitlement GETs /me/entitlement with Bearer and parses", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ plan: "active", email: "u@x.com", budgetRemainingUsd: 5.5 }),
    })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/me/entitlement", {
      headers: { authorization: "Bearer sk-virtual" },
    });
    expect(res).toEqual({ plan: "active", email: "u@x.com", budgetRemainingUsd: 5.5 });
  });

  it("openCheckout POSTs /billing/checkout and opens the returned url", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: "https://checkout.test/x" }) })) as unknown as typeof fetch;
    const openTab = vi.fn();
    await openCheckout("sk-virtual", { fetchFn, openTab });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/billing/checkout", {
      method: "POST", headers: { authorization: "Bearer sk-virtual" },
    });
    expect(openTab).toHaveBeenCalledWith("https://checkout.test/x");
  });

  it("openPortal POSTs /billing/portal and opens the returned url", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: "https://portal.test/y" }) })) as unknown as typeof fetch;
    const openTab = vi.fn();
    await openPortal("sk-virtual", { fetchFn, openTab });
    expect(openTab).toHaveBeenCalledWith("https://portal.test/y");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/lib/managed-account.ts
import { ACCOUNT_BASE } from "./managed-config";
import type { Entitlement } from "./managed-auth";

export interface ManagedAccountDeps {
  fetchFn?: typeof fetch;
  /** 缺省走 chrome.tabs.create。 */
  openTab?: (url: string) => void;
}

export async function getEntitlement(apiKey: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resp = await fetchFn(`${ACCOUNT_BASE}/me/entitlement`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Failed to load entitlement (${resp.status})`);
  return (await resp.json()) as Entitlement;
}

async function openBilling(path: "/billing/checkout" | "/billing/portal", apiKey: string, deps: ManagedAccountDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const openTab = deps.openTab ?? ((url: string) => { chrome.tabs.create({ url }); });
  const resp = await fetchFn(`${ACCOUNT_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`${path} failed (${resp.status})`);
  const { url } = (await resp.json()) as { url: string };
  openTab(url);
}

export const openCheckout = (apiKey: string, deps: ManagedAccountDeps = {}) => openBilling("/billing/checkout", apiKey, deps);
export const openPortal = (apiKey: string, deps: ManagedAccountDeps = {}) => openBilling("/billing/portal", apiKey, deps);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): entitlement + checkout/portal helpers (managed-account)"
```

---

### Task 7: 创建流程组件 `ManagedSubscribePanel`

登录 → 展示 entitlement →（未订阅则）订阅 → active 后回调 `onCreated(apiKey, email)`。

**Files:**
- Create: `src/sidepanel/components/ManagedSubscribePanel.tsx`
- Test: `src/sidepanel/components/ManagedSubscribePanel.test.tsx`

- [ ] **Step 1: 写失败测试**（happy-dom，注入 deps）

```tsx
// src/sidepanel/components/ManagedSubscribePanel.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ManagedSubscribePanel from "./ManagedSubscribePanel";

describe("ManagedSubscribePanel", () => {
  it("already-active login creates the config immediately", async () => {
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel
      onCreated={onCreated}
      deps={{
        login: vi.fn(async () => ({ apiKey: "sk-v", entitlement: { plan: "active", email: "u@x.com", budgetRemainingUsd: 6 } })),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sk-v", "u@x.com"));
  });

  it("non-subscribed login shows a Subscribe button (does not create yet)", async () => {
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel
      onCreated={onCreated}
      deps={{
        login: vi.fn(async () => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", budgetRemainingUsd: 0 } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(onCreated).not.toHaveBeenCalled();
  });
});
```

> 注：若仓库未装 `@testing-library/react`，本任务 Step 1 先 `pnpm add -D @testing-library/react`（happy-dom 已在 vitest env）。检查 `package.json`，已装则跳过。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test ManagedSubscribePanel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// src/sidepanel/components/ManagedSubscribePanel.tsx
import { useState } from "react";
import { startManagedLogin, type LoginResult } from "@/lib/managed-auth";
import { getEntitlement, openCheckout } from "@/lib/managed-account";

export interface ManagedSubscribeDeps {
  login?: () => Promise<LoginResult>;
  refresh?: (apiKey: string) => Promise<LoginResult["entitlement"]>;
  checkout?: (apiKey: string) => Promise<void>;
}

interface Props {
  /** 订阅 active 后落 managed config。 */
  onCreated: (apiKey: string, email: string) => void;
  deps?: ManagedSubscribeDeps;
}

export default function ManagedSubscribePanel({ onCreated, deps }: Props) {
  const login = deps?.login ?? startManagedLogin;
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [session, setSession] = useState<LoginResult | null>(null);

  async function handleLogin() {
    setBusy(true); setErr(null);
    try {
      const res = await login();
      if (res.entitlement.plan === "active") { onCreated(res.apiKey, res.entitlement.email); return; }
      setSession(res);
    } catch (e) { setErr(e instanceof Error ? e.message : "Login failed"); }
    finally { setBusy(false); }
  }

  async function handleRefresh() {
    if (!session) return;
    setBusy(true); setErr(null);
    try {
      const ent = await refresh(session.apiKey);
      if (ent.plan === "active") { onCreated(session.apiKey, ent.email); return; }
      setSession({ ...session, entitlement: ent });
      setErr("Subscription not active yet — finish payment, then refresh.");
    } catch (e) { setErr(e instanceof Error ? e.message : "Refresh failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-3.5 text-[13px]">
      {!session ? (
        <>
          <p className="text-fg-2">Use the official Pie service — no API key needed.</p>
          <button
            type="button" disabled={busy} onClick={handleLogin}
            className="h-9 rounded-[10px] bg-fg-1 px-4 text-[12px] font-medium text-canvas disabled:opacity-40"
          >
            {busy ? "…" : "Sign in with Google"}
          </button>
        </>
      ) : (
        <>
          <div className="text-fg-1">Signed in as <span className="font-mono">{session.entitlement.email}</span></div>
          <div className="text-fg-3">Plan: {session.entitlement.plan}</div>
          <button
            type="button" disabled={busy} onClick={() => checkout(session.apiKey)}
            className="h-9 rounded-[10px] bg-accent px-4 text-[12px] font-medium text-canvas disabled:opacity-40"
          >
            Subscribe
          </button>
          <button
            type="button" disabled={busy} onClick={handleRefresh}
            className="h-8 rounded-[10px] border border-line px-4 text-[12px] text-fg-2 disabled:opacity-40"
          >
            I&apos;ve paid — refresh status
          </button>
        </>
      )}
      {err && <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test ManagedSubscribePanel.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ManagedSubscribePanel.tsx src/sidepanel/components/ManagedSubscribePanel.test.tsx package.json pnpm-lock.yaml
git commit -m "feat(managed): subscribe panel (login → subscribe → onCreated)"
```

---

### Task 8: NewConfigWizard 接入【BYOK↔官方订阅】切换 + 过滤 managed

**Files:**
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`
- Test: `src/sidepanel/components/NewConfigWizard.managed.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/NewConfigWizard.managed.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NewConfigWizard from "./NewConfigWizard";

// 仅验证「官方订阅」分支会用 managed 调 onCreate（BYOK 分支与切换 UI 存在）
describe("NewConfigWizard managed toggle", () => {
  it("renders a BYOK/Official toggle and creates a managed config via the subscribe panel", async () => {
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={() => {}} onTest={() => {}}
      __managedDeps={{ login: vi.fn(async () => ({ apiKey: "sk-v", entitlement: { plan: "active", email: "u@x.com", budgetRemainingUsd: 6 } })) }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /official subscription/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("managed", expect.objectContaining({ apiKey: "sk-v", nickname: "u@x.com" })));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test NewConfigWizard.managed.test.tsx`
Expected: FAIL

- [ ] **Step 3a: 加 mode state + 测试用 deps 透传**

`NewConfigWizard.tsx` —— Props 接口加可选 `__managedDeps?: import("./ManagedSubscribePanel").ManagedSubscribeDeps;`（测试注入用，生产不传）。组件顶部 state 区加：

```tsx
  const [entryMode, setEntryMode] = useState<"byok" | "managed">("byok");
```

import：`import ManagedSubscribePanel from "./ManagedSubscribePanel";`

- [ ] **Step 3b: 顶部渲染切换 + 分支**

在 `return (<div ...>` 内最上方（`<ProviderDropdown .../>` 之前）插入切换条，并把原有 BYOK 主体包进 `entryMode === "byok"` 条件，managed 分支渲染 `ManagedSubscribePanel`：

```tsx
      <div role="group" aria-label="Config type" className="flex w-full overflow-hidden rounded-[10px] border border-line">
        {([["byok", "Bring your own key"], ["managed", "Official subscription"]] as const).map(([m, label], i) => (
          <button key={m} type="button" aria-pressed={entryMode === m}
            onClick={() => setEntryMode(m)}
            className={`flex flex-1 items-center justify-center px-1.5 py-2 text-[12px] ${i > 0 ? "border-l border-line" : ""} ${
              entryMode === m ? "bg-accent-tint font-semibold text-accent" : "bg-transparent text-fg-3 hover:bg-field hover:text-fg-1"}`}>
            {label}
          </button>
        ))}
      </div>

      {entryMode === "managed" ? (
        <ManagedSubscribePanel
          deps={props.__managedDeps}
          onCreated={(apiKey, email) => props.onCreate("managed", { nickname: email, apiKey, customModels: [] })}
        />
      ) : (
        <>
          {/* —— 原有 BYOK 主体（ProviderDropdown + InstanceForm + 草稿逻辑）整体移到这里 —— */}
        </>
      )}
```

> 实现注意：把现有 `return` 里 `<ProviderDropdown.../>` 到 `<InstanceForm.../>`（含 custom 草稿块）整段移入 `entryMode === "byok"` 的 `<>...</>`，不改其内部逻辑。

- [ ] **Step 3c: 从 BYOK 下拉过滤掉 managed**

定位 `sortedProviders`（传给 `ProviderDropdown` 的 `builtinProviders`，由 `PROVIDER_REGISTRY` 派生）。在其派生处加过滤：

```ts
// 派生 sortedProviders 时排除 managed —— 它只通过顶部「官方订阅」切换进入，不进 BYOK 下拉。
.filter((p) => p.id !== "managed")
```

- [ ] **Step 4: 跑测试 + 构建**

Run: `pnpm test NewConfigWizard.managed.test.tsx`
Expected: PASS
Run: `pnpm build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/NewConfigWizard.tsx src/sidepanel/components/NewConfigWizard.managed.test.tsx
git commit -m "feat(managed): BYOK/Official toggle in config wizard; exclude managed from BYOK dropdown"
```

---

### Task 9: `ManagedAccountPanel` + InstanceForm managed 分支

managed instance 的编辑视图：显示 entitlement + 管理/续订；隐藏 key 输入、model 列表、endpoint 切换。

**Files:**
- Create: `src/sidepanel/components/ManagedAccountPanel.tsx`
- Modify: `src/sidepanel/components/InstanceForm.tsx`
- Test: `src/sidepanel/components/ManagedAccountPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/ManagedAccountPanel.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ManagedAccountPanel from "./ManagedAccountPanel";

describe("ManagedAccountPanel", () => {
  it("shows plan + budget and a Manage button for active subscriptions", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedAccountPanel apiKey="sk-v" deps={{
      refresh: vi.fn(async () => ({ plan: "active", email: "u@x.com", budgetRemainingUsd: 4.2 })),
      portal,
    }} />);
    await screen.findByText(/active/i);
    expect(screen.getByText(/u@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /manage subscription/i }));
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test ManagedAccountPanel.test.tsx`
Expected: FAIL

- [ ] **Step 3a: 实现 ManagedAccountPanel**

```tsx
// src/sidepanel/components/ManagedAccountPanel.tsx
import { useEffect, useState } from "react";
import { getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";

export interface ManagedAccountDeps {
  refresh?: (apiKey: string) => Promise<Entitlement>;
  checkout?: (apiKey: string) => Promise<void>;
  portal?: (apiKey: string) => Promise<void>;
}

export default function ManagedAccountPanel({ apiKey, deps }: { apiKey: string; deps?: ManagedAccountDeps }) {
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));

  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try { setEnt(await refresh(apiKey)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [apiKey]);

  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5 text-[13px]">
      {ent ? (
        <>
          <div className="text-fg-1"><span className="font-mono">{ent.email}</span></div>
          <div className="text-fg-3">Plan: <span className="text-fg-1">{ent.plan}</span> · Remaining: ${ent.budgetRemainingUsd.toFixed(2)}</div>
          {ent.plan === "active" ? (
            <button type="button" onClick={() => portal(apiKey)}
              className="h-9 rounded-[10px] border border-line px-4 text-[12px] text-fg-1 hover:border-fg-3">Manage subscription</button>
          ) : (
            <button type="button" onClick={() => checkout(apiKey)}
              className="h-9 rounded-[10px] bg-accent px-4 text-[12px] font-medium text-canvas">{ent.plan === "blocked" ? "Renew subscription" : "Subscribe"}</button>
          )}
          <button type="button" onClick={load} className="h-7 text-[11px] text-fg-3 hover:text-fg-1">Refresh</button>
        </>
      ) : (
        <div className="text-fg-3">Loading…</div>
      )}
      {err && <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 3b: InstanceForm managed 分支**

`src/sidepanel/components/InstanceForm.tsx` —— 在组件 return 顶部（计算出 `meta` 后、渲染主体前）加早返回分支。managed 编辑态用 `props.existingApiKey` 作为 virtual key 喂给面板：

```tsx
import ManagedAccountPanel from "./ManagedAccountPanel";
// ...
  if (props.provider === "managed") {
    return (
      <div className="flex flex-col gap-3">
        {props.existingApiKey
          ? <ManagedAccountPanel apiKey={props.existingApiKey} />
          : <div className="text-[12px] text-fg-3">Sign in from the “Official subscription” tab to set this up.</div>}
        {props.renderActions?.({
          canSave: false, replacing: false, testing: false, testStatus: "idle",
          saveLabel: props.saveLabel ?? "Save",
          triggerSave: () => {}, triggerTest: () => {}, triggerDelete: props.onDelete,
        })}
      </div>
    );
  }
```

> 这样 managed instance 在 Settings 里编辑时不显示 key 输入 / model 列表 / endpoint 切换；只显示订阅状态 + 删除（退出登录）。`renderActions` 仍渲染外层操作区（保留删除按钮）。

- [ ] **Step 4: 跑测试 + 构建**

Run: `pnpm test ManagedAccountPanel.test.tsx`
Expected: PASS
Run: `pnpm build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ManagedAccountPanel.tsx src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/ManagedAccountPanel.test.tsx
git commit -m "feat(managed): account panel + InstanceForm managed branch (entitlement, portal/checkout)"
```

---

### Task 10: 聊天错误 CTA — `budget`/`auth` 分流

当 `slot.errorKind` 为 `budget`/`auth` 且活动 instance 是 managed 时，错误气泡下显示订阅/重登 CTA。

**Files:**
- Create: `src/sidepanel/components/ManagedErrorCta.tsx`
- Modify: `src/sidepanel/components/Chat.tsx:1280-1284`（错误气泡处）+ 取 `errorKind`
- Test: `src/sidepanel/components/ManagedErrorCta.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/ManagedErrorCta.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ManagedErrorCta from "./ManagedErrorCta";

describe("ManagedErrorCta", () => {
  it("budget kind → Manage subscription opens portal with the managed key", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedErrorCta kind="budget" deps={{ getManagedKey: async () => "sk-v", portal }} />);
    const btn = await screen.findByRole("button", { name: /manage subscription/i });
    fireEvent.click(btn);
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("renders nothing when there is no managed instance", async () => {
    const { container } = render(<ManagedErrorCta kind="budget" deps={{ getManagedKey: async () => null, portal: vi.fn() }} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test ManagedErrorCta.test.tsx`
Expected: FAIL

- [ ] **Step 3a: 实现 ManagedErrorCta**

读活动 managed instance 的 key（`listInstances` 找 `provider==="managed"`）。提供 DI 以便测试。

```tsx
// src/sidepanel/components/ManagedErrorCta.tsx
import { useEffect, useState } from "react";
import type { ErrorKind } from "@/lib/model-router/types";
import { listInstances } from "@/lib/instances";
import { openPortal } from "@/lib/managed-account";

export interface ManagedErrorCtaDeps {
  getManagedKey?: () => Promise<string | null>;
  portal?: (apiKey: string) => Promise<void>;
}

async function defaultGetManagedKey(): Promise<string | null> {
  const insts = await listInstances();
  return insts.find((i) => i.provider === "managed")?.apiKey ?? null;
}

export default function ManagedErrorCta({ kind, deps }: { kind: ErrorKind | null; deps?: ManagedErrorCtaDeps }) {
  const getManagedKey = deps?.getManagedKey ?? defaultGetManagedKey;
  const portal = deps?.portal ?? ((k: string) => openPortal(k));
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (kind === "budget" || kind === "auth") void getManagedKey().then((k) => { if (live) setKey(k); });
    else setKey(null);
    return () => { live = false; };
  }, [kind, getManagedKey]);

  if (!key || (kind !== "budget" && kind !== "auth")) return null;
  if (kind === "auth") {
    return <div className="mt-1.5 text-[12px] text-fg-3">Your session expired — sign in again from Settings → Configs.</div>;
  }
  return (
    <button type="button" onClick={() => portal(key)}
      className="mt-1.5 h-8 rounded-[10px] bg-accent px-3 text-[12px] font-medium text-canvas">
      Manage subscription
    </button>
  );
}
```

- [ ] **Step 3b: Chat.tsx 接线**

`Chat.tsx` —— 在解构 `session` 处补取 `errorKind`（行 166 附近，与 `error,` 并列）：

```tsx
    error,
    errorKind,
```

错误气泡（行 1280-1284）改为附带 CTA：

```tsx
            {error && (
              <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">
                {error}
                <ManagedErrorCta kind={errorKind} />
              </div>
            )}
```

import：`import ManagedErrorCta from "./ManagedErrorCta";`

> 若 `useSession` 暴露的 session 对象未透出 `errorKind`，在 `useSession` 的返回映射处补 `errorKind: slot.errorKind`（与 `error: slot.error` 并列；搜 `error: slot.error` 或 `error,` 在 useSession 聚合处）。

- [ ] **Step 4: 跑测试 + 构建**

Run: `pnpm test ManagedErrorCta.test.tsx`
Expected: PASS
Run: `pnpm build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ManagedErrorCta.tsx src/sidepanel/components/Chat.tsx src/sidepanel/hooks/useSession/*.ts src/sidepanel/components/ManagedErrorCta.test.tsx
git commit -m "feat(managed): chat error CTA for budget_exceeded/auth (manage subscription / re-login)"
```

---

### Task 11: manifest — identity 权限 + host_permissions

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: 加 identity 权限**

`manifest.json` `permissions` 数组加 `"identity"`：

```json
  "permissions": ["activeTab", "sidePanel", "storage", "tabs", "tabGroups", "scripting", "debugger", "webNavigation", "offscreen", "downloads", "identity"],
```

- [ ] **Step 2: 加 host_permissions**

`host_permissions` 数组加两条（放在 `<all_urls>` 之后即可）：

```json
    "https://account.pie.chat/*",
    "https://api.pie.chat/*",
```

- [ ] **Step 3: 构建确认 manifest 合法**

Run: `pnpm build`
Expected: 构建通过（@crxjs 校验 manifest 无误）

- [ ] **Step 4: 提交**

```bash
git add manifest.json
git commit -m "feat(managed): manifest identity permission + pie.chat host permissions"
```

---

### Task 12: 全量验证 + 收尾

**Files:** 无新增（仅验证）

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: 全绿（含全部新增测试 + 既有测试无回归）

- [ ] **Step 2: 生产构建**

Run: `pnpm build`
Expected: 通过（构建期不变量 `tool-names.ts`/`tools.ts` 不 throw；manifest 合法）

- [ ] **Step 3: 自查清单（人工/最终 reviewer）**
  - `BuiltinProvider` 完备性：`streamChatByProvider` 含 `managed`，无 TS 缺键。
  - managed 不在 BYOK ProviderDropdown 列表（Task 8 过滤生效）。
  - managed instance 的 model 恒为 `"default"`（`firstModelForProvider` 取 registry[0]）。
  - 错误链路：`budget_exceeded` → `kind:"budget"` → slot → Chat CTA。
  - 无残留占位/TODO；新文案为内联英文（未误触 i18n locale 文件）。

- [ ] **Step 4: 联调前置提醒（写入 PR 描述，不阻塞代码合并）**

真机联调依赖后端补真值（见 spec §配套补步）：account 真 `GOOGLE_CLIENT_ID/SECRET` + Google Console 登记 `https://<EXTENSION_ID>.chromiumapp.org/`；Stripe webhook secret；litellm 公网 + `DEEPSEEK_API_KEY`。代码与单测先行不受影响。

- [ ] **Step 5: 收尾**

按 superpowers:finishing-a-development-branch 收束分支（合并/PR），随后进入真机联调。

---

## 自审（writing-plans Self-Review）

- **Spec 覆盖**：provider 层(T2)、登录(T5)、账号/订阅(T6,T9)、错误语义(T3,T4,T10)、配置表单切换(T7,T8)、manifest(T11)、测试(各任务 TDD + T12)、配套补步(T12.S4) —— spec 各节均有对应任务。
- **占位扫描**：无 TBD/“add error handling”等；每个改动给了真实代码或精确锚点+插入码。少数「整段移入条件分支」「在 useSession 聚合处补字段」是结构性指引，已标注确切搜索锚点。
- **类型一致**：`ErrorKind` 在 `model-router/types` 定义并被 `messages.ts`/`runtime-map.ts`/`Chat.tsx` 一致引用；`startManagedLogin`/`LoginResult`/`Entitlement` 在 T5 定义、T6/T7/T9 复用；`onCreate("managed", {nickname,apiKey,customModels})` 与 `createInstance` 入参一致。
- **依赖顺序**：T1→T2/T3→T4→T5/T6→T7→T8→T9→T10→T11→T12，前置产物均在引用前定义。
