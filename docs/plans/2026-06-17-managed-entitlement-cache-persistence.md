# Managed entitlement 缓存持久化 + SWR 刷新 — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 managed（Pie 官方订阅）模型列表跨 side panel 重开 / SW 重启后仍正确，并在登录/订阅完成那一刻就绪，不再掉回 `default`。

**Architecture:** 双层缓存——保留进程内 `Map` 作同步读取层（现有读取点零侵入），新增 IndexedDB `config` store 作持久后备（key `managed_entitlement_${apiKey}`）。三处写入点（`getEntitlement`/`redeem`/`startManagedLogin`）双写；启动 pipeline 末尾从 IDB 水合内存；ModelPicker 展开 managed 走 SWR（先显缓存、后台刷新），刷新落盘后经 `store-bus` 触发重渲染。

**Tech Stack:** TypeScript · React 19 · IndexedDB（`src/lib/idb`）· `store-bus`（BroadcastChannel + 进程内降级）· vitest + happy-dom + fake-indexeddb。

**Spec:** `docs/specs/2026-06-17-managed-entitlement-cache-persistence.md`

**注意（执行前）：** 先在 worktree 跑 `pnpm install`，否则 `pnpm typecheck` 会因缺 playwright 等 dev 依赖误报（eval/ 路径），非真实回归。所有命令在 worktree 根 `.claude/worktrees/managed-entitlement-cache/` 下运行。

---

## 文件结构

| 文件 | 改动 |
|---|---|
| `src/lib/managed-account.ts` | 新增 `cacheEntitlement`（双写）、`hydrateEntitlementCache`、`_clearEntitlementCacheForTests`；`getEntitlement`/`redeem` 改走双写 |
| `src/lib/managed-account.test.ts` | 新增 `managed-account persistence` describe |
| `src/lib/startup-migrations.ts` | pipeline 末尾新增 Phase 4 水合 |
| `src/lib/startup-migrations.test.ts` | 新建：验证启动后内存缓存被水合 |
| `src/lib/managed-auth.ts` | exchange 带 `?locale=` + 成功后回填缓存 |
| `src/lib/managed-auth.test.ts` | 更新 URL 断言 + 新增回填测试 |
| `src/sidepanel/components/ModelPicker.tsx` | 展开 managed 触发 SWR + 订阅 store-bus 重渲染 |
| `src/sidepanel/components/ModelPicker.test.tsx` | 新增 SWR 触发 + 重渲染测试 |
| `src/sidepanel/components/Chat.tsx` | `onRefreshModels` 加 managed 分支调 `getEntitlement` |

---

## Task 1：managed-account.ts —— 双写 + 水合

