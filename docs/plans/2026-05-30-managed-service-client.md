# Managed Service Tier — 客户端实施 Plan（pie-ai-agent）

> ⚠️ **已作废（2026-06-11）**：后端方案已从 Supabase 自建改为 LiteLLM + Hono 胶水服务；认证由 JWT/refresh 改为长效 LiteLLM virtual key，错误码无 402（额度耗尽为 429 + `error.type:"budget_exceeded"`）。本 plan 的契约假设已过时，勿据此实施。现行设计见工作区根 `docs/brainstorming/2026-06-11-managed-provider-litellm-design.md`，对客户端契约见 `pie-managed-backend/docs/contract.md`。客户端接入 plan 待据新契约重写。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 BYOK 之外，给 Pie 客户端接入"官方托管"provider：用户用 OAuth 登录领免费额度、零 API key 跑 agent，不暴露真实模型名（只露"思考强度"档位）。

**Architecture:** 复用现有 instance/provider 抽象——新增 builtin provider `managed`，instance 的 `apiKey` 存后端签发的 JWT、`model` 字段存 `tier_id`（服务端把请求体 `model` 当 tier 解析成真实模型）。新增 `managed-auth` 模块负责 OAuth 登录 + JWT 静默刷新；`managed.ts` provider wrapper 在 401 时刷新重试一次。UI 在 `provider === "managed"` 时把 model 下拉替换为 `TierSelector`（只显示 `display_name`），并隐藏 API key 输入。

**Tech Stack:** React 19 + TS 6、`chrome.identity.launchWebAuthFlow`、`chrome.storage.local`、vitest + happy-dom + @testing-library/react。

**关联 spec:** `docs/specs/2026-05-30-managed-service-tier.md`（§5 客户端接入 / §7 思考强度档位）。

**前置依赖:** 服务端 `/v1/chat`、`/auth/exchange`、`/auth/refresh`、`/me/entitlement` 协议（见 backend plan）。本 plan 用 mock 覆盖这些端点，不依赖后端先上线。

---

## 协议契约（与 backend plan 共享的接口，必须一致）

客户端只通过这些 HTTP 契约耦合服务端：

- `POST {BASE}/v1/chat/completions` — OpenAI-compat 流式。请求头 `Authorization: Bearer <JWT>`，请求体 `model` = `tier_id`。错误码：401(JWT 失效)/402(额度不足)/403(无权用该 tier)/429(限流)。
- `POST {BASE}/auth/exchange` — body `{ code, redirectUri }` → `{ jwt, refreshToken, expiresAt, entitlement }`。
- `POST {BASE}/auth/refresh` — body `{ refreshToken }` → `{ jwt, refreshToken, expiresAt }`。
- `GET {BASE}/me/entitlement` — header `Authorization: Bearer <JWT>` → `{ plan: "free"|"paid", tiers: { tierId, displayName }[] }`。

`{BASE}` = `https://<project>.supabase.co/functions/v1`（registry 里硬编码为 `managed` 的 `defaultBaseUrl`）。

---

## File Structure

**新建：**
- `src/lib/model-router/providers/managed.ts` — managed provider wrapper（401 刷新重试）
- `src/lib/managed-auth.ts` — JWT/refresh token 存储、OAuth 登录、静默刷新、登出、entitlement 缓存
- `src/sidepanel/components/TierSelector.tsx` — 思考强度选择器（替代 managed 的 ModelDropdown）
- `src/sidepanel/components/ManagedLoginCard.tsx` — "用官方服务（免 key）"登录入口卡片
- `src/sidepanel/components/QuotaExhaustedCard.tsx` — 402 额度用尽卡片
- 各自就近的 `*.test.ts(x)`

**修改：**
- `src/lib/model-router/index.ts` — `BuiltinProvider` 加 `"managed"`；`StreamEvent` 的 error variant 加可选 `status?: number`（在 `types.ts`）
- `src/lib/model-router/types.ts` — error StreamEvent 加 `status?: number`
- `src/lib/model-router/providers/_shared/openai-compat-core.ts` — 非 200 分支把 `response.status` 带进 error event
- `src/lib/model-router/providers/registry.ts` — `PROVIDER_REGISTRY` 加 `managed` entry
- `src/lib/model-router/providers/index.ts` — dispatch 表加 `managed`
- `src/lib/instances.ts` — `resolveInstanceToModelConfig` 对 managed 做 task-start 静默刷新
- `src/sidepanel/components/InstanceForm.tsx` — `provider === "managed"` 时渲染 `TierSelector`、隐藏 apiKey
- `src/sidepanel/components/Settings.tsx` — 挂 `ManagedLoginCard` 入口
- `src/sidepanel/components/Chat.tsx`（或 useSession 错误处理处）— 挂 `QuotaExhaustedCard`，区分 402/403
- `manifest.json` — `host_permissions` 加 Supabase Functions 域名；确认 `identity` permission

