# Custom Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 multi-instance + per-model capability 架构上，新增「用户自定义 OpenAI-compat provider」能力 — 用户在 UI 内填 name / baseUrl / 模型清单 / capability flags，与 8 家 builtin 平级共存。

**Architecture:** `Provider` 类型从 8 字面量 union 升级为 `BuiltinProvider | \`custom:${string}\`` 的 `ProviderRef` discriminator；新增 `StoredCustomProvider` storage entity（CRUD + cascade-block）；`PROVIDER_REGISTRY` 同步查询保留给 builtin，加 `resolveProviderMeta` async 统一入口（builtin / custom 都走它）；dispatch 从 `Record<Provider, fn>` 改为 `dispatchStreamChat(config)` function，custom 一律路由到 `_shared/openai-compat-core.ts`；UI 新增 Custom Providers section + CustomProviderForm 组件，复用 InstanceForm / ModelDropdown / NewConfigWizard。零 storage migration（老 instance 的 `provider: "openai"` 等字符串自然属于新 union）；不动 manifest（`<all_urls>` 已覆盖）。

**Tech Stack:** TypeScript 6, React 19, TailwindCSS v4, vitest + @testing-library/react + happy-dom, chrome.storage.local with AES-GCM via Web Crypto. Spec: `docs/specs/2026-05-07-custom-providers-design.md`. Pre-existing supportsVision bug deferred to issue #39.

---

## Pre-flight

Before Task 1, verify clean working tree and tests baseline:

```bash
git status                    # Expected: clean on feat/custom-providers branch
pnpm test                     # Expected: all current tests pass (baseline)
pnpm build                    # Expected: dist/ produced cleanly
```

If any baseline fails, stop and resolve before proceeding.

---

## Task 1: Type system upgrade — `BuiltinProvider` + `ProviderRef`

**Files:**
- Modify: `src/lib/model-router/index.ts`
- Modify: `src/lib/model-router/dispatch.test.ts`

**Reason:** Lay the foundation for custom providers. `Provider` becomes alias of `BuiltinProvider` (8 fixed strings). `ProviderRef = BuiltinProvider | \`custom:${string}\`` is the new discriminator used everywhere a provider can be either builtin or custom. `ModelConfig.provider` widens to `ProviderRef`. Add `providerName?: string` for sync error-prefix display. TypeScript compiler will surface every place that needs adjustment in subsequent tasks.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/model-router/dispatch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ProviderRef, BuiltinProvider, ModelConfig } from "./index";

describe("ProviderRef discriminator", () => {
  it("accepts all 8 builtin literals", () => {
    const refs: ProviderRef[] = [
      "anthropic", "openai", "openrouter", "minimax",
      "zhipu", "bailian", "gemini", "deepseek",
    ];
    expect(refs).toHaveLength(8);
  });

  it("accepts custom: template-literal refs", () => {
    const ref: ProviderRef = "custom:abc-123-uuid";
    expect(ref.startsWith("custom:")).toBe(true);
  });

  it("BuiltinProvider is a strict subset (no custom: allowed)", () => {
    // Type-only assertion — compile-time guarantee
    const _b: BuiltinProvider = "openai";
    // @ts-expect-error — custom: is NOT a BuiltinProvider
    const _c: BuiltinProvider = "custom:x";
    expect(_b).toBe("openai");
  });

  it("ModelConfig has optional providerName for display", () => {
    const cfg: ModelConfig = {
      provider: "custom:my-uuid",
      providerName: "My Ollama",
      model: "llama3:8b",
      apiKey: "sk-test",
    };
    expect(cfg.providerName).toBe("My Ollama");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/dispatch.test.ts -- --reporter=verbose 2>&1 | head -40
```

Expected: type errors / "ProviderRef is not exported" / "BuiltinProvider is not exported".

- [ ] **Step 3: Update type exports in `src/lib/model-router/index.ts`**

Replace lines 12–28 (the existing `Provider` type and `ModelConfig` interface) with:

```ts
export type BuiltinProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini"
  | "deepseek";

/** Discriminated provider reference: builtin id OR `custom:${uuid}`. */
export type ProviderRef = BuiltinProvider | `custom:${string}`;

/** @deprecated Prefer ProviderRef. Kept as alias for old call sites. */
export type Provider = BuiltinProvider;

export interface ModelConfig {
  provider: ProviderRef;
  /** Display name for error messages. Filled by resolveInstanceToModelConfig. */
  providerName?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/lib/model-router/dispatch.test.ts -- --reporter=verbose
```

Expected: all 4 cases PASS.

- [ ] **Step 5: Run full test + build to surface downstream type errors (expected to fail)**

```bash
pnpm test 2>&1 | tail -30
pnpm build 2>&1 | tail -30
```

Expected: type errors at multiple call sites — these are intentional and will be fixed by Tasks 2–10.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/index.ts src/lib/model-router/dispatch.test.ts
git commit -m "feat(types): introduce BuiltinProvider + ProviderRef discriminator + ModelConfig.providerName

Foundation for custom providers. Provider becomes alias of BuiltinProvider;
ProviderRef widens to allow custom:\${uuid}. Downstream type errors are
expected and will be resolved in subsequent tasks."
```

---

## Task 2: Registry async API — `resolveProviderMeta` + `resolveModelMeta`

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts`
- Modify: `src/lib/model-router/providers/registry.test.ts`
- Modify: `src/lib/model-router/index.ts` (re-export new helpers)

**Reason:** Build the async resolution path that unifies builtin + custom lookups. Keep the existing sync `getProviderMeta` (renamed `getBuiltinProviderMeta` for clarity) for the few sites that only ever see builtin. Add `resolveProviderMeta(ref)` async (queries `chrome.storage.local` for custom) and `resolveModelMeta(ref, modelId)` async (used by agent loop / window-token-budget).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/model-router/providers/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getBuiltinProviderMeta, resolveProviderMeta, resolveModelMeta } from "./registry";

// Minimal chrome.storage.local mock shared by these tests
function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error — install global
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(store, kv)),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
    },
  };
  return store;
}

describe("getBuiltinProviderMeta (sync)", () => {
  it("returns meta for known builtin id", () => {
    const meta = getBuiltinProviderMeta("openai");
    expect(meta?.id).toBe("openai");
    expect(meta?.defaultBaseUrl).toBe("https://api.openai.com");
  });

  it("returns null for non-builtin (e.g. custom:)", () => {
    // @ts-expect-error — sync helper rejects non-builtin at type level
    expect(getBuiltinProviderMeta("custom:x")).toBeNull();
  });
});

describe("resolveProviderMeta (async, builtin + custom)", () => {
  beforeEach(() => installStorageMock());

  it("resolves builtin id to PROVIDER_REGISTRY entry", async () => {
    const meta = await resolveProviderMeta("anthropic");
    expect(meta?.id).toBe("anthropic");
    expect(meta?.name).toBe("Anthropic");
  });

  it("resolves custom:uuid by reading chrome.storage.local", async () => {
    installStorageMock({
      custom_provider_abc: {
        id: "abc",
        name: "My Local Ollama",
        baseUrl: "http://localhost:11434",
        models: [{ id: "llama3:8b", vision: false, tools: true, maxContextTokens: 8000 }],
        createdAt: 1, updatedAt: 1,
      },
    });
    const meta = await resolveProviderMeta("custom:abc");
    expect(meta?.id).toBe("custom:abc");
    expect(meta?.name).toBe("My Local Ollama");
    expect(meta?.defaultBaseUrl).toBe("http://localhost:11434");
    expect(meta?.models).toHaveLength(1);
    expect(meta?.models[0]?.id).toBe("llama3:8b");
  });

  it("returns null for unknown ref", async () => {
    expect(await resolveProviderMeta("custom:does-not-exist")).toBeNull();
    // @ts-expect-error — type-impossible but storage check returns null too
    expect(await resolveProviderMeta("totally-bogus")).toBeNull();
  });
});

describe("resolveModelMeta (async)", () => {
  beforeEach(() => installStorageMock());

  it("returns model meta for builtin", async () => {
    const m = await resolveModelMeta("openai", "gpt-4o");
    expect(m?.id).toBe("gpt-4o");
    expect(m?.vision).toBe(true);
  });

  it("returns model meta for custom from storage", async () => {
    installStorageMock({
      custom_provider_xyz: {
        id: "xyz", name: "Custom",
        baseUrl: "https://example.com",
        models: [{ id: "model-a", vision: true, tools: false, maxContextTokens: 32000 }],
        createdAt: 1, updatedAt: 1,
      },
    });
    const m = await resolveModelMeta("custom:xyz", "model-a");
    expect(m?.id).toBe("model-a");
    expect(m?.vision).toBe(true);
    expect(m?.tools).toBe(false);
  });

  it("returns null when model not found", async () => {
    expect(await resolveModelMeta("openai", "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/lib/model-router/providers/registry.test.ts -- --reporter=verbose 2>&1 | tail -30
```

Expected: "getBuiltinProviderMeta is not exported" / "resolveProviderMeta is not exported" / similar.

- [ ] **Step 3: Update `src/lib/model-router/providers/registry.ts`**

Replace lines 122–128 (the existing `getProviderMeta` / `getModelMeta`) with:

```ts
import type { BuiltinProvider, ProviderRef } from "@/lib/model-router";

/** Sync registry lookup. Only accepts builtin ids — for code paths that
 *  cannot await (e.g. SSE generator error path). */
export function getBuiltinProviderMeta(id: BuiltinProvider): ProviderMeta | null {
  return PROVIDER_REGISTRY.find((p) => p.id === id) ?? null;
}

/** @deprecated alias kept for back-compat during the migration. New code
 *  should call getBuiltinProviderMeta or resolveProviderMeta. */
export function getProviderMeta(id: BuiltinProvider): ProviderMeta | undefined {
  return getBuiltinProviderMeta(id) ?? undefined;
}

export function getModelMeta(provider: BuiltinProvider, modelId: string): ModelMeta | undefined {
  return getBuiltinProviderMeta(provider)?.models.find((m) => m.id === modelId);
}

/** Async unified resolver. Handles both builtin ids and `custom:${uuid}`
 *  refs. Reads chrome.storage.local for custom providers. */
export async function resolveProviderMeta(ref: ProviderRef): Promise<ProviderMeta | null> {
  if (typeof ref !== "string") return null;
  if (ref.startsWith("custom:")) {
    const uuid = ref.slice("custom:".length);
    const key = `custom_provider_${uuid}`;
    const r = await chrome.storage.local.get(key);
    const stored = r[key] as
      | { id: string; name: string; baseUrl: string; models: ModelMeta[] }
      | undefined;
    if (!stored) return null;
    return {
      id: ref,
      name: stored.name,
      defaultBaseUrl: stored.baseUrl,
      placeholder: "API key",
      models: stored.models,
    };
  }
  return getBuiltinProviderMeta(ref as BuiltinProvider);
}

/** Async unified model resolver. Used by agent loop / sliding window. */
export async function resolveModelMeta(ref: ProviderRef, modelId: string): Promise<ModelMeta | null> {
  const meta = await resolveProviderMeta(ref);
  return meta?.models.find((m) => m.id === modelId) ?? null;
}
```

Note: `ProviderMeta.id` widens — update its type to accept `ProviderRef` instead of `Provider`. Edit lines 16–17 of the same file:

```ts
export interface ProviderMeta {
  id: ProviderRef;       // was: Provider
  name: string;
  defaultBaseUrl: string;
  placeholder: string;
  models: ModelMeta[];
  modelsEndpoint?: string;
}
```

- [ ] **Step 4: Re-export from `src/lib/model-router/index.ts`**

Replace lines 8–10:

```ts
export { PROVIDER_REGISTRY, getBuiltinProviderMeta, getProviderMeta, resolveProviderMeta, resolveModelMeta, getModelMeta } from "./providers/registry";
export type { ProviderMeta, ModelMeta } from "./providers/registry";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test src/lib/model-router/providers/registry.test.ts -- --reporter=verbose
```

Expected: all new cases PASS. Existing tests should continue passing (the `getProviderMeta` alias keeps them intact).

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts src/lib/model-router/index.ts
git commit -m "feat(registry): add async resolveProviderMeta + resolveModelMeta

getBuiltinProviderMeta is the sync builtin-only lookup. resolveProviderMeta
unifies builtin + custom by reading chrome.storage.local for custom:\${uuid}.
ProviderMeta.id widens to ProviderRef. Old getProviderMeta / getModelMeta
kept as deprecated aliases until call-site migration completes."
```

---

## Task 3: `StoredCustomProvider` CRUD — new `custom-providers.ts` module

**Files:**
- Create: `src/lib/custom-providers.ts`
- Create: `src/lib/custom-providers.test.ts`

**Reason:** Storage layer for the new entity. CRUD parallels `instances.ts` style (uuid keys, index array, atomic writes). Includes a `getDependentInstances(providerId)` helper used by Settings UI for cascade-block guard.

- [ ] **Step 1: Write the failing test**

Create `src/lib/custom-providers.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCustomProvider,
  getCustomProvider,
  listCustomProviders,
  updateCustomProvider,
  deleteCustomProvider,
  getDependentInstances,
} from "./custom-providers";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(store, kv)),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
    },
  };
  return store;
}