**Files:**
- Modify: `src/lib/managed-account.ts`
- Test: `src/lib/managed-account.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/managed-account.test.ts` 顶部 import 行（现为 `import { describe, expect, it, vi } from "vitest";`）改为带 `beforeEach`，并补 import：

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getCachedEntitlement, getEntitlement, openCheckout, openPortal,
  cachedManagedModel, redeem, RedeemError,
  hydrateEntitlementCache, _clearEntitlementCacheForTests,
} from "./managed-account";
import { getConfig, setConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";
```

在文件末尾（最后一个 `});` 之后）追加：

```ts
describe("managed-account persistence", () => {
  beforeEach(async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
  });

  it("getEntitlement 双写：内存 + IDB(config managed_entitlement_<apiKey>)", async () => {
    const ent = { plan: "active", email: "p@x.com", subscription: null, quota: null,
      models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 }] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-persist", { fetchFn, locale: "en" });
    expect(await getConfig("managed_entitlement_sk-persist")).toEqual(res);
  });

  it("hydrateEntitlementCache：IDB → 内存（normalizeEntitlement 归一化残缺结构）", async () => {
    await setConfig("managed_entitlement_sk-hyd", { email: "h@x.com" }); // 残缺/旧结构
    _clearEntitlementCacheForTests();
    expect(getCachedEntitlement("sk-hyd")).toBeNull();
    await hydrateEntitlementCache();
    expect(getCachedEntitlement("sk-hyd")).toEqual({
      plan: "none", email: "h@x.com", subscription: null, quota: null, models: [],
    });
  });

  it("redeem 双写 IDB", async () => {
    const ent = { plan: "active", email: "r@x.com",
      subscription: { planName: "Pie", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" },
      quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    const res = await redeem("sk-rp", "CODE", { fetchFn, locale: "en" });
    expect(await getConfig("managed_entitlement_sk-rp")).toEqual(res);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: FAIL —— `hydrateEntitlementCache` / `_clearEntitlementCacheForTests` 未导出（import error），双写断言 `getConfig` 返回 `undefined`。

- [ ] **Step 3: 实现双写 + 水合**

在 `src/lib/managed-account.ts`：

顶部 import 段（现为 `import { getLocale } from "./i18n";`）之后补一行：

```ts
import { setConfig, getAllConfig } from "./idb/config-store";
```

在 `const entitlementCache = new Map<string, Entitlement>();`（约 `:15`）之后新增：

```ts
const ENTITLEMENT_KEY_PREFIX = "managed_entitlement_";

/** 双写 entitlement：同步写内存 Map（同步读取层用）+ best-effort 持久化到 IDB
 *  config store（key 按 apiKey）。IDB 写失败不影响内存缓存与调用方。供
 *  getEntitlement / redeem / startManagedLogin 三处写入点共用。 */
export async function cacheEntitlement(apiKey: string, ent: Entitlement): Promise<void> {
  entitlementCache.set(apiKey, ent);
  try {
    await setConfig(ENTITLEMENT_KEY_PREFIX + apiKey, ent);
  } catch {
    /* 持久化是 best-effort：IDB 不可用 / 写失败时内存缓存仍生效 */
  }
}

/** 启动时从 IDB config store 把已持久化的 entitlement 灌回内存 Map，使
 *  side panel 重开 / SW 重启后 ModelPicker 首次渲染即拿到真实模型列表。
 *  读失败整体吞掉，绝不阻塞启动。 */
export async function hydrateEntitlementCache(): Promise<void> {
  try {
    const all = await getAllConfig();
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(ENTITLEMENT_KEY_PREFIX)) continue;
      entitlementCache.set(key.slice(ENTITLEMENT_KEY_PREFIX.length), normalizeEntitlement(value));
    }
  } catch {
    /* 水合失败 → 退回内存空（兜底），不抛 */
  }
}

/** Test-only：清空内存 entitlement 缓存，使水合测试能验证「内存空 → 水合 → 命中」。 */
export function _clearEntitlementCacheForTests(): void {
  entitlementCache.clear();
}
```

把 `getEntitlement` 里的 `entitlementCache.set(apiKey, ent);`（约 `:30`）替换为：

```ts
  await cacheEntitlement(apiKey, ent);
```

把 `redeem` 里的 `entitlementCache.set(apiKey, ent);`（约 `:127`）替换为：

```ts
  await cacheEntitlement(apiKey, ent);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: PASS（含原有用例 —— 内存写仍同步生效，断言不变）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): entitlement 缓存双写内存+IDB，新增 hydrateEntitlementCache"
```

---

## Task 2：startup-migrations.ts —— 启动水合

**Files:**
- Modify: `src/lib/startup-migrations.ts`
- Test: `src/lib/startup-migrations.test.ts`（Create）

- [ ] **Step 1: 写失败测试**

新建 `src/lib/startup-migrations.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { runStartupMigrations, _resetStartupMigrationsForTests } from "./startup-migrations";
import { setConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";
import { getCachedEntitlement, _clearEntitlementCacheForTests } from "./managed-account";

describe("runStartupMigrations — entitlement 水合", () => {
  beforeEach(async () => {
    await _resetForTests();
    _resetStartupMigrationsForTests();
    _clearEntitlementCacheForTests();
  });

  it("把持久化的 managed entitlement 灌回内存缓存", async () => {
    await setConfig("managed_entitlement_sk-boot", {
      plan: "active", email: "b@x.com", subscription: null, quota: null,
      models: [{ id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 }],
    });
    _clearEntitlementCacheForTests();
    expect(getCachedEntitlement("sk-boot")).toBeNull();
    await runStartupMigrations();
    expect(getCachedEntitlement("sk-boot")?.email).toBe("b@x.com");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/startup-migrations.test.ts`
Expected: FAIL —— 水合未接入 pipeline，`getCachedEntitlement("sk-boot")` 仍为 `null`。

- [ ] **Step 3: 接入水合**

在 `src/lib/startup-migrations.ts` 顶部 import 段末尾补：

```ts
import { hydrateEntitlementCache } from "@/lib/managed-account";
```

在 `runPipeline()` 末尾（`await migrateScheduleSessionOrigin();` 之后、函数闭合 `}` 之前）追加：

```ts

  // ── Phase 4: 运行时缓存预热（非 migration）。从 config-store 把已持久化的
  // managed entitlement 灌回内存缓存，使重启后 ModelPicker 首屏即有真实列表。
  // 必须在 Phase 2 sweep 之后（config-store 已 populated）；内部吞错，不阻塞。
  await hydrateEntitlementCache();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/startup-migrations.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/startup-migrations.ts src/lib/startup-migrations.test.ts
git commit -m "feat(startup): pipeline 末尾水合 managed entitlement 缓存"
```

---

## Task 3：managed-auth.ts —— 登录回填 + exchange locale

**Files:**
- Modify: `src/lib/managed-auth.ts`
- Test: `src/lib/managed-auth.test.ts`

- [ ] **Step 1: 改写 + 新增失败测试**

在 `src/lib/managed-auth.test.ts`：

顶部 import 改为：

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { startManagedLogin } from "./managed-auth";
import { getCachedEntitlement, _clearEntitlementCacheForTests } from "./managed-account";
import { getConfig } from "./idb/config-store";
import { _resetForTests } from "./idb/db";
```

把现有 "exchanges the code" 测试改为传 locale 并断言带 locale 的 URL —— 即把 `const d = deps();` 改为 `const d = deps({ locale: "en" });`，并把：

```ts
    expect(d.fetchFn).toHaveBeenCalledWith("https://account.pie.chat/auth/exchange", expect.objectContaining({
```

改为：

```ts
    expect(d.fetchFn).toHaveBeenCalledWith("https://account.pie.chat/auth/exchange?locale=en", expect.objectContaining({
```

在 `describe("startManagedLogin", ...)` 内追加新测试：

```ts
  it("登录成功后回填 entitlement 缓存（内存 + IDB）", async () => {
    await _resetForTests();
    _clearEntitlementCacheForTests();
    const res = await startManagedLogin(deps({ locale: "en" }));
    expect(getCachedEntitlement("sk-virtual")).toEqual(res.entitlement);
    expect(await getConfig("managed_entitlement_sk-virtual")).toEqual(res.entitlement);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-auth.test.ts`
Expected: FAIL —— URL 断言不含 `?locale=en`；回填测试中 `getCachedEntitlement` 返回 `null`。

- [ ] **Step 3: 实现回填 + locale**

在 `src/lib/managed-auth.ts`：

把 `import { normalizeEntitlement } from "./managed-account";`（`:2`）改为：

```ts
import { normalizeEntitlement, cacheEntitlement } from "./managed-account";
import { getLocale } from "./i18n";
```

在 `ManagedAuthDeps` interface 内补一个字段：

```ts
  /** exchange 的本地化语言，缺省取当前 UI locale（getLocale()）。 */
  locale?: string;
```

在 `startManagedLogin` 体内，`const fetchFn = deps.fetchFn ?? fetch;` 之后补：

```ts
  const locale = deps.locale ?? getLocale();
```

把 exchange 请求行：

```ts
  const resp = await fetchFn(`${ACCOUNT_BASE}/auth/exchange`, {
```

改为：

```ts
  const resp = await fetchFn(`${ACCOUNT_BASE}/auth/exchange?locale=${encodeURIComponent(locale)}`, {
```

把结尾的 `return { apiKey: ..., entitlement: ... };`（`:78`）替换为：

```ts
  const result = { apiKey: String(json.apiKey ?? ""), entitlement: normalizeEntitlement(json.entitlement) };
  if (result.apiKey) await cacheEntitlement(result.apiKey, result.entitlement);
  return result;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-auth.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/managed-auth.ts src/lib/managed-auth.test.ts
git commit -m "feat(managed): 登录 exchange 带 locale 并回填 entitlement 缓存"
```

---

## Task 4：ModelPicker SWR + store-bus 重渲染 + Chat 分派

**Files:**
- Modify: `src/sidepanel/components/ModelPicker.tsx`
- Modify: `src/sidepanel/components/Chat.tsx:1595`
- Test: `src/sidepanel/components/ModelPicker.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `src/sidepanel/components/ModelPicker.test.tsx`：

把第 1 行 import 补上 `waitFor`：

```ts
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
```

在 `describe("ModelPicker managed rendering", ...)` 内（`managedInsts` 定义之后）追加两个测试：

```ts
  it("展开 managed 触发 onRefreshModels（SWR）", () => {
    const onRefreshModels = vi.fn();
    render(<ModelPicker instances={managedInsts} currentInstanceId="m" currentModel="default" locked={false} onSelect={() => {}} onManage={() => {}} onRefreshModels={onRefreshModels} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByText("Pie 官方订阅"));
    expect(onRefreshModels).toHaveBeenCalledWith("m");
  });

  it("entitlement 缓存更新后经 store-bus 触发重渲染，列表刷新", async () => {
    const cold: DecryptedInstance[] = [{ id: "m2", provider: "managed", nickname: "Pie", apiKey: "sk-rerender", createdAt: 1 }];
    render(<ModelPicker instances={cold} currentInstanceId="m2" currentModel="default" locked={false} onSelect={() => {}} onManage={() => {}} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByText("Pie 官方订阅"));
    expect(screen.queryByText("进阶")).toBeNull(); // 冷启动只有兜底 default
    const ent = { plan: "active", email: "e", subscription: null, quota: null, models: [
      { id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "pro", name: "进阶", description: "更强", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    await getEntitlement("sk-rerender", { fetchFn, locale: "en" }); // 双写 + store-bus publish
    await waitFor(() => expect(screen.getByText("进阶")).toBeTruthy());
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ModelPicker.test.tsx`
Expected: FAIL —— 展开 managed 不调 `onRefreshModels`（现状被 `lazyEmpty=false` 挡掉）；缓存更新后无重渲染，`waitFor` 超时找不到「进阶」。

- [ ] **Step 3: 实现 SWR 触发 + store-bus 订阅**

在 `src/sidepanel/components/ModelPicker.tsx`：

第 3 行附近 import 段补：

```ts
import { onStoreChange } from "@/lib/store-bus";
```

在 `ModelPicker` 组件体内，`const [query, setQuery] = useState("");`（`:103`）之后新增订阅：

```ts
  // managed entitlement 缓存（进程内 Map）更新不会自动触发重渲染；订阅 store-bus
  // 的 config 变更（key 前缀 managed_entitlement_）→ bump 一个版本号触发重读。
  const [, bumpEntVersion] = useState(0);
  useEffect(
    () => onStoreChange("config", (c) => {
      if (c.id?.startsWith("managed_entitlement_")) bumpEntVersion((v) => v + 1);
    }),
    [],
  );
```

把 `toggleProvider`（`:138`）整体替换为：

```ts
  function toggleProvider(inst: DecryptedInstance) {
    const next = expandedId === inst.id ? null : inst.id;
    setExpandedId(next);
    if (!next) return;
    if (inst.provider === "managed") {
      // managed：每次展开都后台 SWR 刷新（先显缓存、不闪烁），覆盖后端阵容变更。
      props.onRefreshModels?.(inst.id);
      return;
    }
    const meta = inst.provider.startsWith(CUSTOM_PREFIX)
      ? undefined
      : getProviderMeta(inst.provider as BuiltinProvider);
    // 前提：唯一 lazy provider（openrouter）没有 endpointVariants，而所有带
    // variant 的 provider 默认 models 非空，所以这里暂不感知 variant。
    const lazyEmpty = (meta?.models.length ?? 0) === 0 && (inst.fetchedModels?.length ?? 0) === 0;
    if (lazyEmpty) props.onRefreshModels?.(inst.id);
  }
```

在 `src/sidepanel/components/Chat.tsx`：

把第 13 行 `import { cachedManagedModel } from "@/lib/managed-account";` 改为：

```ts
import { cachedManagedModel, getEntitlement } from "@/lib/managed-account";
```

把 `onRefreshModels`（`:1595`）的实现改为先处理 managed：

```ts
        onRefreshModels={async (id) => {
          const inst = instances.find((i) => i.id === id);
          if (inst?.provider === "managed") {
            // managed SWR：拉最新 entitlement，cacheEntitlement 双写 + store-bus
            // 通知 ModelPicker 重渲染。失败静默（保留已显缓存）。
            await getEntitlement(inst.apiKey).catch(() => {});
            return;
          }
          if (inst?.provider !== "openrouter") return;
          const orMeta = getProviderMeta("openrouter")!;
          try {
            const fetched = await fetchOpenRouterModels(orMeta.defaultBaseUrl, inst.apiKey || undefined);
            await updateInstance(id, { fetchedModels: fetched, fetchedAt: Date.now() });
            await listInstances().then(setInstances);
          } catch { /* silent; user can retry from Settings */ }
        }}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ModelPicker.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ModelPicker.tsx src/sidepanel/components/ModelPicker.test.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat(managed): ModelPicker 展开 SWR 刷新 + store-bus 重渲染"
```

---

## Task 5：全量验证（verification-before-completion）

**Files:** 无新增改动（仅验证；如有修复则补 commit）。

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: PASS（全绿，无新增失败）。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 0 错。（若报 playwright 缺失等 eval/ 噪声 → 先 `pnpm install` 再重跑。）

- [ ] **Step 3: 生产构建**

Run: `pnpm build`
Expected: 成功产出 `dist/`（build-time invariants 不 throw）。

- [ ] **Step 4: 同步 dist 供真机测试**

Run: `pnpm sync:dist`
然后让用户去 `chrome://extensions` 点刷新，按下方清单真机验证。

**真机验证清单：**
1. 全新登录 managed（已订阅账号）→ 不打开账户面板，直接切回 Composer 点 ModelPicker → 显示真实多模型列表（非 default）。
2. 关闭再打开 side panel → ModelPicker 仍显示真实列表（持久化生效）。
3. 未订阅 → 完成 Stripe 订阅（poll 命中 active）→ 切回 Composer → 列表就绪。
4. 兑换码兑换成 active → 列表就绪。
5. UI 语言切换后登录 → 模型名/描述为对应语言（exchange locale 生效）。
6. 展开 ModelPicker 时后台刷新一次（SWR）；后端阵容变更后下次展开自动更新。

---

## 备注

- **不改** registry `default` 兜底（`registry.ts:339`）——保留作冷启动 + 无网络的最后防线。
- **不动** 同步读取点签名（`ModelPicker.modelsFor` / `instances.ts` / `cachedManagedModel`）。
- Chat 的 managed 分派是一行路由（`getEntitlement` 双写已在 Task 1 测、ModelPicker wiring 已在 Task 4 测），不另加 Chat 单测。
- `cacheEntitlement` 的 IDB 写与 `hydrateEntitlementCache` 均吞错：持久化是 best-effort，绝不阻塞登录/聊天/启动。