---

## Task 1: error StreamEvent 带 status

**Files:**
- Modify: `src/lib/model-router/types.ts`（error variant）
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.ts:159-170`
- Test: `src/lib/model-router/providers/_shared/__tests__/openai-compat-status.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
// openai-compat-status.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamChatOpenAICompat } from "../openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";

const cfg: ModelConfig = { provider: "managed", model: "default", apiKey: "jwt", baseUrl: "https://x.test/functions/v1" };

beforeEach(() => vi.restoreAllMocks());

it("attaches HTTP status to error events on non-200", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ error: "insufficient_credits" }), { status: 402 })));
  const events = [];
  for await (const e of streamChatOpenAICompat(cfg, [{ role: "user", content: "hi" }])) events.push(e);
  const err = events.find((e) => e.type === "error");
  expect(err).toBeDefined();
  expect(err.status).toBe(402);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test openai-compat-status`
Expected: FAIL — `err.status` is `undefined`。

- [ ] **Step 3: 改 types.ts，给 error variant 加 status**

在 `src/lib/model-router/types.ts` 的 `StreamEvent` error 成员加可选字段：

```typescript
// before: | { type: "error"; error: string }
| { type: "error"; error: string; status?: number }
```

- [ ] **Step 4: 改 core 非 200 分支带上 status**

`openai-compat-core.ts` L159-169，给每个 `yield { type:"error", ... }` 加 `status: response.status`：

```typescript
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = displayProviderName(config);
    const status = response.status;
    if (status === 401) yield { type: "error", error: `Invalid ${name} API key`, status };
    else if (status === 429) {
      const retryAfter = response.headers.get("retry-after");
      yield { type: "error", error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}`, status };
    } else {
      yield { type: "error", error: `${name} API error (${status}): ${text}`, status };
    }
    return;
  }
```

- [ ] **Step 5: 跑测试确认 PASS + 全量回归**

Run: `pnpm test openai-compat-status && pnpm test`
Expected: PASS，且未破坏既有 provider 测试（status 是可选字段，向后兼容）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/types.ts src/lib/model-router/providers/_shared/openai-compat-core.ts src/lib/model-router/providers/_shared/__tests__/openai-compat-status.test.ts
git commit -m "feat(model-router): surface HTTP status on error stream events"
```

---

## Task 2: 注册 managed provider（registry + type + dispatch + manifest）

**Files:**
- Modify: `src/lib/model-router/index.ts:13-22`（BuiltinProvider）
- Modify: `src/lib/model-router/providers/registry.ts`（PROVIDER_REGISTRY 末尾）
- Modify: `src/lib/model-router/providers/index.ts`（import + dispatch）
- Create: `src/lib/model-router/providers/managed.ts`（先放最简 wrapper，Task 4 加刷新）
- Modify: `manifest.json`（host_permissions + identity）
- Test: `src/lib/model-router/providers/__tests__/managed-dispatch.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
// managed-dispatch.test.ts
import { describe, it, expect } from "vitest";
import { dispatchStreamChat } from "@/lib/model-router/providers";
import { getProviderMeta } from "@/lib/model-router/providers/registry";
import { streamChat as managedChat } from "@/lib/model-router/providers/managed";

it("registry exposes managed with fixed Supabase baseUrl and two tiers", () => {
  const meta = getProviderMeta("managed");
  expect(meta).toBeDefined();
  expect(meta!.defaultBaseUrl).toMatch(/\/functions\/v1$/);
  expect(meta!.models.map((m) => m.id)).toEqual(["default", "advanced"]);
});

it("dispatch routes managed to the managed wrapper", () => {
  const fn = dispatchStreamChat({ provider: "managed", model: "default", apiKey: "jwt" });
  expect(fn).toBe(managedChat);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test managed-dispatch`
Expected: FAIL — `managed` 不在 registry、`managed.ts` 不存在。

- [ ] **Step 3: BuiltinProvider 加 managed**

`src/lib/model-router/index.ts` L13-22：

```typescript
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
  | "managed";
```

- [ ] **Step 4: registry 加 managed entry**

`registry.ts` 的 `PROVIDER_REGISTRY` 数组末尾追加。`models[]` 用 tier 作为 ModelMeta（`id` = tier_id、`displayName` = 思考强度名，给 UI 兜底用；真实可用 tier 以服务端 entitlement 为准）：

```typescript
  {
    id: "managed",
    name: "Pie 官方服务",
    // ⚠️ 上线前替换为真实 Supabase project ref
    defaultBaseUrl: "https://YOUR_PROJECT_REF.supabase.co/functions/v1",
    placeholder: "（登录后自动填充）",
    models: [
      { id: "default", displayName: "标准", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "advanced", displayName: "深度", vision: true, tools: true, maxContextTokens: 1_000_000 },
    ],
  },
```

- [ ] **Step 5: 建最简 managed.ts wrapper**

`src/lib/model-router/providers/managed.ts`（Task 4 会加刷新重试；这里先直通，注入 JWT auth 头）：

```typescript
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools, {
    authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
  });
}
```

- [ ] **Step 6: dispatch 表注册**

`providers/index.ts`：import + 加进 `streamChatByProvider`：

```typescript
import { streamChat as managedChat } from "./managed";
// ...
export const streamChatByProvider: Record<BuiltinProvider, StreamChatFn> = {
  // ...既有 9 个...
  managed: managedChat,
};
```

- [ ] **Step 7: manifest host_permission + identity**

`manifest.json`：`host_permissions` 加 `"https://*.supabase.co/*"`；确认 `permissions` 含 `"identity"`（OAuth 需要）。

- [ ] **Step 8: 跑测试 + build invariant**

Run: `pnpm test managed-dispatch && pnpm test && pnpm build`
Expected: PASS；build 通过（`streamChatByProvider` 的 `Record<BuiltinProvider, ...>` 现在覆盖 `managed`，类型完整）。

- [ ] **Step 9: Commit**

```bash
git add src/lib/model-router manifest.json
git commit -m "feat(provider): register managed provider (fixed Supabase baseUrl, default/advanced tiers)"
```

---

## Task 3: managed-auth 模块（存储 + 登录 + 刷新 + entitlement）

**Files:**
- Create: `src/lib/managed-auth.ts`
- Test: `src/lib/managed-auth.test.ts`

存储键约定：`managed_auth`（`{ jwt, refreshToken, expiresAt }`）、`managed_entitlement`（`{ plan, tiers }`）。

- [ ] **Step 1: 写失败测试（刷新逻辑 + 过期判定）**

```typescript
// managed-auth.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { saveAuth, getStoredAuth, isExpiringSoon, getValidJwt, fetchEntitlement } from "./managed-auth";

beforeEach(() => { chromeMock.storage.local.__store = {}; vi.restoreAllMocks(); });

it("isExpiringSoon true within 5min of expiry", () => {
  const soon = Date.now() + 60_000;
  expect(isExpiringSoon(soon)).toBe(true);
  const later = Date.now() + 30 * 60_000;
  expect(isExpiringSoon(later)).toBe(false);
});

it("getValidJwt refreshes when expiring and persists new tokens", async () => {
  await saveAuth({ jwt: "old", refreshToken: "r1", expiresAt: Date.now() + 1000 });
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ jwt: "new", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const jwt = await getValidJwt();

  expect(jwt).toBe("new");
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/refresh$/), expect.objectContaining({ method: "POST" }));
  expect((await getStoredAuth())!.refreshToken).toBe("r2");
});