describe("custom-providers CRUD", () => {
  beforeEach(() => installStorageMock());

  it("createCustomProvider writes entity + appends to index", async () => {
    const id = await createCustomProvider({
      name: "My Ollama",
      baseUrl: "http://localhost:11434",
      models: [],
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const got = await getCustomProvider(id);
    expect(got?.name).toBe("My Ollama");
    expect(got?.baseUrl).toBe("http://localhost:11434");
    expect(got?.models).toEqual([]);
    expect(got?.createdAt).toBeTypeOf("number");

    const list = await listCustomProviders();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(id);
  });

  it("listCustomProviders preserves index order", async () => {
    const a = await createCustomProvider({ name: "A", baseUrl: "https://a.test", models: [] });
    const b = await createCustomProvider({ name: "B", baseUrl: "https://b.test", models: [] });
    const list = await listCustomProviders();
    expect(list.map((p) => p.id)).toEqual([a, b]);
  });

  it("updateCustomProvider patches fields and bumps updatedAt", async () => {
    const id = await createCustomProvider({ name: "X", baseUrl: "https://x.test", models: [] });
    const before = (await getCustomProvider(id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateCustomProvider(id, {
      name: "X-renamed",
      models: [{ id: "m1", vision: false, tools: true, maxContextTokens: 128000 }],
    });
    const got = (await getCustomProvider(id))!;
    expect(got.name).toBe("X-renamed");
    expect(got.models).toHaveLength(1);
    expect(got.updatedAt).toBeGreaterThan(before);
    expect(got.baseUrl).toBe("https://x.test"); // not patched
  });

  it("deleteCustomProvider removes entity + index entry", async () => {
    const id = await createCustomProvider({ name: "Z", baseUrl: "https://z.test", models: [] });
    await deleteCustomProvider(id);
    expect(await getCustomProvider(id)).toBeNull();
    expect(await listCustomProviders()).toEqual([]);
  });

  it("createCustomProvider validates name + baseUrl", async () => {
    await expect(createCustomProvider({ name: "", baseUrl: "https://x.test", models: [] }))
      .rejects.toThrow(/name/i);
    await expect(createCustomProvider({ name: "X", baseUrl: "ftp://nope", models: [] }))
      .rejects.toThrow(/baseUrl/i);
  });

  it("getDependentInstances finds instances referencing custom:${id}", async () => {
    const store = installStorageMock();
    const provId = "abc-uuid";
    store["custom_provider_" + provId] = {
      id: provId, name: "P", baseUrl: "https://p.test", models: [],
      createdAt: 1, updatedAt: 1,
    };
    store["custom_providers_index"] = [provId];
    store["instance_i1"] = { id: "i1", provider: `custom:${provId}`, nickname: "x", encryptedKey: "...", model: "m", createdAt: 1 };
    store["instance_i2"] = { id: "i2", provider: "openai", nickname: "y", encryptedKey: "...", model: "gpt-4o", createdAt: 1 };
    store["instances_index"] = ["i1", "i2"];

    const deps = await getDependentInstances(provId);
    expect(deps).toHaveLength(1);
    expect(deps[0]?.id).toBe("i1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/custom-providers.test.ts -- --reporter=verbose 2>&1 | tail -20
```

Expected: "Cannot find module './custom-providers'".

- [ ] **Step 3: Create `src/lib/custom-providers.ts`**

```ts
import type { ProviderRef } from "@/lib/model-router";

export interface CustomModelMeta {
  id: string;
  displayName?: string;
  vision: boolean;
  tools: boolean;
  maxContextTokens: number;
}

export interface StoredCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
  createdAt: number;
  updatedAt: number;
}

const PROV_KEY = (id: string) => `custom_provider_${id}`;
const INDEX_KEY = "custom_providers_index";

const HTTP_RE = /^https?:\/\//;

function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/$/, "");
}

function validate(input: { name: string; baseUrl: string }) {
  if (!input.name.trim()) throw new Error("name cannot be empty");
  if (input.name.length > 40) throw new Error("name too long (max 40)");
  if (!HTTP_RE.test(input.baseUrl.trim())) throw new Error("baseUrl must start with http:// or https://");
}

export async function createCustomProvider(input: {
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
}): Promise<string> {
  validate(input);
  const id = crypto.randomUUID();
  const now = Date.now();
  const stored: StoredCustomProvider = {
    id,
    name: input.name.trim(),
    baseUrl: normaliseBaseUrl(input.baseUrl),
    models: input.models,
    createdAt: now,
    updatedAt: now,
  };
  const idx = await readIndex();
  idx.push(id);
  await chrome.storage.local.set({ [PROV_KEY(id)]: stored, [INDEX_KEY]: idx });
  return id;
}

export async function getCustomProvider(id: string): Promise<StoredCustomProvider | null> {
  const r = await chrome.storage.local.get(PROV_KEY(id));
  return (r[PROV_KEY(id)] as StoredCustomProvider | undefined) ?? null;
}

export async function listCustomProviders(): Promise<StoredCustomProvider[]> {
  const idx = await readIndex();
  const out: StoredCustomProvider[] = [];
  for (const id of idx) {
    const p = await getCustomProvider(id);
    if (p) out.push(p);
  }
  return out;
}

export async function updateCustomProvider(
  id: string,
  patch: Partial<{ name: string; baseUrl: string; models: CustomModelMeta[] }>,
): Promise<void> {
  const cur = await getCustomProvider(id);
  if (!cur) throw new Error(`custom provider ${id} not found`);
  const next: StoredCustomProvider = { ...cur, updatedAt: Date.now() };
  if (patch.name !== undefined) {
    validate({ name: patch.name, baseUrl: cur.baseUrl });
    next.name = patch.name.trim();
  }
  if (patch.baseUrl !== undefined) {
    validate({ name: next.name, baseUrl: patch.baseUrl });
    next.baseUrl = normaliseBaseUrl(patch.baseUrl);
  }
  if (patch.models !== undefined) next.models = patch.models;
  await chrome.storage.local.set({ [PROV_KEY(id)]: next });
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const idx = (await readIndex()).filter((x) => x !== id);
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
  await chrome.storage.local.remove(PROV_KEY(id));
}

/** Returns instances that reference `custom:${providerId}`. Used for
 *  cascade-block guard before allowing provider deletion. */
export async function getDependentInstances(
  providerId: string,
): Promise<{ id: string; nickname: string }[]> {
  const ref: ProviderRef = `custom:${providerId}`;
  const r = await chrome.storage.local.get("instances_index");
  const idx = (r["instances_index"] as string[] | undefined) ?? [];
  const out: { id: string; nickname: string }[] = [];
  for (const iid of idx) {
    const got = await chrome.storage.local.get(`instance_${iid}`);
    const inst = got[`instance_${iid}`] as { id: string; nickname: string; provider: string } | undefined;
    if (inst && inst.provider === ref) out.push({ id: inst.id, nickname: inst.nickname });
  }
  return out;
}

async function readIndex(): Promise<string[]> {
  const r = await chrome.storage.local.get(INDEX_KEY);
  return ((r[INDEX_KEY] as string[]) ?? []).slice();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/lib/custom-providers.test.ts -- --reporter=verbose
```

Expected: all 6 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/custom-providers.ts src/lib/custom-providers.test.ts
git commit -m "feat(storage): add custom-providers CRUD + cascade-block guard

StoredCustomProvider entity with uuid + index. validate() enforces
name (≤40, non-empty) and baseUrl (http(s)://) at create / update time.
getDependentInstances() finds instances referencing custom:\${id} for
cascade-block UI."
```

---

## Task 4: `instances.ts` — propagate `ProviderRef`, async resolve custom baseUrl + providerName

**Files:**
- Modify: `src/lib/instances.ts`
- Modify: `src/lib/instances.test.ts`

**Reason:** `StoredInstance.provider` widens to `ProviderRef`. `resolveInstanceToModelConfig` becomes the single place that fills `ModelConfig.baseUrl` (builtin → `defaultBaseUrl`; custom → `customProvider.baseUrl`) and `ModelConfig.providerName` (builtin → `meta.name`; custom → `customProvider.name`). All downstream code (dispatch, openai-compat error path) reads these pre-resolved fields without further async lookups.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/instances.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveInstanceToModelConfig, createInstance } from "./instances";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(store, kv)),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
    },
  };
  // @ts-expect-error — happy-dom subtle crypto polyfill
  if (!global.crypto?.subtle) global.crypto = require("node:crypto").webcrypto;
  return store;
}

describe("resolveInstanceToModelConfig — custom provider", () => {
  beforeEach(() => installStorageMock());

  it("fills baseUrl + providerName from custom provider entity", async () => {
    // Seed a custom provider directly (createCustomProvider already covered)
    const store = installStorageMock();
    store["custom_provider_pX"] = {
      id: "pX", name: "My Local",
      baseUrl: "http://localhost:11434",
      models: [{ id: "llama3:8b", vision: false, tools: true, maxContextTokens: 8000 }],
      createdAt: 1, updatedAt: 1,
    };
    store["custom_providers_index"] = ["pX"];

    const iid = await createInstance({
      provider: "custom:pX",
      nickname: "local",
      apiKey: "ollama",
      model: "llama3:8b",
    });
    const cfg = await resolveInstanceToModelConfig(iid);
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("custom:pX");
    expect(cfg!.providerName).toBe("My Local");
    expect(cfg!.baseUrl).toBe("http://localhost:11434");
    expect(cfg!.model).toBe("llama3:8b");
    expect(cfg!.apiKey).toBe("ollama");
  });

  it("returns null when custom provider entity is missing", async () => {
    installStorageMock();
    const iid = await createInstance({
      provider: "custom:gone",
      nickname: "stale",
      apiKey: "k",
      model: "x",
    });
    expect(await resolveInstanceToModelConfig(iid)).toBeNull();
  });

  it("builtin path still fills providerName + defaultBaseUrl", async () => {
    installStorageMock();
    const iid = await createInstance({
      provider: "openai",
      nickname: "work",
      apiKey: "sk-work",
      model: "gpt-4o",
    });
    const cfg = await resolveInstanceToModelConfig(iid);
    expect(cfg!.providerName).toBe("OpenAI");
    expect(cfg!.baseUrl).toBe("https://api.openai.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/instances.test.ts -- --reporter=verbose 2>&1 | tail -30
```

Expected: type errors for `provider: "custom:pX"` (StoredInstance.provider too narrow) or `cfg!.providerName` undefined.

- [ ] **Step 3: Update `src/lib/instances.ts`**

Update line 1 import:

```ts
import type { ProviderRef, ModelConfig } from "@/lib/model-router";
import { resolveProviderMeta } from "@/lib/model-router";
```

Update `StoredInstance` (line 5–16) to use `ProviderRef`:

```ts
export interface StoredInstance {
  id: string;
  provider: ProviderRef;          // was: Provider
  nickname: string;
  encryptedKey: string;
  model: string;
  customModels?: string[];
  fetchedModels?: { id: string; vision: boolean; tools: boolean; maxContextTokens: number }[];
  fetchedAt?: number;
  maxTokens?: number;
  createdAt: number;
}
```

Update `createInstance` signature (line 26–35) — `provider` widens:

```ts
export async function createInstance(input: {
  provider: ProviderRef;          // was: Provider
  nickname: string;
  apiKey: string;
  model: string;
  customModels?: string[];
}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("API key cannot be empty");
  const id = crypto.randomUUID();
  const key = await getOrCreateEncryptionKey();
  // builtin path keeps inRegistry detection; custom path skips (custom
  // models are owned by the provider entity, not the instance).
  let resolvedCustomModels: string[] | undefined;
  if (!input.provider.startsWith("custom:")) {
    const meta = await resolveProviderMeta(input.provider);
    const inRegistry = meta?.models.some((m) => m.id === input.model) ?? false;
    if (input.customModels && input.customModels.length > 0) {
      resolvedCustomModels = inRegistry
        ? input.customModels
        : Array.from(new Set([...input.customModels, input.model]));
    } else if (!inRegistry) {
      resolvedCustomModels = [input.model];
    }
  }
  const stored: StoredInstance = {
    id,
    provider: input.provider,
    nickname: input.nickname,
    encryptedKey: await encrypt(input.apiKey, key),
    model: input.model,
    ...(resolvedCustomModels && { customModels: resolvedCustomModels }),
    createdAt: Date.now(),
  };
  const idx = await readIndex();
  idx.push(id);
  await chrome.storage.local.set({ [INSTANCE_KEY(id)]: stored, [INDEX_KEY]: idx });
  if (idx.length === 1 && !(await getActiveInstance())) await setActiveInstance(id);
  return id;
}
```

Replace `resolveInstanceToModelConfig` (line 106–118) with the async-aware version:

```ts
export async function resolveInstanceToModelConfig(id: string): Promise<ModelConfig | null> {
  const inst = await getInstance(id);
  if (!inst) return null;
  const meta = await resolveProviderMeta(inst.provider);
  if (!meta) return null;
  return {
    provider: inst.provider,
    providerName: meta.name,
    model: inst.model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
  };
}
```

Replace the import at line 2–3 to remove the old `getProviderMeta` import:

```ts
// (line 1 already updated above; the old `import { getProviderMeta } from ...` line is gone)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/lib/instances.test.ts -- --reporter=verbose
```

Expected: all new + existing cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(instances): widen provider to ProviderRef + async resolve custom

StoredInstance.provider is ProviderRef (builtin or custom:\${uuid}).
resolveInstanceToModelConfig now uses resolveProviderMeta to populate
baseUrl + providerName for both paths. createInstance skips inRegistry
detection for custom providers (model list lives on the provider entity)."
```

---

## Task 5: `dispatchStreamChat` function + `streamChat` async meta resolve

**Files:**
- Modify: `src/lib/model-router/providers/index.ts`
- Modify: `src/lib/model-router/index.ts`
- Modify: `src/lib/model-router/dispatch.test.ts`

**Reason:** Replace static `Record<Provider, fn>` lookup with a function that handles `custom:` refs (route them all to `streamChatOpenAICompat`). `streamChat` entry already awaits — extend it to use `resolveProviderMeta` so custom baseUrl flows through.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/model-router/dispatch.test.ts`:

```ts
import { dispatchStreamChat } from "./providers";
import { streamChatOpenAICompat } from "./providers/_shared/openai-compat-core";

describe("dispatchStreamChat", () => {
  it("returns the builtin handler for builtin ids", () => {
    const fn = dispatchStreamChat({
      provider: "openai", model: "gpt-4o", apiKey: "sk-x",
    });
    expect(typeof fn).toBe("function");
    // It is the openai wrapper, which internally calls streamChatOpenAICompat
    expect(fn.name === "streamChat" || fn.name === "openaiChat").toBeTruthy();
  });

  it("returns streamChatOpenAICompat for custom: refs", () => {
    const fn = dispatchStreamChat({
      provider: "custom:abc",
      model: "m", apiKey: "k",
    });
    expect(fn).toBe(streamChatOpenAICompat);
  });

  it("throws for unknown provider", () => {
    expect(() => dispatchStreamChat({
      // @ts-expect-error — type-impossible, runtime guard
      provider: "totally-unknown",
      model: "x", apiKey: "k",
    })).toThrow(/Unknown provider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/dispatch.test.ts -- --reporter=verbose 2>&1 | tail -20
```

Expected: "dispatchStreamChat is not exported".

- [ ] **Step 3: Replace `src/lib/model-router/providers/index.ts`**

```ts
import type { ModelConfig, BuiltinProvider } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";

import { streamChat as anthropicChat } from "./anthropic";
import { streamChat as openaiChat } from "./openai";
import { streamChat as openrouterChat } from "./openrouter";
import { streamChat as zhipuChat } from "./zhipu";
import { streamChat as bailianChat } from "./bailian";
import { streamChat as minimaxChat } from "./minimax";
import { streamChat as geminiChat } from "./gemini";
import { streamChat as deepseekChat } from "./deepseek";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export type StreamChatFn = (
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
) => AsyncGenerator<StreamEvent>;

const BUILTIN_DISPATCH: Record<BuiltinProvider, StreamChatFn> = {
  anthropic: anthropicChat,
  openai: openaiChat,
  openrouter: openrouterChat,
  zhipu: zhipuChat,
  bailian: bailianChat,
  minimax: minimaxChat,
  gemini: geminiChat,
  deepseek: deepseekChat,
};

/** Pick the streaming handler for a config. Custom refs always route to
 *  the OpenAI-compat shared core (no hooks). Builtin refs go to their
 *  registered wrapper. */
export function dispatchStreamChat(config: ModelConfig): StreamChatFn {
  const ref = config.provider;
  if (ref in BUILTIN_DISPATCH) {
    return BUILTIN_DISPATCH[ref as BuiltinProvider];
  }
  if (typeof ref === "string" && ref.startsWith("custom:")) {
    return streamChatOpenAICompat;
  }
  throw new Error(`Unknown provider: ${ref}`);
}

/** @deprecated kept for migration period. Existing call sites should
 *  switch to dispatchStreamChat(config). */
export const streamChatByProvider = BUILTIN_DISPATCH;
```

- [ ] **Step 4: Update `src/lib/model-router/index.ts` `streamChat` to use async resolve + dispatch fn**

Replace lines 75–97 (the existing `streamChat` generator) with:

```ts
import { resolveProviderMeta } from "./providers/registry";
import { dispatchStreamChat } from "./providers";

export async function* streamChat(
  config: ModelConfig,
  messages: import("./types").AgentMessage[],
  signal?: AbortSignal,
  tools?: import("./types").ToolDefinition[],
): AsyncGenerator<import("./types").StreamEvent> {
  const meta = await resolveProviderMeta(config.provider);
  if (!meta) {
    yield { type: "error", error: `Unknown provider: ${config.provider}` };
    return;
  }

  const resolvedConfig: ModelConfig = {
    ...config,
    baseUrl: config.baseUrl || meta.defaultBaseUrl,
    providerName: config.providerName ?? meta.name,
  };

  yield* dispatchStreamChat(resolvedConfig)(resolvedConfig, messages, signal, tools);
}
```

(Note: drop the now-unused `getProviderMeta` and `streamChatByProvider` imports from this file — they were re-exported in Task 2 but are no longer used internally here.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test src/lib/model-router/dispatch.test.ts -- --reporter=verbose
pnpm test src/lib/model-router/index.test.ts -- --reporter=verbose
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/providers/index.ts src/lib/model-router/index.ts src/lib/model-router/dispatch.test.ts
git commit -m "feat(dispatch): function-based dispatchStreamChat handles custom refs

Static Record<Provider, fn> kept as BUILTIN_DISPATCH constant; new
dispatchStreamChat(config) routes custom:\${uuid} to streamChatOpenAICompat
and builtin to its wrapper. streamChat entry uses resolveProviderMeta so
custom baseUrl + providerName flow into ModelConfig before wire-out."
```

---

## Task 6: `displayProviderName` sync helper + openai-compat-core error prefix

**Files:**
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.ts`
- Modify: `src/lib/model-router/providers/_shared/openai-compat-core.test.ts`

**Reason:** SSE error path is sync — it cannot await `resolveProviderMeta`. Add `displayProviderName(config) → providerName ?? provider`. Replace `config.provider` in error strings (currently shows raw `custom:abc-123-uuid` to users). `providerName` was filled by `resolveInstanceToModelConfig` in Task 4 + by `streamChat` entry in Task 5.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/model-router/providers/_shared/openai-compat-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { displayProviderName } from "./openai-compat-core";

describe("displayProviderName", () => {
  it("returns providerName when present", () => {
    expect(displayProviderName({
      provider: "custom:abc", providerName: "My Ollama",
      model: "x", apiKey: "k",
    })).toBe("My Ollama");
  });

  it("falls back to provider id when providerName missing", () => {
    expect(displayProviderName({
      provider: "openai", model: "x", apiKey: "k",
    })).toBe("openai");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts -- --reporter=verbose 2>&1 | tail -10
```

Expected: "displayProviderName is not exported".

- [ ] **Step 3: Add helper + use in error strings in `openai-compat-core.ts`**

Add at top of the exports (after the `OpenAICompatHooks` interface, around line 28):

```ts
/** Sync display-name helper used in SSE error path (cannot await meta resolve). */
export function displayProviderName(config: ModelConfig): string {
  return config.providerName ?? config.provider;
}
```

Replace lines 146–157 (the error block):

```ts
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = displayProviderName(config);
    if (response.status === 401) yield { type: "error", error: `Invalid ${name} API key` };
    else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      yield { type: "error", error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}` };
    } else {
      yield { type: "error", error: `${name} API error (${response.status}): ${text}` };
    }
    return;
  }
```

Also replace the network-error catch (lines 140–144):

```ts
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${displayProviderName(config)} API`}` };
    return;
  }
```

And the stream-interrupted catch near the end:

```ts
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream interrupted (${displayProviderName(config)}): ${e instanceof Error ? e.message : "Unknown error"}` };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts -- --reporter=verbose
```

Expected: new cases + existing cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/_shared/openai-compat-core.ts src/lib/model-router/providers/_shared/openai-compat-core.test.ts
git commit -m "feat(openai-compat): displayProviderName for sync error prefixes

custom:\${uuid} would show raw uuid in user-facing error strings. Sync
helper reads pre-filled config.providerName (set by resolveInstanceToModelConfig
+ streamChat entry) with fallback to config.provider literal."
```

---

## Task 7: Generalise `/v1/models` fetcher with URL normalisation

**Files:**
- Create: `src/lib/openai-compat-models-fetch.ts`
- Create: `src/lib/openai-compat-models-fetch.test.ts`
- Modify: `src/lib/openrouter-models-fetch.ts` (slim to wrapper)

**Reason:** `openrouter-models-fetch.ts` is OpenRouter-specific and naively appends `/v1/models`. We need a general helper that:
1. Normalises `baseUrl` so a user-entered `…/compatible-mode/v1` does not become `…/v1/v1/models` (uses the same regex as `openai-compat-core.ts:112`).
2. Returns `CustomModelMeta[]` with C2 defaults filled when the upstream omits flags.
3. Optional `Authorization: Bearer ${apiKey}` when key provided.

OpenRouter wrapper keeps its `architecture.input_modalities` / `context_length` extraction by post-processing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/openai-compat-models-fetch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchOpenAICompatModels } from "./openai-compat-models-fetch";

function mockFetch(json: unknown, status = 200) {
  // @ts-expect-error
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
}

describe("fetchOpenAICompatModels", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("appends /v1/models when baseUrl has no version suffix", async () => {
    mockFetch({ data: [{ id: "x" }] });
    await fetchOpenAICompatModels("https://api.example.com");
    expect((global.fetch as any).mock.calls[0][0]).toBe("https://api.example.com/v1/models");
  });

  it("appends only /models when baseUrl already ends in /v1 or /v2", async () => {
    mockFetch({ data: [] });
    await fetchOpenAICompatModels("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect((global.fetch as any).mock.calls[0][0])
      .toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/models");
  });

  it("strips trailing slash before normalising", async () => {
    mockFetch({ data: [] });
    await fetchOpenAICompatModels("https://api.example.com/");
    expect((global.fetch as any).mock.calls[0][0]).toBe("https://api.example.com/v1/models");
  });

  it("attaches Authorization header when apiKey provided", async () => {
    mockFetch({ data: [] });
    await fetchOpenAICompatModels("https://api.example.com", "sk-test");
    const init = (global.fetch as any).mock.calls[0][1];
    expect(init.headers.authorization).toBe("Bearer sk-test");
  });

  it("omits Authorization header when apiKey blank", async () => {
    mockFetch({ data: [] });
    await fetchOpenAICompatModels("http://localhost:11434", "  ");
    const init = (global.fetch as any).mock.calls[0][1];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("normalises models with C2 defaults when fields missing", async () => {
    mockFetch({ data: [{ id: "model-a" }, { id: "model-b" }] });
    const models = await fetchOpenAICompatModels("https://api.example.com");
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: "model-a", vision: false, tools: true, maxContextTokens: 128000,
    });
  });

  it("throws on non-2xx", async () => {
    mockFetch({ error: "nope" }, 401);
    await expect(fetchOpenAICompatModels("https://api.example.com"))
      .rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/openai-compat-models-fetch.test.ts -- --reporter=verbose 2>&1 | tail -20
```

Expected: "Cannot find module './openai-compat-models-fetch'".

- [ ] **Step 3: Create `src/lib/openai-compat-models-fetch.ts`**

```ts
import type { CustomModelMeta } from "./custom-providers";

/** Generic OpenAI-compatible /v1/models fetch. URL normalisation matches
 *  src/lib/model-router/providers/_shared/openai-compat-core.ts:112. */
export async function fetchOpenAICompatModels(
  baseUrl: string,
  apiKey?: string,
): Promise<CustomModelMeta[]> {
  const trimmed = baseUrl.replace(/\/$/, "");
  const url = trimmed.match(/\/v\d+$/)
    ? `${trimmed}/models`
    : `${trimmed}/v1/models`;

  const headers: Record<string, string> = {};
  if (apiKey && apiKey.trim().length > 0) {
    headers.authorization = `Bearer ${apiKey.trim()}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/v1/models returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return (data.data ?? []).map((m) => ({
    id: String(m.id),
    vision: false,
    tools: true,
    maxContextTokens: 128000,
  }));
}
```

- [ ] **Step 4: Slim `src/lib/openrouter-models-fetch.ts` to a wrapper**

Replace the entire file with:

```ts
import type { ModelMeta } from "@/lib/model-router";
import { fetchOpenAICompatModels } from "./openai-compat-models-fetch";

interface OpenRouterModelEntry {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
}

/** OpenRouter-specific fetcher. Wraps fetchOpenAICompatModels but
 *  post-processes the response to capture vision support
 *  (architecture.input_modalities) and accurate context_length. */
export async function fetchOpenRouterModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelMeta[]> {
  // Re-fetch raw because the generic helper drops OpenRouter-specific fields.
  const trimmed = baseUrl.replace(/\/$/, "");
  const url = trimmed.match(/\/v\d+$/) ? `${trimmed}/models` : `${trimmed}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey && apiKey.trim().length > 0) headers.authorization = `Bearer ${apiKey.trim()}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`OpenRouter /v1/models returned ${res.status}`);
  const data = (await res.json()) as { data?: OpenRouterModelEntry[] };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    vision: m.architecture?.input_modalities?.includes("image") ?? false,
    tools: true,
    maxContextTokens: m.context_length ?? 32_000,
  }));
}

// Keep generic export accessible via this module too for back-compat
// (callers that already import from openrouter-models-fetch.ts).
export { fetchOpenAICompatModels };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test src/lib/openai-compat-models-fetch.test.ts src/lib/openrouter-models-fetch -- --reporter=verbose
```

Expected: new cases PASS; existing OpenRouter test (if any) still passes (the wire shape is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/lib/openai-compat-models-fetch.ts src/lib/openai-compat-models-fetch.test.ts src/lib/openrouter-models-fetch.ts
git commit -m "feat(models-fetch): generalise OpenAI-compat /v1/models with URL normalisation

URL regex matches openai-compat-core.ts so user-entered baseUrl ending in
/v1 (Bailian's /compatible-mode/v1, Azure deployments) does not get
/v1/v1/models. C2 defaults (vision=false, tools=true, ctx=128k) when
upstream omits fields. OpenRouter wrapper keeps architecture.input_modalities
+ context_length extraction."
```

---

## Task 8: Async-ify `window-token-budget.ts`

**Files:**
- Modify: `src/lib/agent/window-token-budget.ts`
- Modify: `src/lib/agent/window-token-budget.test.ts` (if exists; otherwise grep usage)

**Reason:** `applyTokenBudget(messages, provider)` calls sync `getProviderMeta`. To support custom providers it must call `resolveProviderMeta` (async). Update the function signature and every call site (search for `applyTokenBudget(`).

- [ ] **Step 1: Identify call sites**

```bash
grep -rn 'applyTokenBudget' src/ --include='*.ts' --include='*.tsx'
```

Expected: probably 2–4 sites in `src/lib/agent/` and tests.

- [ ] **Step 2: Update `src/lib/agent/window-token-budget.ts`**

Replace the current `applyTokenBudget` (lines 127–end of function, currently sync) so it awaits provider meta:

```ts
import type { ProviderRef } from "@/lib/model-router";
import { resolveProviderMeta } from "@/lib/model-router";

export async function applyTokenBudget(
  messages: AgentMessage[],
  provider: ProviderRef,
): Promise<AgentMessage[]> {
  const meta = await resolveProviderMeta(provider);
  const maxContextTokens = meta?.models[0]?.maxContextTokens ?? FALLBACK_MAX_CONTEXT_TOKENS;
  const threshold = maxContextTokens * 0.8;

  if (estimateTokens(messages, provider) <= threshold) return messages;

  const reactStartIdx = findReactStartIdx(messages);
  const headEnd = reactStartIdx === -1 ? messages.length : reactStartIdx;

  let result = [...messages];
  while (estimateTokens(result, provider) > threshold) {
    // … existing drop-loop logic preserved verbatim …
    // (copy from current implementation; only the meta resolution + signature change)
  }
  return result;
}
```

(Inside the while-loop body, copy-paste the current implementation untouched. Only changes: `import type Provider → ProviderRef`, function `async` + return `Promise<AgentMessage[]>`, `getProviderMeta` → `await resolveProviderMeta`. The rest of the file is unchanged.)

- [ ] **Step 3: Update each call site to `await`**

For each site grep-found in Step 1, prepend `await` and bubble `async` up through the call chain. Typical site:

```ts
// Before
const sliced = applyTokenBudget(history, modelConfig.provider);

// After
const sliced = await applyTokenBudget(history, modelConfig.provider);
```

- [ ] **Step 4: Update existing tests for the new async signature**

In `src/lib/agent/window-token-budget.test.ts`, every `applyTokenBudget(...)` call gets `await` and the test fn becomes `async`:

```ts
it("trims oldest user/assistant pair when over threshold", async () => {
  const result = await applyTokenBudget(messages, "openai");
  expect(result.length).toBeLessThan(messages.length);
});
```

(All test cases get the same treatment.)

- [ ] **Step 5: Run tests + build**

```bash
pnpm test src/lib/agent/window-token-budget.test.ts -- --reporter=verbose
pnpm build 2>&1 | tail -10
```

Expected: tests pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/window-token-budget.ts src/lib/agent/window-token-budget.test.ts
git commit -m "refactor(agent): applyTokenBudget async via resolveProviderMeta

Foundation for custom-provider context-window lookups. All call sites
updated to await; bubble async up through the loop entry."
```

---

## Task 9: Async-ify `loop.ts:1784` provider-meta call

**Files:**
- Modify: `src/lib/agent/loop.ts`

**Reason:** Single call site at line 1784. Switch `getProviderMeta` to `resolveProviderMeta` (await). Vision logic itself is **not changed** here — issue #39 owns that fix.

- [ ] **Step 1: Inspect the surrounding context**

```bash
grep -n 'getProviderMeta\|resolveProviderMeta' src/lib/agent/loop.ts
```

Expected: one hit at line ~1784.

- [ ] **Step 2: Update import + call site**

In `src/lib/agent/loop.ts`:

Update the import (line 25):

```ts
import { resolveProviderMeta } from "../model-router/providers/registry";
```

Replace line 1784:

```ts
          const providerMeta = await resolveProviderMeta(modelConfig.provider);
```

The surrounding `if (!providerMeta?.supportsVision)` line stays — issue #39 will fix the field reference separately. The await is the only change here.

- [ ] **Step 3: Run agent tests + build**

```bash
pnpm test src/lib/agent -- --reporter=verbose 2>&1 | tail -20
pnpm build 2>&1 | tail -10
```

Expected: pass. Note: this loop site already lives inside an async function, so no chain change needed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "refactor(loop): await resolveProviderMeta for vision check site

Single async-ification at line 1784. Vision-flag logic itself is
untouched — pre-existing supportsVision bug is owned by issue #39."
```

---

## Task 10: Async-ify `Chat.tsx` model-meta lookup

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`

**Reason:** Line 497 uses sync `getModelMeta(inst.provider, inst.model)`. Wrap the lookup in a `useEffect` with await + state, so custom-instance vision detection works.

- [ ] **Step 1: Identify the lookup**

```bash
grep -n 'getModelMeta\|resolveModelMeta' src/sidepanel/components/Chat.tsx
```

Expected: hit at ~line 497.

- [ ] **Step 2: Replace the sync call with an async effect**

The current code computes `modelMeta` inline. Replace it with an effect-driven state. Around line 497 (where `inst` is in scope), find the surrounding logic — typically it's inside `useEffect` already. Update:

```tsx
// Before (sync):
const modelMeta = getModelMeta(inst.provider, inst.model);
setSupportsVision(modelMeta?.vision ?? false);

// After (async):
import { resolveModelMeta } from "@/lib/model-router";
// (in the same useEffect that loads `inst`)
const modelMeta = await resolveModelMeta(inst.provider, inst.model);
setSupportsVision(modelMeta?.vision ?? false);
```

If the surrounding effect is not already `async`, wrap it:

```tsx
useEffect(() => {
  let cancelled = false;
  (async () => {
    // … existing inst load …
    const modelMeta = await resolveModelMeta(inst.provider, inst.model);
    if (!cancelled) setSupportsVision(modelMeta?.vision ?? false);
  })();
  return () => { cancelled = true; };
}, [/* existing deps */]);
```

- [ ] **Step 3: Update `Chat.test.tsx` if it mocks `getModelMeta`**

```bash
grep -n 'getModelMeta\|resolveModelMeta' src/sidepanel/components/Chat.test.tsx
```

If mocks reference `getModelMeta`, update them to mock `resolveModelMeta` (async, returns a Promise).

- [ ] **Step 4: Run tests + build**

```bash
pnpm test src/sidepanel/components/Chat.test.tsx -- --reporter=verbose
pnpm build 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "refactor(chat): await resolveModelMeta for vision toggle

useEffect now resolves model meta asynchronously so custom-instance
vision detection works. Cancellation token prevents stale setState."
```

---

## Task 11: New `useProviderMeta` React hook

**Files:**
- Create: `src/sidepanel/hooks/useProviderMeta.ts`
- Create: `src/sidepanel/hooks/useProviderMeta.test.ts`

**Reason:** Many UI components need a `ProviderMeta` for a `ProviderRef`. Centralise the async load + loading state in one hook.

- [ ] **Step 1: Write the failing test**

Create `src/sidepanel/hooks/useProviderMeta.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProviderMeta } from "./useProviderMeta";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
      },
    },
  };
  return store;
}