it("getValidJwt returns existing jwt when not expiring", async () => {
  await saveAuth({ jwt: "fresh", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await getValidJwt()).toBe("fresh");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("fetchEntitlement caches plan + tiers", async () => {
  await saveAuth({ jwt: "fresh", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ plan: "free", tiers: [{ tierId: "default", displayName: "标准" }] }), { status: 200 })));
  const ent = await fetchEntitlement();
  expect(ent.plan).toBe("free");
  expect(ent.tiers).toEqual([{ tierId: "default", displayName: "标准" }]);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test managed-auth`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 managed-auth.ts**

```typescript
import { getProviderMeta } from "@/lib/model-router/providers/registry";

const AUTH_KEY = "managed_auth";
const ENT_KEY = "managed_entitlement";
const REFRESH_SKEW_MS = 5 * 60_000; // 提前 5 分钟刷新

export interface StoredAuth { jwt: string; refreshToken: string; expiresAt: number; }
export interface Entitlement { plan: "free" | "paid"; tiers: { tierId: string; displayName: string }[]; }

function base(): string {
  return getProviderMeta("managed")!.defaultBaseUrl;
}

export async function saveAuth(a: StoredAuth): Promise<void> {
  await chrome.storage.local.set({ [AUTH_KEY]: a });
}
export async function getStoredAuth(): Promise<StoredAuth | null> {
  const r = await chrome.storage.local.get(AUTH_KEY);
  return (r[AUTH_KEY] as StoredAuth) ?? null;
}
export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove([AUTH_KEY, ENT_KEY]);
}

export function isExpiringSoon(expiresAt: number): boolean {
  return expiresAt - Date.now() <= REFRESH_SKEW_MS;
}

/** 用 refresh token 换新 JWT，落盘并返回新 JWT。 */
export async function refreshJwt(): Promise<string> {
  const cur = await getStoredAuth();
  if (!cur) throw new Error("managed: not logged in");
  const res = await fetch(`${base()}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: cur.refreshToken }),
  });
  if (!res.ok) throw new Error(`managed refresh failed: ${res.status}`);
  const data = await res.json() as Omit<StoredAuth, never>;
  const next: StoredAuth = { jwt: data.jwt, refreshToken: data.refreshToken, expiresAt: data.expiresAt };
  await saveAuth(next);
  return next.jwt;
}

/** 返回一个有效 JWT：临近过期则先刷新。 */
export async function getValidJwt(): Promise<string> {
  const cur = await getStoredAuth();
  if (!cur) throw new Error("managed: not logged in");
  if (isExpiringSoon(cur.expiresAt)) return refreshJwt();
  return cur.jwt;
}

export async function fetchEntitlement(): Promise<Entitlement> {
  const jwt = await getValidJwt();
  const res = await fetch(`${base()}/me/entitlement`, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new Error(`managed entitlement failed: ${res.status}`);
  const ent = await res.json() as Entitlement;
  await chrome.storage.local.set({ [ENT_KEY]: ent });
  return ent;
}
export async function getCachedEntitlement(): Promise<Entitlement | null> {
  const r = await chrome.storage.local.get(ENT_KEY);
  return (r[ENT_KEY] as Entitlement) ?? null;
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test managed-auth`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/managed-auth.ts src/lib/managed-auth.test.ts
git commit -m "feat(managed-auth): JWT storage, silent refresh, entitlement fetch"
```

---

## Task 4: OAuth 登录 flow（launchWebAuthFlow → exchange）

**Files:**
- Modify: `src/lib/managed-auth.ts`（加 `loginWithOAuth` / `logout`）
- Test: `src/lib/managed-auth.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```typescript
it("loginWithOAuth exchanges code and persists auth + entitlement", async () => {
  // chrome.identity.launchWebAuthFlow 返回带 ?code= 的 redirect URL
  chromeMock.identity = {
    getRedirectURL: vi.fn(() => "https://abc.chromiumapp.org/"),
    launchWebAuthFlow: vi.fn(async () => "https://abc.chromiumapp.org/?code=AUTHCODE"),
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/exchange"))
      return new Response(JSON.stringify({
        jwt: "j", refreshToken: "r", expiresAt: Date.now() + 3_600_000,
        entitlement: { plan: "free", tiers: [{ tierId: "default", displayName: "标准" }] },
      }), { status: 200 });
    throw new Error("unexpected " + url);
  });
  vi.stubGlobal("fetch", fetchMock);

  const ent = await loginWithOAuth();

  expect((await getStoredAuth())!.jwt).toBe("j");
  expect(ent.plan).toBe("free");
  expect(chromeMock.identity.launchWebAuthFlow).toHaveBeenCalledWith(
    expect.objectContaining({ interactive: true }), expect.anything?.() ?? expect.anything());
});
```

> 注：`launchWebAuthFlow` 在 MV3 支持 Promise 形式（省略 callback）。测试 mock 用 Promise 返回。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test managed-auth`
Expected: FAIL — `loginWithOAuth` 未定义。

- [ ] **Step 3: 实现 loginWithOAuth / logout**

追加到 `managed-auth.ts`：

```typescript
import { fetchEntitlement } from "./managed-auth"; // (同文件内直接调用，无需 import)

/** 拉起 OAuth，换取 JWT，落盘 auth + entitlement，返回 entitlement。 */
export async function loginWithOAuth(): Promise<Entitlement> {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = `${base()}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const code = new URL(redirected).searchParams.get("code");
  if (!code) throw new Error("managed login: no code in redirect");

  const res = await fetch(`${base()}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!res.ok) throw new Error(`managed exchange failed: ${res.status}`);
  const data = await res.json() as StoredAuth & { entitlement: Entitlement };
  await saveAuth({ jwt: data.jwt, refreshToken: data.refreshToken, expiresAt: data.expiresAt });
  await chrome.storage.local.set({ [ENT_KEY]: data.entitlement });
  return data.entitlement;
}

export async function logout(): Promise<void> {
  await clearAuth();
}
```

- [ ] **Step 4: 测试 setup 补 identity mock**

在 `src/test/setup.ts` 的 `chromeMock` 上加默认 `identity` stub（若已存在则跳过）：

```typescript
chromeMock.identity = {
  getRedirectURL: () => "https://EXT.chromiumapp.org/",
  launchWebAuthFlow: async () => "https://EXT.chromiumapp.org/?code=stub",
};
```

- [ ] **Step 5: 跑测试确认 PASS**

Run: `pnpm test managed-auth`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/lib/managed-auth.ts src/test/setup.ts
git commit -m "feat(managed-auth): OAuth login via launchWebAuthFlow + code exchange"
```

---

## Task 5: managed.ts 401 刷新重试

**Files:**
- Modify: `src/lib/model-router/providers/managed.ts`
- Test: `src/lib/model-router/providers/__tests__/managed-refresh.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
// managed-refresh.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { streamChat } from "../managed";
import { saveAuth } from "@/lib/managed-auth";
import type { ModelConfig } from "@/lib/model-router";

const cfg: ModelConfig = { provider: "managed", model: "default", apiKey: "old-jwt", baseUrl: "https://x.test/functions/v1" };
beforeEach(() => { chromeMock.storage.local.__store = {}; vi.restoreAllMocks(); });

it("on 401 refreshes token once and retries, then succeeds", async () => {
  await saveAuth({ jwt: "old-jwt", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/refresh"))
      return new Response(JSON.stringify({ jwt: "new-jwt", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 });
    call++;
    if (call === 1) return new Response("", { status: 401 });
    // 第二次（带 new-jwt）成功，返回一个最简 SSE done
    return new Response("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } });
  }));

  const events = [];
  for await (const e of streamChat(cfg, [{ role: "user", content: "hi" }])) events.push(e);

  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.some((e) => e.type === "done")).toBe(true);
  expect(call).toBe(2); // 重试了一次
});

it("on persistent 401 surfaces error (no infinite retry)", async () => {
  await saveAuth({ jwt: "old-jwt", refreshToken: "r1", expiresAt: Date.now() + 30 * 60_000 });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/refresh"))
      return new Response(JSON.stringify({ jwt: "new-jwt", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 });
    return new Response("", { status: 401 });
  }));
  const events = [];
  for await (const e of streamChat(cfg, [{ role: "user", content: "hi" }])) events.push(e);
  expect(events.filter((e) => e.type === "error" && e.status === 401).length).toBe(1);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test managed-refresh`
Expected: FAIL — 当前 wrapper 直通 401、不刷新。

- [ ] **Step 3: 实现刷新重试 wrapper**

因为 401 只发生在首个 response（SSE 开始前），重试整个流是安全的（不会吐半截输出）。

```typescript
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";
import { refreshJwt } from "@/lib/managed-auth";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  let active = config;
  for (let attempt = 0; attempt < 2; attempt++) {
    let auth401 = false;
    for await (const ev of streamChatOpenAICompat(active, messages, signal, tools, {
      authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
    })) {
      if (ev.type === "error" && ev.status === 401 && attempt === 0) {
        auth401 = true;
        break; // 不向上吐出，去刷新
      }
      yield ev;
    }
    if (!auth401) return;
    try {
      const fresh = await refreshJwt();
      active = { ...active, apiKey: fresh };
    } catch {
      yield { type: "error", error: "登录已失效，请重新登录官方服务", status: 401 };
      return;
    }
  }
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test managed-refresh`
Expected: PASS（两个用例均绿）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/managed.ts src/lib/model-router/providers/__tests__/managed-refresh.test.ts
git commit -m "feat(managed): refresh JWT once and retry on 401"
```

---

## Task 6: task-start 静默刷新（resolveInstanceToModelConfig）

**Files:**
- Modify: `src/lib/instances.ts:122-144`
- Test: `src/lib/instances.test.ts`（追加 managed 用例）

任务启动时 SW snapshot ModelConfig 进 checkpoint（长任务中途不再刷新）；因此在 resolve 时把 managed 的 JWT 主动刷成新鲜，覆盖 99% 短任务，避免 401。

- [ ] **Step 1: 写失败测试**

```typescript
it("resolveInstanceToModelConfig refreshes managed JWT at task start", async () => {
  // 建一个 managed instance（apiKey 存旧 JWT，model 存 tier_id）
  const id = await createInstance({ provider: "managed", nickname: "Pie 官方", apiKey: "old-jwt", model: "default" });
  await saveAuth({ jwt: "old-jwt", refreshToken: "r1", expiresAt: Date.now() + 1000 }); // 临近过期
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ jwt: "new-jwt", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }), { status: 200 })));

  const cfg = await resolveInstanceToModelConfig(id);
  expect(cfg!.provider).toBe("managed");
  expect(cfg!.model).toBe("default");     // tier_id 原样进 ModelConfig.model
  expect(cfg!.apiKey).toBe("new-jwt");    // 已刷新
});
```

（需在该测试文件顶部 import `saveAuth`。）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test instances`
Expected: FAIL — 返回的 apiKey 还是 `old-jwt`（instance 里加密存的旧 JWT）。

- [ ] **Step 3: resolve 时对 managed 注入新鲜 JWT**

`instances.ts` 在 `resolveInstanceToModelConfig` 末尾、构建返回对象前插入：

```typescript
  // managed：用 managed-auth 的有效 JWT 覆盖 instance 里加密存的旧 JWT
  let apiKey = inst.apiKey;
  if (inst.provider === "managed") {
    const { getValidJwt } = await import("@/lib/managed-auth");
    try { apiKey = await getValidJwt(); } catch { /* 未登录则保持原值，下游会 401 */ }
  }
```

并把返回对象里的 `apiKey: inst.apiKey` 改为 `apiKey`。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test instances`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(instances): refresh managed JWT at task-start resolve"
```

---

## Task 7: TierSelector 组件

**Files:**
- Create: `src/sidepanel/components/TierSelector.tsx`
- Test: `src/sidepanel/components/TierSelector.test.tsx`

只显示 `displayName`，绝不显示 tier_id / 真实模型名。选项来自 entitlement 下发的 tiers。

- [ ] **Step 1: 写失败测试**

```typescript
// TierSelector.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TierSelector } from "./TierSelector";

const tiers = [{ tierId: "default", displayName: "标准" }, { tierId: "advanced", displayName: "深度" }];

it("renders display names, not tier ids", () => {
  render(<TierSelector tiers={tiers} value="default" onChange={() => {}} />);
  expect(screen.getByText("标准")).toBeTruthy();
  expect(screen.queryByText("default")).toBeNull();
});

it("calls onChange with tierId on select", () => {
  const onChange = vi.fn();
  render(<TierSelector tiers={tiers} value="default" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button"));        // 展开
  fireEvent.click(screen.getByText("深度"));
  expect(onChange).toHaveBeenCalledWith("advanced");
});

it("free user with single tier renders a locked single option", () => {
  render(<TierSelector tiers={[tiers[0]]} value="default" onChange={() => {}} />);
  expect(screen.getByText("标准")).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test TierSelector`