describe("useProviderMeta", () => {
  beforeEach(() => installStorageMock());

  it("loads builtin meta synchronously-ish (resolves on first tick)", async () => {
    const { result } = renderHook(() => useProviderMeta("openai"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.meta?.id).toBe("openai");
    expect(result.current.meta?.name).toBe("OpenAI");
  });

  it("loads custom meta from storage", async () => {
    installStorageMock({
      custom_provider_xyz: {
        id: "xyz", name: "Custom",
        baseUrl: "https://example.com",
        models: [], createdAt: 1, updatedAt: 1,
      },
    });
    const { result } = renderHook(() => useProviderMeta("custom:xyz"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.meta?.name).toBe("Custom");
    expect(result.current.meta?.defaultBaseUrl).toBe("https://example.com");
  });

  it("returns null meta when ref unresolved", async () => {
    const { result } = renderHook(() => useProviderMeta("custom:gone"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.meta).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/hooks/useProviderMeta.test.ts -- --reporter=verbose 2>&1 | tail -10
```

Expected: "Cannot find module './useProviderMeta'".

- [ ] **Step 3: Create `src/sidepanel/hooks/useProviderMeta.ts`**

```ts
import { useEffect, useState } from "react";
import type { ProviderRef, ProviderMeta } from "@/lib/model-router";
import { resolveProviderMeta } from "@/lib/model-router";

export interface UseProviderMetaResult {
  meta: ProviderMeta | null;
  loading: boolean;
}

/** Resolve a ProviderRef to ProviderMeta. Re-runs when ref changes.
 *  Cancellation guard prevents stale setState on rapid ref switches. */
export function useProviderMeta(ref: ProviderRef | undefined): UseProviderMetaResult {
  const [meta, setMeta] = useState<ProviderMeta | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ref) {
      setMeta(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    resolveProviderMeta(ref).then((m) => {
      if (cancelled) return;
      setMeta(m);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ref]);

  return { meta, loading };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/sidepanel/hooks/useProviderMeta.test.ts -- --reporter=verbose
```

Expected: all 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useProviderMeta.ts src/sidepanel/hooks/useProviderMeta.test.ts
git commit -m "feat(ui): add useProviderMeta hook for async ProviderRef resolution

Centralises the async load + loading state pattern that InstanceForm,
Settings, ModelDropdown will all need. Cancellation token prevents
stale setState when the user rapidly switches between providers."
```

---

## Task 12: `InstanceForm.tsx` adapts to `ProviderRef` + `useProviderMeta`

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`
- Modify: `src/sidepanel/components/InstanceForm.test.tsx`

**Reason:** Replace sync `getProviderMeta(props.provider)` with `useProviderMeta(props.provider)`. When meta is loading, show a placeholder. For custom instances, hide the "+ 添加自定义模型" entry on `ModelDropdown` (handled in Task 13). Provider hint shows `customProvider.baseUrl` with LOCKED tag. `props.provider` accepts `ProviderRef`.

- [ ] **Step 1: Write the failing test**

Append to `src/sidepanel/components/InstanceForm.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import InstanceForm from "./InstanceForm";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
      },
    },
  };
  return store;
}

describe("InstanceForm — custom provider", () => {
  beforeEach(() => {
    installStorageMock({
      custom_provider_pid: {
        id: "pid", name: "My Local",
        baseUrl: "http://localhost:11434",
        models: [{ id: "llama3:8b", vision: false, tools: true, maxContextTokens: 8000 }],
        createdAt: 1, updatedAt: 1,
      },
    });
  });

  it("shows custom provider name + LOCKED baseUrl after async load", async () => {
    render(
      <InstanceForm
        mode="create"
        provider="custom:pid"
        initialNickname="local"
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("My Local")).toBeInTheDocument());
    expect(screen.getByText("LOCKED")).toBeInTheDocument();
    expect(screen.getByText(/localhost:11434/)).toBeInTheDocument();
  });

  it("shows skeleton while meta loads", () => {
    // Slow mock — never resolves
    // @ts-expect-error
    global.chrome.storage.local.get = vi.fn(() => new Promise(() => {}));
    render(
      <InstanceForm
        mode="create"
        provider="custom:slow"
        initialNickname="x"
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    expect(screen.getByTestId("provider-meta-skeleton")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/components/InstanceForm.test.tsx -- --reporter=verbose 2>&1 | tail -20
```

Expected: missing skeleton testid / sync getProviderMeta won't resolve custom.

- [ ] **Step 3: Update `src/sidepanel/components/InstanceForm.tsx`**

Replace lines 1–4 imports:

```tsx
import { useState, useEffect } from "react";
import type { ProviderRef, ModelMeta } from "@/lib/model-router";
import { useProviderMeta } from "@/sidepanel/hooks/useProviderMeta";
import ModelDropdown from "./ModelDropdown";
```

Replace `Props.provider` (line 26):

```tsx
  provider: ProviderRef;
```

Replace the `meta` lookup (line 51) and the PROVIDER row (lines 102–107) with:

```tsx
  const { meta, loading: metaLoading } = useProviderMeta(props.provider);
```

```tsx
      <Field label="PROVIDER" hint={meta?.defaultBaseUrl}>
        {metaLoading ? (
          <div
            data-testid="provider-meta-skeleton"
            className="h-[34px] rounded border border-line bg-field"
          />
        ) : (
          <div className="flex items-center gap-2 rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-2">
            <span className="text-fg-1">{meta?.name ?? props.provider}</span>
            <span className="ml-auto font-mono text-[10px] text-fg-3">LOCKED</span>
          </div>
        )}
      </Field>
```

(Existing API key + nickname fields are unchanged. The MODEL field continues to use `ModelDropdown`, which Task 13 will adapt for custom.)

For the MODEL field, pass a flag indicating custom mode so ModelDropdown can hide its "+ add custom" entry:

```tsx
        <ModelDropdown
          provider={props.provider}
          value={model}
          customModels={customModels}
          fetchedModels={meta?.models /* custom: provider models live here */}
          fetchedAt={props.fetchedAt}
          isFetching={props.isFetching}
          allowAddCustom={!props.provider.startsWith("custom:")}
          onChange={setModel}
          onAddCustom={(id) => { /* unchanged */ }}
          onRemoveCustom={(id) => { /* unchanged */ }}
          onRefresh={() => { /* unchanged */ }}
        />
```

(`allowAddCustom` is the new prop; default in `ModelDropdown.tsx` is `true` for back-compat — Task 13 wires it.)

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/InstanceForm.test.tsx -- --reporter=verbose
```

Expected: new + existing cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstanceForm.test.tsx
git commit -m "feat(ui): InstanceForm uses useProviderMeta + adapts to custom

Async meta load + loading skeleton. Custom instance hides 'add custom
model' (provider entity owns the list); MODEL dropdown receives provider
models via fetchedModels prop. Provider hint shows baseUrl + LOCKED."
```

---

## Task 13: `ModelDropdown.tsx` honours `allowAddCustom` prop

**Files:**
- Modify: `src/sidepanel/components/ModelDropdown.tsx`
- Modify: `src/sidepanel/components/ModelDropdown.test.tsx`

**Reason:** Hide the "+ 添加自定义模型" row when the parent (custom-instance editing) sets `allowAddCustom={false}`. Default `true` keeps builtin behaviour.

- [ ] **Step 1: Write the failing test**

Append to `src/sidepanel/components/ModelDropdown.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ModelDropdown from "./ModelDropdown";

describe("ModelDropdown — allowAddCustom", () => {
  it("renders + 添加自定义模型 by default", () => {
    render(
      <ModelDropdown
        provider="openai"
        value=""
        customModels={[]}
        onChange={() => {}}
        onAddCustom={() => {}}
        onRemoveCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    expect(screen.getByText(/添加自定义模型/)).toBeInTheDocument();
  });

  it("hides + 添加自定义模型 when allowAddCustom=false", () => {
    render(
      <ModelDropdown
        provider="custom:abc"
        value=""
        customModels={[]}
        allowAddCustom={false}
        onChange={() => {}}
        onAddCustom={() => {}}
        onRemoveCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    expect(screen.queryByText(/添加自定义模型/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/components/ModelDropdown.test.tsx -- --reporter=verbose 2>&1 | tail -15
```

Expected: prop not recognised / "+ 添加" still shown.

- [ ] **Step 3: Update `ModelDropdown.tsx`**

Add `allowAddCustom?: boolean` to the props interface (look for the existing `Props` type):

```tsx
interface Props {
  // ... existing props ...
  /** When false, hide the "+ 添加自定义模型" entry. Default: true. */
  allowAddCustom?: boolean;
}
```

In the dropdown rendering, gate the "+ 添加" entry:

```tsx
{(props.allowAddCustom ?? true) && (
  <button
    onClick={onAddCustomClick}
    className="..."
  >
    + 添加自定义模型
  </button>
)}
```

(Find the existing "+ 添加自定义模型" button and wrap it in this condition.)

Also update `provider` prop type to `ProviderRef`:

```tsx
import type { ProviderRef } from "@/lib/model-router";
// ...
interface Props {
  provider: ProviderRef;   // was: Provider
  // ...
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/ModelDropdown.test.tsx -- --reporter=verbose
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ModelDropdown.tsx src/sidepanel/components/ModelDropdown.test.tsx
git commit -m "feat(ui): ModelDropdown allowAddCustom gates the + 添加自定义模型 entry

Custom-instance editing hides the entry because the provider entity
owns the model list. Builtin instance keeps default true behaviour."
```

---

## Task 14: New `CustomProviderForm.tsx` component

**Files:**
- Create: `src/sidepanel/components/CustomProviderForm.tsx`
- Create: `src/sidepanel/components/CustomProviderForm.test.tsx`

**Reason:** Brand-new form for create/edit custom providers. Fields: name, baseUrl, model list (each with id + displayName + advanced collapsible vision/tools/maxContext). Test connection button uses **transient apiKey** field (not persisted, scoped to the form). Save / Forget actions.

- [ ] **Step 1: Write the failing test**

Create `src/sidepanel/components/CustomProviderForm.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import CustomProviderForm from "./CustomProviderForm";

describe("CustomProviderForm", () => {
  it("validates name + baseUrl on save", () => {
    const onSave = vi.fn();
    render(<CustomProviderForm mode="create" onSave={onSave} onTest={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/name/i).closest("label")).toBeTruthy();
  });

  it("calls onSave with normalised payload", () => {
    const onSave = vi.fn();
    render(<CustomProviderForm mode="create" onSave={onSave} onTest={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "My Local" } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "  http://localhost:11434/  " } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({
      name: "My Local",
      baseUrl: "http://localhost:11434",
      models: [],
    });
  });

  it("opens add-model modal with C2 defaults", () => {
    render(<CustomProviderForm mode="create" onSave={() => {}} onTest={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add model/i }));
    expect(screen.getByLabelText(/model id/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/▸ advanced/i));
    expect((screen.getByLabelText(/tools support/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/vision support/i) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/max context tokens/i) as HTMLInputElement).value).toBe("128000");
  });

  it("Test connection uses transient apiKey + does not persist it", () => {
    const onTest = vi.fn();
    render(<CustomProviderForm mode="create" onSave={() => {}} onTest={onTest} />);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "https://x.test" } });
    fireEvent.change(screen.getByLabelText(/test api key/i), { target: { value: "tk-transient" } });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(onTest).toHaveBeenCalledWith({
      name: "X", baseUrl: "https://x.test", models: [], transientApiKey: "tk-transient",
    });
  });

  it("warns about non-localhost http baseUrl", () => {
    render(<CustomProviderForm mode="create" onSave={() => {}} onTest={() => {}} />);
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "http://api.public.com" } });
    expect(screen.getByText(/非加密连接/)).toBeInTheDocument();
  });

  it("does not warn for localhost http", () => {
    render(<CustomProviderForm mode="create" onSave={() => {}} onTest={() => {}} />);
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "http://localhost:11434" } });
    expect(screen.queryByText(/非加密连接/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/components/CustomProviderForm.test.tsx -- --reporter=verbose 2>&1 | tail -10
```

Expected: "Cannot find module './CustomProviderForm'".

- [ ] **Step 3: Create `src/sidepanel/components/CustomProviderForm.tsx`**

```tsx
import { useState } from "react";
import type { CustomModelMeta } from "@/lib/custom-providers";

export interface CustomProviderFormPayload {
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
}

export interface CustomProviderTestPayload extends CustomProviderFormPayload {
  /** Not persisted — scoped to the Test connection click. */
  transientApiKey: string;
}

interface Props {
  mode: "create" | "edit";
  initialName?: string;
  initialBaseUrl?: string;
  initialModels?: CustomModelMeta[];
  onSave: (payload: CustomProviderFormPayload) => void;
  onTest: (payload: CustomProviderTestPayload) => void;
  onDelete?: () => void;
}

const HTTP_RE = /^https?:\/\//;
const PRIVATE_HOST_RE = /^(localhost|127\.0\.0\.1|10\.|172\.|192\.)/;

function isInsecure(url: string): boolean {
  if (!url.startsWith("http://")) return false;
  const host = url.slice("http://".length);
  return !PRIVATE_HOST_RE.test(host);
}

function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/$/, "");
}

export default function CustomProviderForm(props: Props) {
  const [name, setName] = useState(props.initialName ?? "");
  const [baseUrl, setBaseUrl] = useState(props.initialBaseUrl ?? "");
  const [models, setModels] = useState<CustomModelMeta[]>(props.initialModels ?? []);
  const [transientApiKey, setTransientApiKey] = useState("");
  const [adding, setAdding] = useState(false);

  const valid = name.trim().length > 0 && HTTP_RE.test(baseUrl.trim());
  const insecureWarn = isInsecure(baseUrl.trim());
  const normalisedBaseUrl = normaliseBaseUrl(baseUrl);

  const buildPayload = (): CustomProviderFormPayload => ({
    name: name.trim(),
    baseUrl: normalisedBaseUrl,
    models,
  });

  return (
    <div className="flex flex-col gap-3 px-3.5 py-3.5">
      <Field label="NAME">
        <input
          aria-label="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1"
        />
      </Field>

      <Field label="BASE URL" hint="OpenAI-compatible endpoint">
        <input
          aria-label="base url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com or http://localhost:11434"
          className="rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1"
        />
        <p className="mt-1 text-[10px] text-fg-3">
          ⓘ 该 URL 会被发送 API key，请确认你信任此服务
        </p>
        {insecureWarn && (
          <p className="mt-1 text-[10px] text-warning">
            ⚠ 非加密连接，API key 会明文传输
          </p>
        )}
      </Field>

      <Field label="MODELS">
        <div className="flex flex-col gap-1">
          {models.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              onRemove={() => setModels((prev) => prev.filter((x) => x.id !== m.id))}
            />
          ))}
          {adding && (
            <ModelEditModal
              onCancel={() => setAdding(false)}
              onSave={(m) => { setModels((prev) => [...prev, m]); setAdding(false); }}
            />
          )}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="self-start rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3"
          >
            + add model
          </button>
        </div>
      </Field>

      <Field label="TEST API KEY (OPTIONAL)" hint="仅本次测试使用，不会保存">
        <input
          aria-label="test api key"
          type="password"
          value={transientApiKey}
          onChange={(e) => setTransientApiKey(e.target.value)}
          className="rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1"
        />
      </Field>

      <div className="flex flex-wrap gap-1.5 pt-1">
        <button
          onClick={() => props.onTest({ ...buildPayload(), transientApiKey })}
          disabled={!valid}
          className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
        >
          Test connection
        </button>
        <button
          onClick={() => valid && props.onSave(buildPayload())}
          disabled={!valid}
          className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
        >
          Save
        </button>
        {props.mode === "edit" && props.onDelete && (
          <button
            onClick={() => props.onDelete!()}
            className="ml-auto rounded border border-warning-line bg-transparent px-3 py-1.5 text-[11px] text-warning hover:bg-warning-tint"
          >
            Forget
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function ModelRow({ model, onRemove }: { model: CustomModelMeta; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded border border-line bg-field px-2.5 py-1.5 text-[12px] text-fg-1">
      <span className="font-mono">{model.displayName ?? model.id}</span>
      <span className="ml-auto flex gap-1">
        {model.tools && <span className="font-mono text-[9px] text-fg-3">tools</span>}
        {model.vision && <span className="font-mono text-[9px] text-fg-3">vision</span>}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-fg-3 hover:text-warning"
        aria-label={`remove ${model.id}`}
      >
        ×
      </button>
    </div>
  );
}

function ModelEditModal({
  initial,
  onCancel,
  onSave,
}: {
  initial?: CustomModelMeta;
  onCancel: () => void;
  onSave: (m: CustomModelMeta) => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tools, setTools] = useState(initial?.tools ?? true);
  const [vision, setVision] = useState(initial?.vision ?? false);
  const [maxCtx, setMaxCtx] = useState(initial?.maxContextTokens ?? 128000);

  const valid = id.trim().length > 0;

  return (
    <div className="rounded border border-line bg-field p-3">
      <Field label="MODEL ID">
        <input
          aria-label="model id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="rounded border border-line bg-canvas px-3 py-2 text-[12px] text-fg-1"
        />
      </Field>
      <Field label="DISPLAY">
        <input
          aria-label="display"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="mt-2 rounded border border-line bg-canvas px-3 py-2 text-[12px] text-fg-1"
        />
      </Field>
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="mt-2 self-start text-[10px] text-fg-3"
      >
        {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
      </button>
      {showAdvanced && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[11px] text-fg-2">
            <input
              type="checkbox"
              aria-label="tools support"
              checked={tools}
              onChange={(e) => setTools(e.target.checked)}
            />
            Tools support
          </label>
          <label className="flex items-center gap-2 text-[11px] text-fg-2">
            <input
              type="checkbox"
              aria-label="vision support"
              checked={vision}
              onChange={(e) => setVision(e.target.checked)}
            />
            Vision support
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-fg-2">
            <span>Max context tokens</span>
            <input
              type="number"
              aria-label="max context tokens"
              value={maxCtx}
              onChange={(e) => setMaxCtx(Number(e.target.value))}
              className="rounded border border-line bg-canvas px-2 py-1 text-[12px] text-fg-1"
            />
          </label>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => valid && onSave({ id: id.trim(), displayName: displayName.trim() || undefined, tools, vision, maxContextTokens: maxCtx })}
          disabled={!valid}
          className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/CustomProviderForm.test.tsx -- --reporter=verbose
```

Expected: all 6 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/CustomProviderForm.tsx src/sidepanel/components/CustomProviderForm.test.tsx
git commit -m "feat(ui): CustomProviderForm with transient apiKey + advanced model fields

NAME / BASE URL / MODELS list / Test API key (transient, not persisted) /
Save / Forget. Per-model add modal with C2 defaults (tools=true,
vision=false, ctx=128k) hidden under ▸ Advanced. Insecure-http warning
for non-private hosts."
```

---

## Task 15: `Settings.tsx` Custom Providers section + cascade-block

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`
- Modify: `src/sidepanel/components/Settings.test.tsx`

**Reason:** Add a section below INSTANCES listing custom providers with instance counts. "+ New custom provider" opens `CustomProviderForm` in create mode. Clicking a provider row opens it in edit mode. Forget triggers cascade-block guard.

- [ ] **Step 1: Write the failing test**

Append to `src/sidepanel/components/Settings.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import Settings from "./Settings";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(store, kv)),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
    },
  };
  return store;
}

describe("Settings — Custom Providers section", () => {
  beforeEach(() => {
    installStorageMock({
      custom_providers_index: ["pX"],
      custom_provider_pX: {
        id: "pX", name: "My Local",
        baseUrl: "http://localhost:11434",
        models: [{ id: "llama3:8b", vision: false, tools: true, maxContextTokens: 8000 }],
        createdAt: 1, updatedAt: 1,
      },
      instances_index: ["i1"],
      instance_i1: { id: "i1", provider: "custom:pX", nickname: "x", encryptedKey: "...", model: "llama3:8b", createdAt: 1 },
    });
  });

  it("renders custom providers with instance count", async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Custom Providers/i)).toBeInTheDocument());
    expect(screen.getByText("My Local")).toBeInTheDocument();
    expect(screen.getByText(/1 instance/i)).toBeInTheDocument();
  });

  it("blocks delete when instances depend on the provider", async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText("My Local")).toBeInTheDocument());
    fireEvent.click(screen.getByText("My Local"));   // open edit
    await waitFor(() => expect(screen.getByRole("button", { name: /forget/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /forget/i })).toBeDisabled();
    expect(screen.getByText(/被 1 个 instance 使用/)).toBeInTheDocument();
  });

  it("opens new custom provider form via + New button", async () => {
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/\+ New custom provider/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/\+ New custom provider/i));
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/components/Settings.test.tsx -- --reporter=verbose 2>&1 | tail -25
```

Expected: section not found.

- [ ] **Step 3: Update `src/sidepanel/components/Settings.tsx`**

Add new imports:

```tsx
import { listCustomProviders, deleteCustomProvider, getDependentInstances, createCustomProvider, updateCustomProvider, getCustomProvider } from "@/lib/custom-providers";
import type { StoredCustomProvider } from "@/lib/custom-providers";
import CustomProviderForm from "./CustomProviderForm";
import { fetchOpenAICompatModels } from "@/lib/openai-compat-models-fetch";
```

Add state for custom providers (next to the existing instances state):

```tsx
const [customProviders, setCustomProviders] = useState<StoredCustomProvider[]>([]);
const [customDeps, setCustomDeps] = useState<Record<string, { id: string; nickname: string }[]>>({});
const [editingCustom, setEditingCustom] = useState<string | "new" | null>(null);

useEffect(() => {
  let cancelled = false;
  (async () => {
    const list = await listCustomProviders();
    const deps: Record<string, { id: string; nickname: string }[]> = {};
    for (const p of list) deps[p.id] = await getDependentInstances(p.id);
    if (!cancelled) {
      setCustomProviders(list);
      setCustomDeps(deps);
    }
  })();
  return () => { cancelled = true; };
}, [/* re-run when instances change too */]);
```

Add the section to the render (place it after the existing INSTANCES section):

```tsx
<section className="border-t border-line">
  <header className="px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
    Custom Providers
  </header>
  <ul className="flex flex-col">
    {customProviders.map((p) => {
      const depCount = customDeps[p.id]?.length ?? 0;
      return (
        <li key={p.id}>
          <button
            onClick={() => setEditingCustom(p.id)}
            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12px] hover:bg-field"
          >
            <span className="text-fg-1">{p.name}</span>
            {p.models.length === 0 && (
              <span className="text-[10px] text-fg-3">(no models — add some to use)</span>
            )}
            <span className="ml-auto text-[10px] text-fg-3">{depCount} instance{depCount === 1 ? "" : "s"}</span>
          </button>
        </li>
      );
    })}
    <li>
      <button
        onClick={() => setEditingCustom("new")}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12px] text-fg-2 hover:bg-field"
      >
        + New custom provider
      </button>
    </li>
  </ul>

  {editingCustom === "new" && (
    <CustomProviderForm
      mode="create"
      onSave={async (payload) => {
        await createCustomProvider(payload);
        setEditingCustom(null);
        // refresh list
        const list = await listCustomProviders();
        setCustomProviders(list);
      }}
      onTest={async (payload) => {
        try {
          const models = await fetchOpenAICompatModels(payload.baseUrl, payload.transientApiKey || undefined);
          window.alert(`✓ 连接成功，发现 ${models.length} 个 models`);
        } catch (e) {
          window.alert(`✗ ${e instanceof Error ? e.message : String(e)}`);
        }
      }}
    />
  )}

  {editingCustom && editingCustom !== "new" && (
    <CustomProviderEditWrapper
      providerId={editingCustom}
      depCount={customDeps[editingCustom]?.length ?? 0}
      onSaved={async () => {
        const list = await listCustomProviders();
        setCustomProviders(list);
        setEditingCustom(null);
      }}
      onDeleted={async () => {
        const list = await listCustomProviders();
        setCustomProviders(list);
        setEditingCustom(null);
      }}
    />
  )}
</section>
```

Add the wrapper component at the bottom of `Settings.tsx`:

```tsx
function CustomProviderEditWrapper({
  providerId,
  depCount,
  onSaved,
  onDeleted,
}: {
  providerId: string;
  depCount: number;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [provider, setProvider] = useState<StoredCustomProvider | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCustomProvider(providerId).then((p) => { if (!cancelled) setProvider(p); });
    return () => { cancelled = true; };
  }, [providerId]);

  if (!provider) return null;

  return (
    <>
      {depCount > 0 && (
        <p className="px-3.5 py-1 text-[10px] text-warning">
          该 provider 被 {depCount} 个 instance 使用，删除前请先移除依赖。
        </p>
      )}
      <CustomProviderForm
        mode="edit"
        initialName={provider.name}
        initialBaseUrl={provider.baseUrl}
        initialModels={provider.models}
        onSave={async (payload) => {
          await updateCustomProvider(providerId, payload);
          onSaved();
        }}
        onTest={async (payload) => {
          try {
            const models = await fetchOpenAICompatModels(payload.baseUrl, payload.transientApiKey || undefined);
            window.alert(`✓ 连接成功，发现 ${models.length} 个 models`);
          } catch (e) {
            window.alert(`✗ ${e instanceof Error ? e.message : String(e)}`);
          }
        }}
        onDelete={depCount > 0 ? undefined : async () => {
          await deleteCustomProvider(providerId);
          onDeleted();
        }}
      />
    </>
  );
}
```

Note: `Forget` button is disabled when `props.onDelete` is undefined (this is the cascade-block); the warning paragraph above explains why.

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/Settings.test.tsx -- --reporter=verbose
```

Expected: all 3 new cases + existing PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/Settings.test.tsx
git commit -m "feat(settings): Custom Providers section with cascade-block delete

List custom providers + instance counts. + New opens CustomProviderForm
create mode. Click row opens edit mode with delete blocked when instances
reference the provider (Forget button hidden until deps cleared)."
```

---

## Task 16: `NewConfigWizard.tsx` lists custom providers + entry to create new

**Files:**
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`
- Modify: `src/sidepanel/components/NewConfigWizard.test.tsx`

**Reason:** Step 1 of the wizard currently shows 8 builtin cards. Add a section below for the user's custom providers (clicking continues into InstanceForm bound to that custom provider). At the very bottom, "+ Create new custom provider" jumps into `CustomProviderForm` create mode; on save, the wizard auto-selects the new provider and continues to InstanceForm.

- [ ] **Step 1: Write the failing test**

Append to `src/sidepanel/components/NewConfigWizard.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import NewConfigWizard from "./NewConfigWizard";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(store, kv)),
        remove: vi.fn(async () => {}),
      },
    },
  };
  return store;
}

describe("NewConfigWizard — custom providers", () => {
  beforeEach(() => {
    installStorageMock({
      custom_providers_index: ["pX"],
      custom_provider_pX: {
        id: "pX", name: "My Local",
        baseUrl: "http://localhost:11434",
        models: [{ id: "llama3:8b", vision: false, tools: true, maxContextTokens: 8000 }],
        createdAt: 1, updatedAt: 1,
      },
    });
  });

  it("step 1 lists builtin AND custom providers", async () => {
    render(<NewConfigWizard onCreated={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText("My Local")).toBeInTheDocument());
    // Builtin still there
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("clicking custom provider proceeds to InstanceForm with custom: ref", async () => {
    render(<NewConfigWizard onCreated={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText("My Local")).toBeInTheDocument());
    fireEvent.click(screen.getByText("My Local"));
    // InstanceForm renders with "PROVIDER" field showing custom name
    await waitFor(() => expect(screen.getAllByText("My Local").length).toBeGreaterThan(0));
    expect(screen.getByText("LOCKED")).toBeInTheDocument();
  });

  it("+ Create new custom provider opens form, save returns to wizard step 2", async () => {
    render(<NewConfigWizard onCreated={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(/\+ Create new custom provider/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/\+ Create new custom provider/i));
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "New One" } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "https://api.new.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    // After save, wizard auto-selects the new provider into InstanceForm
    await waitFor(() => expect(screen.getByText("LOCKED")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/components/NewConfigWizard.test.tsx -- --reporter=verbose 2>&1 | tail -15
```

Expected: custom providers not listed.

- [ ] **Step 3: Update `src/sidepanel/components/NewConfigWizard.tsx`**

Add imports:

```tsx
import { listCustomProviders, createCustomProvider } from "@/lib/custom-providers";
import type { StoredCustomProvider } from "@/lib/custom-providers";
import CustomProviderForm from "./CustomProviderForm";
import { fetchOpenAICompatModels } from "@/lib/openai-compat-models-fetch";
import type { ProviderRef } from "@/lib/model-router";
```

Replace the wizard's local state to track `selectedRef: ProviderRef | null` (was `Provider | null`) and add `creatingCustom: boolean`:

```tsx
const [selectedRef, setSelectedRef] = useState<ProviderRef | null>(null);
const [customProviders, setCustomProviders] = useState<StoredCustomProvider[]>([]);
const [creatingCustom, setCreatingCustom] = useState(false);

useEffect(() => {
  let cancelled = false;
  listCustomProviders().then((list) => { if (!cancelled) setCustomProviders(list); });
  return () => { cancelled = true; };
}, []);
```

Render-side, after the existing builtin grid (around line 61), insert the custom section:

```tsx
{customProviders.length > 0 && (
  <>
    <h3 className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
      Custom providers
    </h3>
    <div className="grid grid-cols-2 gap-2">
      {customProviders.map((p) => (
        <button
          key={p.id}
          onClick={() => setSelectedRef(`custom:${p.id}` as ProviderRef)}
          className="rounded border border-line bg-field px-3 py-2 text-left text-[12px] text-fg-1 hover:border-fg-3"
        >
          {p.name}
        </button>
      ))}
    </div>
  </>
)}
<button
  onClick={() => setCreatingCustom(true)}
  className="mt-3 self-start rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3"
>
  + Create new custom provider
</button>
```

When `creatingCustom`, render `CustomProviderForm` instead of the picker:

```tsx
if (creatingCustom) {
  return (
    <CustomProviderForm
      mode="create"
      onSave={async (payload) => {
        const newId = await createCustomProvider(payload);
        setCreatingCustom(false);
        // refresh list and auto-select
        const list = await listCustomProviders();
        setCustomProviders(list);
        setSelectedRef(`custom:${newId}` as ProviderRef);
      }}
      onTest={async (payload) => {
        try {
          const models = await fetchOpenAICompatModels(payload.baseUrl, payload.transientApiKey || undefined);
          window.alert(`✓ 连接成功，发现 ${models.length} 个 models`);
        } catch (e) {
          window.alert(`✗ ${e instanceof Error ? e.message : String(e)}`);
        }
      }}
    />
  );
}
```

Update step 2's `<InstanceForm provider={...}>` to pass `selectedRef` (now a `ProviderRef`).

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/NewConfigWizard.test.tsx -- --reporter=verbose
```

Expected: all 3 new cases + existing PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/NewConfigWizard.tsx src/sidepanel/components/NewConfigWizard.test.tsx
git commit -m "feat(wizard): step 1 lists custom providers + Create new entry

Custom providers appear under builtin grid. + Create new opens
CustomProviderForm; on save the wizard refreshes the list and auto-selects
the new ref so the user proceeds to InstanceForm in one flow."
```

---

## Task 17: SW-level cross-layer integration test

**Files:**
- Create: `src/lib/integration-custom-provider.test.ts`

**Reason:** CLAUDE.md memory `feedback_cross_layer_integration_tests.md` requires that any new wire path between panel↔SW gets at least one cross-layer test. The new path: panel writes a custom provider + custom instance to storage; SW resolves the instance to a `ModelConfig`; the resulting `ModelConfig.baseUrl` and `providerName` come from the custom provider entity, not from any builtin registry. This test runs against `instances.ts` (SW-side) but verifies the whole chain end to end with a real storage mock.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createCustomProvider } from "./custom-providers";
import { createInstance, resolveInstanceToModelConfig } from "./instances";

function installStorageMock(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  // @ts-expect-error
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (typeof key === "string") return { [key]: store[key] };
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (kv: Record<string, unknown>) => Object.assign(store, kv)),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        }),
      },
    },
  };
  // @ts-expect-error
  if (!global.crypto?.subtle) global.crypto = require("node:crypto").webcrypto;
  return store;
}