Expected: FAIL — 组件不存在。

- [ ] **Step 3: 实现 TierSelector（沿用 ModelDropdown 的视觉类）**

```tsx
import { useState } from "react";

export interface TierOption { tierId: string; displayName: string; }
interface Props { tiers: TierOption[]; value: string; onChange: (tierId: string) => void; }

export function TierSelector({ tiers, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = tiers.find((t) => t.tierId === value) ?? tiers[0];
  const single = tiers.length <= 1;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !single && setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12px] text-fg-1 hover:border-fg-3"
      >
        <span>{current?.displayName ?? "标准"}</span>
        {!single && <span className="ml-auto text-fg-3">{open ? "▴" : "▾"}</span>}
      </button>
      {open && !single && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-field shadow">
          {tiers.map((t) => (
            <button
              key={t.tierId}
              type="button"
              onClick={() => { onChange(t.tierId); setOpen(false); }}
              className="flex w-full items-center px-3 py-1.5 text-[12px] text-fg-1 hover:bg-field"
            >
              {t.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test TierSelector`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/TierSelector.tsx src/sidepanel/components/TierSelector.test.tsx
git commit -m "feat(ui): TierSelector — thinking-strength picker (display names only)"
```

---

## Task 8: InstanceForm 接 managed 分支

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`
- Test: `src/sidepanel/components/InstanceForm.test.tsx`（追加）