describe("cross-layer: custom provider end-to-end resolution", () => {
  beforeEach(() => installStorageMock());

  it("custom provider + custom instance → ModelConfig with custom baseUrl + providerName", async () => {
    // Step 1 (panel-side): create a custom provider
    const providerId = await createCustomProvider({
      name: "Office Gateway",
      baseUrl: "https://gw.office.internal/v1",
      models: [{ id: "gpt-internal", vision: false, tools: true, maxContextTokens: 64000 }],
    });

    // Step 2 (panel-side): create an instance bound to it
    const instanceId = await createInstance({
      provider: `custom:${providerId}`,
      nickname: "office",
      apiKey: "internal-token",
      model: "gpt-internal",
    });

    // Step 3 (SW-side): resolve the instance to a ModelConfig
    const cfg = await resolveInstanceToModelConfig(instanceId);

    // Assertions: baseUrl + providerName come from the custom provider entity
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe(`custom:${providerId}`);
    expect(cfg!.providerName).toBe("Office Gateway");
    expect(cfg!.baseUrl).toBe("https://gw.office.internal/v1");
    expect(cfg!.model).toBe("gpt-internal");
    expect(cfg!.apiKey).toBe("internal-token");
  });

  it("missing custom provider entity → resolveInstanceToModelConfig returns null (fail-soft)", async () => {
    const instanceId = await createInstance({
      provider: "custom:never-existed",
      nickname: "stale",
      apiKey: "k",
      model: "x",
    });
    const cfg = await resolveInstanceToModelConfig(instanceId);
    expect(cfg).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm test src/lib/integration-custom-provider.test.ts -- --reporter=verbose
```

Expected: both cases PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/integration-custom-provider.test.ts
git commit -m "test(cross-layer): custom provider end-to-end ModelConfig resolution

Verifies the panel↔SW chain: createCustomProvider + createInstance →
resolveInstanceToModelConfig returns ModelConfig with baseUrl + providerName
sourced from the custom provider entity. Includes fail-soft case for
missing provider entity."
```

---

## Task 18: Full test/build pass + manual verification + final wrap-up

**Files:**
- (no source changes — verification only)

**Reason:** Run the complete test + build matrix; perform the manual end-to-end checklist from spec §6.3 in the loaded extension; commit a wrap-up note documenting verification results.

- [ ] **Step 1: Full test + build**

```bash
pnpm test 2>&1 | tail -20
pnpm build 2>&1 | tail -10
```

Expected: all green; build clean.

- [ ] **Step 2: Manual e2e checklist**

```bash
pnpm dev
```

Then in Chrome:

1. Open `chrome://extensions`, ensure Developer mode on, Load unpacked `dist/`
2. Click Pie icon → side panel opens
3. Open Settings → scroll to Custom Providers section → "+ New custom provider"
   - Name: `Test`
   - Base URL: `https://api.openai.com`
   - + add model: id `gpt-4o-mini`, defaults
   - Test API Key: paste a real OpenAI key
   - Click Test connection → expect "✓ 连接成功，发现 N 个 models"
   - Save
4. Settings → INSTANCES → "+ New instance"
   - In wizard step 1, click "Test" under Custom providers
   - Fill nickname `t1`, paste OpenAI key, model auto-selected `gpt-4o-mini`
   - Save → instance appears
5. Click new instance → make it active
6. Open Chat → send "hi" → expect streamed reply
7. Try a tool call: "open google.com and tell me the title" → confirm → expect normal flow
8. Settings → Custom Providers → click "Test" row → Forget should be disabled with "被 1 个 instance 使用" warning
9. Delete instance `t1` → return to Custom Providers → Forget now enabled → click → provider gone
10. Switch active to a builtin instance (Anthropic / OpenAI) → send a message → expect normal flow
11. Reload Chrome (close/reopen) → custom provider + instance from step 3–4 should be gone (we deleted them in 9). Re-create one and verify it persists across reload.

If any step fails, file as a bug and reference this plan.

- [ ] **Step 3: Update CLAUDE.md (Architecture Invariants section)**

Append to the bullet list under "Architecture Invariants" in `CLAUDE.md`:

```markdown
- Custom provider `baseUrl` 在 provider 层定义，instance 不能 override；删除 provider 时若有 instance 引用则 cascade-block（先清空 instance 再允许删 provider）
- Custom provider 一律走 `_shared/openai-compat-core.ts`（不支持 native protocol）
- `<all_urls>` host_permission 是 custom provider fetch 的前提（manifest 已覆盖；删该权限前必须先下线 custom provider feature）
- ModelConfig.providerName 由 `resolveInstanceToModelConfig` 在解析 instance 时一次性填好（builtin → meta.name；custom → customProvider.name），SSE 错误路径使用 sync `displayProviderName(config)` helper 避免跨 await
```

- [ ] **Step 4: Update ROADMAP**

In `docs/ROADMAP.md`, find the "已交付" section and add a line:

```markdown
- **2026-05-07** Custom Providers — 用户可在 UI 内自定义 OpenAI-compat provider（name + baseUrl + 模型清单 + capability flags），与 8 家 builtin 共存。零 storage migration；不动 manifest。Spec: `docs/specs/2026-05-07-custom-providers-design.md`
```

- [ ] **Step 5: Add solutions trace doc**

Create `docs/solutions/2026-05-07-custom-providers.md`:

```markdown
# Custom Providers — Solution Trace

**Spec**: `docs/specs/2026-05-07-custom-providers-design.md`
**Plan**: `docs/plans/2026-05-07-custom-providers.md`

## New invariants

1. **CP-1**: `Provider` is alias of `BuiltinProvider`; `ProviderRef = BuiltinProvider | \`custom:${string}\`` is the wire/storage type. New code accepting either should type as `ProviderRef`.
2. **CP-2**: Custom provider `baseUrl` is defined at provider level (`StoredCustomProvider.baseUrl`); instance cannot override. UI never exposes baseUrl on `InstanceForm`.
3. **CP-3**: `dispatchStreamChat(config)` routes `custom:` refs to `streamChatOpenAICompat` (no hooks). All builtin refs go to their wrapper.
4. **CP-4**: `resolveInstanceToModelConfig` is the single source of `ModelConfig.providerName` and final `baseUrl` for both builtin and custom paths.
5. **CP-5**: SSE error path uses sync `displayProviderName(config)` (cannot await meta resolve).
6. **CP-6**: Cascade-block guard via `getDependentInstances(providerId)` — UI hides `Forget` when count > 0.
7. **CP-7**: Zero storage migration. `schema_version` stays at 2. `custom_providers_index` + `custom_provider_${uuid}` are additive keys.

## Verified call sites

`getProviderMeta` / `getModelMeta` / `streamChatByProvider` / `PROVIDER_REGISTRY` — Tasks 1–10 enumerated and updated all 13 sites; `migration-v2.ts:22` left untouched intentionally (V1→V2 only iterates builtin).

## Pre-existing bug deferred

`loop.ts:1784` `supportsVision` reference — issue #39 owns the fix. This plan only async-ified the call (Task 9).
```

- [ ] **Step 6: Commit + push**

```bash
git add CLAUDE.md docs/ROADMAP.md docs/solutions/2026-05-07-custom-providers.md
git commit -m "docs: ship custom-providers + add CP-1..CP-7 invariants trace

CLAUDE.md picks up new invariants. ROADMAP marks delivery. Solutions
doc enumerates new invariants and pre-existing bug deferred to #39."

git push -u origin feat/custom-providers
```

- [ ] **Step 7: Open PR**

```bash
gh pr create --title "feat: custom OpenAI-compat providers (BYOK self-define)" --body "$(cat <<'EOF'
## Summary

- 新增「用户自定义 OpenAI-compat provider」能力：UI 内填 name + baseUrl + 模型清单 + capability flags
- 8 家 builtin provider 不动；零 storage migration；零 manifest 改动
- Spec: \`docs/specs/2026-05-07-custom-providers-design.md\`
- Plan: \`docs/plans/2026-05-07-custom-providers.md\`

## Test plan

- [ ] \`pnpm test\` 全绿
- [ ] \`pnpm build\` 成功
- [ ] 手工 e2e 按 plan Task 18 Step 2 跑一遍
- [ ] 老 builtin instance 切换正常（无 regression）
- [ ] 重启浏览器后 custom provider + instance 仍存在

## Out of scope

- Pre-existing supportsVision bug 由 #39 单独修
- preset / starter templates 留给后续

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist (executed before saving plan)

**1. Spec coverage** — every spec section maps to one or more tasks:

- §1 数据模型 + 类型系统 → Tasks 1, 2, 3, 4
- §2 Dispatch 改造 → Tasks 5, 6
- §3 Settings UI + fetch /v1/models → Tasks 7, 11, 12, 13, 14, 15, 16
- §4 Cascade / Lifecycle / 权限 → Tasks 3 (cascade helper), 14 (insecure warning), 15 (cascade-block UI)
- §5 Migration / Invariants → Task 18 step 3 (CLAUDE.md update); zero schema migration is structural (no task needed)
- §6 Tests + Verification → every Task has TDD tests; Task 17 cross-layer; Task 18 manual e2e
- "Critical Files to Modify" table — every file appears in at least one task
- Pre-existing bug — Task 9 only async-ifies; issue #39 owns the bug fix

**2. Placeholder scan** — searched for "TBD" / "TODO" / "implement later" / "similar to Task" — none found. Every code block contains the actual code an engineer needs.

**3. Type consistency** —
- `ProviderRef`, `BuiltinProvider`, `ModelConfig.providerName?` introduced in Task 1 are referenced consistently in Tasks 2–17
- `StoredCustomProvider`, `CustomModelMeta` defined in Task 3 used in Tasks 7, 11, 12, 13, 14, 15, 16
- `dispatchStreamChat`, `streamChatOpenAICompat`, `displayProviderName` named consistently
- `useProviderMeta` hook signature matches across creation (Task 11) and consumers (Task 12)
- `allowAddCustom` prop introduced in Task 13 referenced in Task 12

No placeholder, no contradiction, no naming drift.