当 `provider === "managed"`：隐藏 API key 输入（JWT 由登录流程注入，用户不手填），把 `<ModelDropdown>` 换成 `<TierSelector>`，tiers 取自 `getCachedEntitlement()`。

- [ ] **Step 1: 写失败测试**

```typescript
it("managed provider hides apiKey input and shows TierSelector", async () => {
  // mock 缓存的 entitlement
  chromeMock.storage.local.__store["managed_entitlement"] =
    { plan: "free", tiers: [{ tierId: "default", displayName: "标准" }] };
  render(<InstanceForm mode="create" provider="managed" initialNickname="Pie 官方"
    onSave={() => {}} onTest={() => {}} />);
  // 不应出现 API key 输入
  expect(screen.queryByLabelText(/API key/i)).toBeNull();
  // 应出现思考强度（标准）
  expect(await screen.findByText("标准")).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test InstanceForm`
Expected: FAIL — 仍渲染 apiKey 输入和 ModelDropdown。

- [ ] **Step 3: 加 managed 分支**

`InstanceForm.tsx`：
- 顶部：`const isManaged = props.provider === "managed";`
- 用 `useEffect` + `getCachedEntitlement()` 载入 `tiers`（state）。
- 渲染时：`{!isManaged && <Field label="API key">...</Field>}`（apiKey 输入只在非 managed 显示）。
- model 字段：
```tsx
<Field label={isManaged ? "思考强度" : t("instanceForm.model")}>
  {isManaged
    ? <TierSelector tiers={tiers} value={model} onChange={setModel} />
    : <ModelDropdown provider={props.provider} value={model} {/* …既有 props… */} />}
</Field>
```
- 提交 payload：managed 时 `apiKey` 传空串占位——但注意 `createInstance` 会因空串抛错。**managed instance 不走 InstanceForm 的 createInstance 路径**（见 Task 9：登录成功后由 `ManagedLoginCard` 直接建 instance）。InstanceForm 对 managed 只用于**编辑已存在 instance 的思考强度**（改 `model`/tier）。因此 managed 模式下隐藏 onSave 的 apiKey，调 `updateInstance(id, { model })`。

> 设计取舍：新建 managed instance 由登录流程负责（Task 9），InstanceForm 的 managed 分支只做"编辑 tier"。这样避免 createInstance 空 key 校验冲突，且符合"JWT 由登录注入、用户不手填"。

- [ ] **Step 4: 跑测试确认 PASS + 回归**

Run: `pnpm test InstanceForm`
Expected: PASS；既有非 managed 用例不受影响。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstanceForm.test.tsx
git commit -m "feat(ui): InstanceForm managed branch — TierSelector + hide apiKey"
```

---

## Task 9: ManagedLoginCard + Settings 入口（登录→建 instance→激活）

**Files:**
- Create: `src/sidepanel/components/ManagedLoginCard.tsx`
- Modify: `src/sidepanel/components/Settings.tsx`
- Test: `src/sidepanel/components/ManagedLoginCard.test.tsx`

- [ ] **Step 1: 写失败测试**

```typescript
// ManagedLoginCard.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { chromeMock } from "@/test/setup";
import { ManagedLoginCard } from "./ManagedLoginCard";
import * as auth from "@/lib/managed-auth";
import * as instances from "@/lib/instances";

beforeEach(() => { chromeMock.storage.local.__store = {}; vi.restoreAllMocks(); });

it("login → creates managed instance, sets active, calls onDone", async () => {
  vi.spyOn(auth, "loginWithOAuth").mockResolvedValue({ plan: "free", tiers: [{ tierId: "default", displayName: "标准" }] });
  vi.spyOn(auth, "getStoredAuth").mockResolvedValue({ jwt: "j", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
  const createSpy = vi.spyOn(instances, "createManagedInstance").mockResolvedValue("inst-1");
  const onDone = vi.fn();

  render(<ManagedLoginCard onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: /官方服务|免.*key|登录/ }));

  await waitFor(() => expect(createSpy).toHaveBeenCalled());
  expect(onDone).toHaveBeenCalledWith("inst-1");
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test ManagedLoginCard`
Expected: FAIL — 组件 + `createManagedInstance` 不存在。

- [ ] **Step 3: 加 createManagedInstance（绕过空 key 校验）**

`instances.ts` 新增导出（managed 的 apiKey=JWT 一定非空，但语义上由登录注入，单独函数更清晰）：

```typescript
export async function createManagedInstance(jwt: string, tierId = "default", nickname = "Pie 官方"): Promise<string> {
  return createInstance({ provider: "managed", nickname, apiKey: jwt, model: tierId });
}
```

- [ ] **Step 4: 实现 ManagedLoginCard**

```tsx
import { useState } from "react";
import { loginWithOAuth, getStoredAuth } from "@/lib/managed-auth";
import { createManagedInstance, setActiveInstance } from "@/lib/instances";

export function ManagedLoginCard({ onDone }: { onDone: (instanceId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function handleLogin() {
    setBusy(true); setErr(null);
    try {
      const ent = await loginWithOAuth();
      const auth = await getStoredAuth();
      const tier = ent.tiers[0]?.tierId ?? "default";
      const id = await createManagedInstance(auth!.jwt, tier);
      await setActiveInstance(id);
      onDone(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "登录失败");
    } finally { setBusy(false); }
  }
  return (
    <div className="rounded-lg border border-line bg-field px-4 py-3.5 flex flex-col gap-3">
      <div className="text-[13px] text-fg-1 font-medium">用官方服务（免 API key）</div>
      <div className="text-[12px] text-fg-2">登录即送免费额度，无需自带 key。流量会经过 Pie 服务器；BYOK 仍是端到端直连。</div>
      <button type="button" disabled={busy} onClick={handleLogin}
        className="rounded-lg bg-accent px-3 py-2 text-[12px] text-white disabled:opacity-50">
        {busy ? "登录中…" : "用 Google 登录"}
      </button>
      {err && <div className="text-[12px] text-warning">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Settings 挂入口**

`Settings.tsx` 的 configs tab 区域，在 instance 列表上方挂 `<ManagedLoginCard onDone={(id) => { /* 刷新 instances 列表 + 选中 id */ }} />`。沿用该文件已有的 instances 重载逻辑（`loadInstances()` 之类）。

- [ ] **Step 6: 跑测试确认 PASS + build**

Run: `pnpm test ManagedLoginCard && pnpm test && pnpm build`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/ManagedLoginCard.tsx src/sidepanel/components/Settings.tsx src/lib/instances.ts
git commit -m "feat(ui): managed login entry — OAuth → create+activate managed instance"
```

---

## Task 10: 402/403 卡片（额度用尽 / 需升级）

**Files:**
- Create: `src/sidepanel/components/QuotaExhaustedCard.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`（错误展示处，按 status 分流）
- Test: `src/sidepanel/components/QuotaExhaustedCard.test.tsx`

错误经 SW 的 error StreamEvent 流回面板。面板拿到 error 文本里含 `(402)` 或 status=402 时，渲染额度卡而非通用错误。（若 SW→panel wire 丢了 status，用文本 `(402)`/`(403)` 兜底匹配。）

- [ ] **Step 1: 写失败测试**

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { QuotaExhaustedCard } from "./QuotaExhaustedCard";

it("renders BYOK + buy actions", () => {
  const onByok = vi.fn(); const onBuy = vi.fn();
  render(<QuotaExhaustedCard kind="quota" onByok={onByok} onBuy={onBuy} />);
  expect(screen.getByText(/额度用尽|用完/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /自带 key|BYOK/i }));
  expect(onByok).toHaveBeenCalled();
});

it("kind=upgrade shows upgrade copy", () => {
  render(<QuotaExhaustedCard kind="upgrade" onByok={() => {}} onBuy={() => {}} />);
  expect(screen.getByText(/升级|高级档/)).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test QuotaExhaustedCard`
Expected: FAIL — 组件不存在。

- [ ] **Step 3: 实现 QuotaExhaustedCard**

```tsx
interface Props { kind: "quota" | "upgrade"; onByok: () => void; onBuy: () => void; }
export function QuotaExhaustedCard({ kind, onByok, onBuy }: Props) {
  const isQuota = kind === "quota";
  return (
    <div className="rounded-lg border border-warning-line bg-warning-tint px-4 py-3.5 flex flex-col gap-3 text-warning">
      <div className="text-[13px] font-medium">{isQuota ? "免费额度用尽" : "该思考强度需升级"}</div>
      <div className="text-[12px]">
        {isQuota ? "你的官方免费额度已用完。可自带 API key 继续，或购买 credit 包。" : "高级思考强度仅对付费用户开放。"}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onByok} className="rounded-lg border border-line px-3 py-1.5 text-[12px]">自带 key（BYOK）</button>
        <button type="button" onClick={onBuy} className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white">购买 credit</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Chat.tsx 按 status 分流**

在 Chat.tsx 既有错误渲染处，先判定 managed 相关 status：

```tsx
// err: { error: string; status?: number }
const code = err.status ?? (/\((40[23])\)/.exec(err.error)?.[1] ? Number(/\((40[23])\)/.exec(err.error)![1]) : undefined);
if (code === 402) return <QuotaExhaustedCard kind="quota" onByok={goByok} onBuy={openBuy} />;
if (code === 403) return <QuotaExhaustedCard kind="upgrade" onByok={goByok} onBuy={openBuy} />;
// 否则走既有通用错误展示
```

`goByok` → 打开新建 BYOK instance 向导；`openBuy` → Phase 1 先 `chrome.tabs.create` 打开一个占位购买页（Phase 2 接 Stripe Checkout）。

- [ ] **Step 5: 跑测试确认 PASS + build**

Run: `pnpm test QuotaExhaustedCard && pnpm test && pnpm build`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/QuotaExhaustedCard.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat(ui): 402/403 quota & upgrade cards for managed tier"
```

---

## Task 11: 收尾回归 + README/CLAUDE 文档

**Files:**
- Modify: `README.md`（provider 清单加"官方服务"一句）
- Modify: `CLAUDE.md`（Provider registry 段补一句 managed 的特殊性：apiKey=JWT、model=tier_id、登录流程建 instance）
- Test: 全量

- [ ] **Step 1: 全量回归**

Run: `pnpm test && pnpm build`
Expected: 全绿；build invariant 通过。

- [ ] **Step 2: 文档补充**

- README provider 清单加：`官方服务（managed）— 登录即用，免自带 key`。
- CLAUDE.md「Architecture Invariants」provider 段补：`managed` provider 的 `apiKey` 存后端 JWT、`model` 存 tier_id（服务端解析为真实模型）；新建走登录流程（`ManagedLoginCard` → `createManagedInstance`）而非 InstanceForm；JWT 由 `managed-auth` 静默刷新；客户端从不暴露真实模型名。

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: managed service tier — README provider list + CLAUDE invariants"
```

---

## 上线前置（非代码）

- registry 的 `defaultBaseUrl` 占位 `YOUR_PROJECT_REF` 必须替换为真实 Supabase project ref（与 backend plan 同步）。
- OAuth redirect：`chrome.identity.getRedirectURL()` 形如 `https://<extid>.chromiumapp.org/`，需在服务端 OAuth provider 的 allowed redirect 列表登记（见 backend plan）。
- 上游 ToS：**已评估，非 blocker**（见 spec §11）。模型经服务端 `tier_config` 热切换、不绑定单一厂商；本服务属应用代理自有用户的标准模式。部署时 skim 所选上游政策即可。
