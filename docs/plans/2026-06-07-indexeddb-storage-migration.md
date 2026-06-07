# IndexedDB 存储层迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `chrome.storage.local` 里的全部持久化数据（会话、密钥/实例、skill 开关、各类配置）迁到 IndexedDB，统一维护/销毁入口并摆脱 MV3 的 10 MB 上限。

**Architecture:** 单 IDB database `pie` + 多 object store（`sessions` / `session_index` / `instances` / `config`），跨 store 原子写靠同库事务；跨上下文变更通知靠一条 `BroadcastChannel('pie-store')`；一次性静默 V2→V3 sweep 在既有迁移之后把旧 key 搬进 IDB 再清空。移除写入压力触发的 LRU 自动归档，保留 30 天过期 + 手动软/硬删 + 手动归档/恢复。

**Tech Stack:** TypeScript 6, IndexedDB, BroadcastChannel, vitest + happy-dom, `fake-indexeddb`（新增 dev 依赖）。

设计 spec：`docs/specs/2026-06-07-indexeddb-storage-migration.md`

---

## File Structure

**新增：**
- `src/lib/idb/db.ts` — 单 `pie` database 的 `openDb`（多 store + 版本化 onupgradeneeded）+ 通用 `tx` / `txMulti` 事务助手。所有 store 模块共享。
- `src/lib/idb/config-store.ts` — `config` store 的 `getConfig` / `setConfig` / `removeConfig` / `getAllConfig`，写后 `publishChange`。
- `src/lib/store-bus.ts` — `BroadcastChannel('pie-store')` 封装：`publishChange` / `onStoreChange`，BroadcastChannel 不可用时 noop。
- `src/sidepanel/hooks/useStoreChange.ts` — React hook，订阅某 store 的变更。
- `src/lib/migration-v3.ts` — V2→V3 sweep（chrome.storage.local → IDB）。
- 测试：每个新模块配套 `*.test.ts`。

**改造（保持公共 API 不变，只换底层）：**
- `src/lib/sessions/storage.ts` — `writeAtomic` / `readIndex` / `getSessionMeta` / `getSessionAgent` / `setSessionMeta` / `setSessionAgent` / `getTotalBytes` 等改走 IDB；移除 `setSessionAgent` 的 quota guard。
- `src/lib/sessions/lifecycle.ts` — archive/unarchive/hardDelete/hardDeleteExpired 改走 IDB；删除 `QUOTA_BYTES` / `checkAndArchiveLRU` / `MAX_LRU_ARCHIVE_PER_CALL`。
- `src/lib/crypto.ts` — `encryption_key` 改走 `config-store`。
- `src/lib/instances.ts` — `instance_${id}` → `instances` store；`instances_index` / `active_instance_id` → `config`。
- `src/lib/provider-custom-models.ts` / `provider-custom-model-meta.ts` / `custom-providers.ts` / `search-provider/storage.ts` / `last-model-selection.ts` / `cdp-input-enabled.ts` / `i18n/locale-resolver.ts` / `skills/storage.ts` — 各自的 key → `config-store`。
- `src/sidepanel/components/SessionDrawer.tsx` — `StorageIndicator` 改 estimate() + `useStoreChange`，移除 8MB 预算/告警。
- `src/sidepanel/App.tsx` / `src/sidepanel/components/Chat.tsx` / 其余 `onChanged` 订阅点 — 改 `useStoreChange`。
- `manifest.json` — **不改**（D3 不加 unlimitedStorage）。

**约定：** 所有 store 名常量集中在 `src/lib/idb/db.ts` 导出，避免散落字符串。

---

## 前置：分支

在 main 上不直接提交。执行前用 `superpowers:using-git-worktrees` 建隔离 worktree（建议分支名 `feat/indexeddb-storage-migration`）。后续所有 commit 在该 worktree。

---

## Task 1: 测试用 IndexedDB 后端

**Files:**
- Modify: `package.json`（devDependencies）
- Modify: `vitest.config.ts` 或测试 setup 文件（确认/新增）
- Create: `src/lib/idb/__tests__/idb-available.test.ts`

- [ ] **Step 1: 写失败测试，验证测试环境有可用的 indexedDB**

```ts
// src/lib/idb/__tests__/idb-available.test.ts
import { describe, it, expect } from "vitest";

describe("test env IndexedDB", () => {
  it("exposes a working indexedDB global", async () => {
    expect(typeof indexedDB).toBe("object");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("pie-test-probe", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("s", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(db.objectStoreNames.contains("s")).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（happy-dom 默认无 IDB）**

Run: `pnpm test src/lib/idb/__tests__/idb-available.test.ts`
Expected: FAIL（`indexedDB is not defined` 或 open 报错）

- [ ] **Step 3: 装 fake-indexeddb 并在测试 setup 注入**

```bash
pnpm add -D fake-indexeddb
```

确认 vitest 配置的 setup 文件（查 `vitest.config.ts` 的 `test.setupFiles`）。若已有 setup 文件，在其顶部加一行；若无，创建 `src/test-setup.ts` 并在 `vitest.config.ts` 注册 `test.setupFiles: ["src/test-setup.ts"]`。

```ts
// 测试 setup 顶部加入（fake-indexeddb 6.x 自动挂到 globalThis）
import "fake-indexeddb/auto";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/idb/__tests__/idb-available.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全量测试确认没破坏既有（fake-indexeddb 注入是全局的）**

Run: `pnpm test`
Expected: 既有测试全绿（若有依赖「无 IDB」的断言，记录下来，多半没有）

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/test-setup.ts src/lib/idb/__tests__/idb-available.test.ts
git commit -m "test: add fake-indexeddb backend for storage migration"
```

---

## Task 2: IDB 基建 `lib/idb/db.ts`

**Files:**
- Create: `src/lib/idb/db.ts`
- Test: `src/lib/idb/__tests__/db.test.ts`

设计：单 database `pie`，4 个 object store。`tx` 跑单 store 事务，`txMulti` 跑跨 store 原子事务（用于会话的 meta+index 原子写）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/idb/__tests__/db.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, tx, txMulti, STORES } from "../db";

beforeEach(async () => {
  // fake-indexeddb 每个测试重置：删库
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("pie");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

describe("openDb", () => {
  it("creates all four object stores", async () => {
    const db = await openDb();
    expect(db.objectStoreNames.contains(STORES.sessions)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.sessionIndex)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.instances)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.config)).toBe(true);
    db.close();
  });
});

describe("tx", () => {
  it("round-trips a record in the config store", async () => {
    await tx(STORES.config, "readwrite", (s) => s.put({ key: "k", value: 1 }));
    const got = await tx<{ key: string; value: number } | undefined>(
      STORES.config, "readonly", (s) => s.get("k"),
    );
    expect(got?.value).toBe(1);
  });
});

describe("txMulti", () => {
  it("writes across two stores atomically in one transaction", async () => {
    await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (stores) => {
      stores[STORES.sessions].put({ id: "s1:meta", value: { title: "x" } });
      stores[STORES.sessionIndex].put({ id: "index", value: [{ id: "s1" }] });
    });
    const meta = await tx<{ id: string; value: { title: string } } | undefined>(
      STORES.sessions, "readonly", (s) => s.get("s1:meta"),
    );
    expect(meta?.value.title).toBe("x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/idb/__tests__/db.test.ts`
Expected: FAIL（`Cannot find module '../db'`）

- [ ] **Step 3: 实现 `db.ts`**

```ts
// src/lib/idb/db.ts
//
// Single IndexedDB database `pie` holding every former chrome.storage.local
// namespace. One database (not one-per-domain) so a single IDB transaction can
// span multiple stores — required to preserve the D9 atomic multi-key write
// invariant (e.g. session meta + index updated together).

export const DB_NAME = "pie";
export const DB_VERSION = 1;

export const STORES = {
  sessions: "sessions",        // keyPath "id": `${sid}:meta` | `${sid}:agent` | `${sid}:archived`
  sessionIndex: "session_index", // keyPath "id": singleton "index"
  instances: "instances",      // keyPath "id": instance uuid
  config: "config",            // keyPath "key": misc single-value keys
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.sessions))
        db.createObjectStore(STORES.sessions, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.sessionIndex))
        db.createObjectStore(STORES.sessionIndex, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.instances))
        db.createObjectStore(STORES.instances, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.config))
        db.createObjectStore(STORES.config, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Single-store transaction. */
export function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let result: T;
        req.onsuccess = () => { result = req.result; };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Multi-store atomic transaction. `fn` issues requests against the provided
 *  store map; the returned promise resolves only when the whole transaction
 *  commits (all-or-nothing). */
export function txMulti(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (map: Record<string, IDBObjectStore>) => void,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const map: Record<string, IDBObjectStore> = {};
        for (const s of stores) map[s] = t.objectStore(s);
        try {
          fn(map);
        } catch (e) {
          try { t.abort(); } catch { /* noop */ }
          reject(e);
          return;
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Test-only: drop the cached db handle + delete the database. */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) { (await dbPromise).close(); dbPromise = null; }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
```

> 注意：`tx` 在 `oncomplete` 才 resolve（而非 `req.onsuccess`），保证写已落盘——这是后续 `publishChange` 时机正确的前提。`output-store.ts` 旧写法在 `req.onsuccess` resolve；新基建统一用 `oncomplete`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/idb/__tests__/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/idb/db.ts src/lib/idb/__tests__/db.test.ts
git commit -m "feat(idb): add single-db foundation with multi-store transactions"
```

---

## Task 3: 变更通知总线 `lib/store-bus.ts`

**Files:**
- Create: `src/lib/store-bus.ts`
- Test: `src/lib/__tests__/store-bus.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/__tests__/store-bus.test.ts
import { describe, it, expect, vi } from "vitest";
import { publishChange, onStoreChange } from "../store-bus";

describe("store-bus", () => {
  it("delivers changes for the subscribed store and filters others", async () => {
    const cb = vi.fn();
    const off = onStoreChange("sessions", cb);
    publishChange("sessions", "put", "s1");
    publishChange("config", "put", "theme-mode");
    // BroadcastChannel delivery is async (microtask/macrotask).
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ store: "sessions", op: "put", id: "s1" });
    off();
  });

  it("stops delivering after unsubscribe", async () => {
    const cb = vi.fn();
    const off = onStoreChange("config", cb);
    off();
    publishChange("config", "remove", "x");
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/__tests__/store-bus.test.ts`
Expected: FAIL（`Cannot find module '../store-bus'`）

- [ ] **Step 3: 实现 `store-bus.ts`**

```ts
// src/lib/store-bus.ts
//
// Cross-context (SW + panel) change notification bus, replacing the lost
// `chrome.storage.local.onChanged` signal after the IndexedDB migration.
// One BroadcastChannel; each store's write path publishes after the IDB
// transaction commits; consumers subscribe per store name.

import type { StoreName } from "./idb/db";

export interface StoreChange {
  store: StoreName;
  op: "put" | "remove" | "clear";
  id?: string;
}

const CHANNEL = "pie-store";

type Bus = {
  post: (c: StoreChange) => void;
  listen: (cb: (c: StoreChange) => void) => () => void;
};

function makeBus(): Bus {
  // happy-dom / some test envs lack BroadcastChannel — degrade to in-process.
  if (typeof BroadcastChannel === "undefined") {
    const listeners = new Set<(c: StoreChange) => void>();
    return {
      post: (c) => listeners.forEach((l) => l(c)),
      listen: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    };
  }
  const ch = new BroadcastChannel(CHANNEL);
  const local = new Set<(c: StoreChange) => void>();
  ch.onmessage = (e: MessageEvent<StoreChange>) => local.forEach((l) => l(e.data));
  return {
    // BroadcastChannel does NOT echo to the sender, so notify local listeners too.
    post: (c) => { ch.postMessage(c); local.forEach((l) => l(c)); },
    listen: (cb) => { local.add(cb); return () => local.delete(cb); },
  };
}

const bus = makeBus();

export function publishChange(store: StoreName, op: StoreChange["op"], id?: string): void {
  bus.post({ store, op, id });
}

export function onStoreChange(store: StoreName, cb: (c: StoreChange) => void): () => void {
  return bus.listen((c) => { if (c.store === store) cb(c); });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/__tests__/store-bus.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/store-bus.ts src/lib/__tests__/store-bus.test.ts
git commit -m "feat(store-bus): add BroadcastChannel change notification bus"
```

---

## Task 4: config store `lib/idb/config-store.ts`

**Files:**
- Create: `src/lib/idb/config-store.ts`
- Test: `src/lib/idb/__tests__/config-store.test.ts`

config store 记录形状：`{ key: string, value: unknown }`。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/idb/__tests__/config-store.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getConfig, setConfig, removeConfig, getAllConfig } from "../config-store";
import { _resetForTests } from "../db";

beforeEach(async () => { await _resetForTests(); });

describe("config-store", () => {
  it("set then get round-trips", async () => {
    await setConfig("theme-mode", "dark");
    expect(await getConfig<string>("theme-mode")).toBe("dark");
  });

  it("get returns undefined for missing key", async () => {
    expect(await getConfig("nope")).toBeUndefined();
  });

  it("remove deletes the key", async () => {
    await setConfig("x", 1);
    await removeConfig("x");
    expect(await getConfig("x")).toBeUndefined();
  });

  it("getAllConfig returns a key→value map", async () => {
    await setConfig("a", 1);
    await setConfig("b", 2);
    expect(await getAllConfig()).toEqual({ a: 1, b: 2 });
  });

  it("setConfig publishes a config change", async () => {
    const { onStoreChange } = await import("../../store-bus");
    const cb = vi.fn();
    const off = onStoreChange("config", cb);
    await setConfig("k", 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ store: "config", op: "put", id: "k" }));
    off();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/idb/__tests__/config-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `config-store.ts`**

```ts
// src/lib/idb/config-store.ts
//
// Key→value store over the `config` object store. Replaces the long tail of
// single-value chrome.storage.local keys (theme, locale, encryption_key,
// instances_index, active_instance_id, last_model_selection, pcm_*/pcmm_*,
// custom providers, search provider, cdp-input-enabled, schema_version, …).

import { tx, STORES } from "./db";
import { publishChange } from "../store-bus";

interface ConfigRecord { key: string; value: unknown; }

export async function getConfig<T>(key: string): Promise<T | undefined> {
  const rec = await tx<ConfigRecord | undefined>(
    STORES.config, "readonly", (s) => s.get(key),
  );
  return rec === undefined ? undefined : (rec.value as T);
}

export async function setConfig(key: string, value: unknown): Promise<void> {
  await tx(STORES.config, "readwrite", (s) => s.put({ key, value }));
  publishChange("config", "put", key);
}

export async function removeConfig(key: string): Promise<void> {
  await tx(STORES.config, "readwrite", (s) => s.delete(key));
  publishChange("config", "remove", key);
}

export async function getAllConfig(): Promise<Record<string, unknown>> {
  const all = await tx<ConfigRecord[]>(STORES.config, "readonly", (s) => s.getAll());
  const out: Record<string, unknown> = {};
  for (const r of all) out[r.key] = r.value;
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/idb/__tests__/config-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/idb/config-store.ts src/lib/idb/__tests__/config-store.test.ts
git commit -m "feat(idb): add config key-value store"
```

---

## Task 5: 会话 store `lib/idb/sessions-store.ts`（底层读写）

**Files:**
- Create: `src/lib/idb/sessions-store.ts`
- Test: `src/lib/idb/__tests__/sessions-store.test.ts`

把会话三类记录（meta/agent/archived）与 index 的底层 IDB 读写收进一个模块，供 `sessions/storage.ts` 与 `lifecycle.ts` 调用。记录形状：`sessions` store `{ id: string, value: unknown }`（id 用 `${sid}:meta` 等）；`session_index` store `{ id: "index", value: SessionIndexEntry[] }`。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/idb/__tests__/sessions-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  putSessionRecord, getSessionRecord, removeSessionRecord,
  getIndex, writeSessionBatch,
} from "../sessions-store";
import { _resetForTests } from "../db";

beforeEach(async () => { await _resetForTests(); });

describe("sessions-store", () => {
  it("put/get/remove a session record", async () => {
    await putSessionRecord("s1:meta", { title: "hi" });
    expect(await getSessionRecord<{ title: string }>("s1:meta")).toEqual({ title: "hi" });
    await removeSessionRecord("s1:meta");
    expect(await getSessionRecord("s1:meta")).toBeUndefined();
  });

  it("getIndex defaults to empty array", async () => {
    expect(await getIndex()).toEqual([]);
  });

  it("writeSessionBatch writes records + index atomically; undefined removes", async () => {
    await putSessionRecord("s1:agent", { stepIndex: 3 });
    await writeSessionBatch({
      records: { "s1:meta": { title: "x" }, "s1:agent": undefined },
      index: [{ id: "s1", title: "x", status: "active", lastAccessedAt: 1 } as any],
    });
    expect(await getSessionRecord<{ title: string }>("s1:meta")).toEqual({ title: "x" });
    expect(await getSessionRecord("s1:agent")).toBeUndefined();
    expect(await getIndex()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/idb/__tests__/sessions-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `sessions-store.ts`**

```ts
// src/lib/idb/sessions-store.ts
//
// Low-level IDB access for session records (meta/agent/archived) + the
// lightweight session index. `writeSessionBatch` is the IDB equivalent of the
// old `writeAtomic` chrome.storage.local multi-key set: it writes record puts,
// record removals (value === undefined), and the index in ONE transaction
// spanning the `sessions` + `session_index` stores.

import type { SessionIndexEntry } from "../sessions/types";
import { tx, txMulti, STORES } from "./db";
import { publishChange } from "../store-bus";

const INDEX_ID = "index";
interface Wrapped { id: string; value: unknown; }

export async function getSessionRecord<T>(id: string): Promise<T | undefined> {
  const r = await tx<Wrapped | undefined>(STORES.sessions, "readonly", (s) => s.get(id));
  return r === undefined ? undefined : (r.value as T);
}

export async function putSessionRecord(id: string, value: unknown): Promise<void> {
  await tx(STORES.sessions, "readwrite", (s) => s.put({ id, value }));
  publishChange("sessions", "put", id);
}

export async function removeSessionRecord(id: string): Promise<void> {
  await tx(STORES.sessions, "readwrite", (s) => s.delete(id));
  publishChange("sessions", "remove", id);
}

export async function getIndex(): Promise<SessionIndexEntry[]> {
  const r = await tx<Wrapped | undefined>(STORES.sessionIndex, "readonly", (s) => s.get(INDEX_ID));
  return r === undefined ? [] : (r.value as SessionIndexEntry[]);
}

export interface SessionBatch {
  /** record id → value; `undefined` value removes the record. */
  records?: Record<string, unknown>;
  /** new full index array; omit to leave index untouched. */
  index?: SessionIndexEntry[];
}

export async function writeSessionBatch(batch: SessionBatch): Promise<void> {
  await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (m) => {
    if (batch.records) {
      for (const [id, value] of Object.entries(batch.records)) {
        if (value === undefined) m[STORES.sessions].delete(id);
        else m[STORES.sessions].put({ id, value });
      }
    }
    if (batch.index) m[STORES.sessionIndex].put({ id: INDEX_ID, value: batch.index });
  });
  // One coarse change notification per batch — consumers re-read the index.
  publishChange("sessions", "put");
}

export async function setIndex(index: SessionIndexEntry[]): Promise<void> {
  await writeSessionBatch({ index });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/idb/__tests__/sessions-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/idb/sessions-store.ts src/lib/idb/__tests__/sessions-store.test.ts
git commit -m "feat(idb): add sessions-store low-level access + atomic batch"
```

---

## Task 6: 改造 `sessions/storage.ts` 走 IDB

**Files:**
- Modify: `src/lib/sessions/storage.ts`
- Test: `src/lib/sessions/storage.test.ts`（既有；补充/调整）

目标：公共 API（`getSessionMeta` / `setSessionMeta` / `getSessionAgent` / `setSessionAgent` / `listSessionIndex` / `readIndexRaw` / `getTotalBytes` / `writeAtomic` / `metaKey` 等）签名与行为不变，内部改走 `sessions-store`。`key 字符串`从 `session_${id}_meta` 改为 `${id}:meta`（仅内部 id 命名，外部不感知；迁移 sweep 负责老数据搬家）。

- [ ] **Step 1: 调整既有测试 + 加 getTotalBytes 测试**

先看 `src/lib/sessions/storage.test.ts` 现有断言。把对 `chrome.storage.local` 的直接断言改为对 `sessions-store` / IDB 的断言。新增：

```ts
// 追加到 storage.test.ts
import { _resetForTests } from "@/lib/idb/db";
import { setSessionMeta, getSessionMeta, getTotalBytes } from "./storage";

beforeEach(async () => { await _resetForTests(); });

it("setSessionMeta then getSessionMeta round-trips via IDB", async () => {
  const meta = { id: "s1", title: "t", status: "active", lastAccessedAt: 1, createdAt: 1, messages: [] } as any;
  await setSessionMeta("s1", meta);
  expect((await getSessionMeta("s1"))?.title).toBe("t");
});

it("getTotalBytes returns a non-negative number", async () => {
  const n = await getTotalBytes();
  expect(typeof n).toBe("number");
  expect(n).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/sessions/storage.test.ts`
Expected: FAIL（仍在打 chrome.storage / getTotalBytes 旧实现）

- [ ] **Step 3: 改写 `storage.ts` 内部**

关键改写点（保持导出签名）：

```ts
// 顶部 import
import {
  getSessionRecord, putSessionRecord, removeSessionRecord,
  getIndex, writeSessionBatch, setIndex as setIdbIndex,
} from "@/lib/idb/sessions-store";

// key helpers：改成 IDB 内部 id 形态（导出名不变，供 lifecycle 复用）
export function metaKey(id: string): string { return `${id}:meta`; }
export function agentKey(id: string): string { return `${id}:agent`; }
export function archivedKey(id: string): string { return `${id}:archived`; }

// writeAtomic：把「key→value（undefined 删）」批次翻译成 SessionBatch。
// 约定：INDEX_KEY 对应的值进 batch.index，其余进 batch.records。
export const INDEX_KEY = "session_index"; // 保留导出名，仅作 writeAtomic 的哨兵
export type WriteBatch = Record<string, unknown>;
export async function writeAtomic(batch: WriteBatch): Promise<void> {
  const records: Record<string, unknown> = {};
  let index: SessionIndexEntry[] | undefined;
  for (const [k, v] of Object.entries(batch)) {
    if (k === INDEX_KEY) index = v as SessionIndexEntry[];
    else records[k] = v;
  }
  await writeSessionBatch({ records, ...(index !== undefined && { index }) });
}

// readIndex / readIndexRaw / listSessionIndex：底层改 getIndex()
async function readIndex(): Promise<SessionIndexEntry[]> {
  const raw = await getIndex();
  if (!Array.isArray(raw)) return [];
  return raw.filter(/* 既有的 defensive 过滤逻辑原样保留 */);
}
// readIndexRaw 同样改走 getIndex()（不做 defensive 过滤，原语义）

// getSessionMeta / getSessionAgent：改 getSessionRecord
export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  return (await getSessionRecord<SessionMeta>(metaKey(id))) ?? null;
}
export async function getSessionAgent(id: string): Promise<SessionAgentState | null> {
  return (await getSessionRecord<SessionAgentState>(agentKey(id))) ?? null;
}

// setSessionMeta：改 putSessionRecord + index 维护（沿用既有 index 更新逻辑，
// 但通过 writeAtomic 走 IDB 原子批）

// setSessionAgent：移除「写入前 quota guard / checkAndArchiveLRU」整段（见 Task 7）。

// getTotalBytes：origin 用量估算
export async function getTotalBytes(): Promise<number> {
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    if (typeof usage === "number") return usage;
  }
  // Fallback: sum byteLength of our stores (config + instances + sessions).
  return getStoresByteLength();
}
```

补 `getStoresByteLength()` 私有助手（遍历各 store getAll、`JSON.stringify(...).length` 求和）。`setSessionMeta` / `setSessionAgent` 的 index 维护逻辑照搬现有实现，仅把最终 `chrome.storage.local.set` 换成 `writeAtomic`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/sessions/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessions/storage.ts src/lib/sessions/storage.test.ts
git commit -m "refactor(sessions): route storage.ts reads/writes through IDB"
```

---

## Task 7: 移除 LRU 自动归档

**Files:**
- Modify: `src/lib/sessions/storage.ts`（`setSessionAgent` 的 quota guard 段，若 Task 6 未删净）
- Modify: `src/lib/sessions/lifecycle.ts`（删 `QUOTA_BYTES` / `MAX_LRU_ARCHIVE_PER_CALL` / `checkAndArchiveLRU`）
- Test: `src/lib/sessions/lifecycle.test.ts`（删除 checkAndArchiveLRU 相关用例）

- [ ] **Step 1: 删除 checkAndArchiveLRU 的测试**

在 `lifecycle.test.ts` 找到针对 `checkAndArchiveLRU` 的 describe/it 块，整段删除。同时删 `storage.test.ts` 中验证「setSessionAgent 写入前触发归档」的用例（若有）。

- [ ] **Step 2: 跑测试确认当前红（引用了即将删除的导出）**

Run: `pnpm test src/lib/sessions/lifecycle.test.ts`
Expected: 可能仍 PASS（测试已删）；继续。

- [ ] **Step 3: 删实现**

`lifecycle.ts`：删除 `QUOTA_BYTES`、`MAX_LRU_ARCHIVE_PER_CALL` 两个常量与整个 `checkAndArchiveLRU` 函数（行 49-55 常量段对应项 + 行 268-310）。`storage.ts`：确认 `setSessionAgent` 内不再有 `getBytesInUse` / `checkAndArchiveLRU` 动态 import（Task 6 应已移除，此处兜底检查）。

全仓库搜引用并清理：

Run: `grep -rn "checkAndArchiveLRU\|QUOTA_GUARD_BYTES\|QUOTA_BYTES" src`
Expected: 清理后无匹配（test 与实现均无）

- [ ] **Step 4: 跑测试 + typecheck 确认通过**

Run: `pnpm test src/lib/sessions/ && pnpm typecheck`
Expected: PASS，无 TS 报错

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessions/lifecycle.ts src/lib/sessions/storage.ts src/lib/sessions/lifecycle.test.ts
git commit -m "refactor(sessions): remove storage-pressure LRU auto-archive (unbounded IDB)"
```

---

## Task 8: 改造 `lifecycle.ts` 走 IDB

**Files:**
- Modify: `src/lib/sessions/lifecycle.ts`
- Test: `src/lib/sessions/lifecycle.test.ts`

`lifecycle.ts` 里所有 `chrome.storage.local.get(archivedKey(id))` 改成 `getSessionRecord`。archive/unarchive/hardDelete/hardDeleteExpired 的 `writeAtomic` 调用已自动走 IDB（Task 6 已让 `writeAtomic` 走 IDB），无需改这些函数体——只改它们里的**直接 `chrome.storage.local.get` 读取**。

- [ ] **Step 1: 调整测试 setup 用 IDB reset**

```ts
// lifecycle.test.ts 顶部
import { _resetForTests } from "@/lib/idb/db";
beforeEach(async () => { await _resetForTests(); });
```
保留既有 archive/unarchive/hardDeleteExpired 行为断言（行为不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/sessions/lifecycle.test.ts`
Expected: FAIL（仍读 chrome.storage.local 的直接 get）

- [ ] **Step 3: 改 lifecycle.ts 的直接读取**

```ts
// import 增加
import { getSessionRecord } from "@/lib/idb/sessions-store";

// archiveSession 行 93-94 的幂等检查：
const existing = await getSessionRecord(archivedKey(id));
if (existing != null) return;

// unarchiveSession 行 138-139：
const payload = await getSessionRecord<ArchivedSession>(archivedKey(id));
if (!payload) return;

// hardDeleteExpired 行 232-234：批量读 archived 记录
// 旧：chrome.storage.local.get(archiveKeys) → 改为逐个 getSessionRecord
const allArchived: Record<string, ArchivedSession | undefined> = {};
for (const e of archivedEntries) {
  allArchived[archivedKey(e.id)] = await getSessionRecord<ArchivedSession>(archivedKey(e.id));
}
```

`writeAtomic` 调用（archive/unarchive/hardDelete/hardDeleteExpired 末尾）保持原样——它们现在已走 IDB。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/sessions/lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessions/lifecycle.ts src/lib/sessions/lifecycle.test.ts
git commit -m "refactor(sessions): route lifecycle reads through IDB"
```

---

## Task 9: `crypto.ts` 的 encryption_key 走 config store

**Files:**
- Modify: `src/lib/crypto.ts`
- Test: `src/lib/crypto.test.ts`（既有；调整）

- [ ] **Step 1: 调整测试**

```ts
// crypto.test.ts
import { _resetForTests } from "@/lib/idb/db";
beforeEach(async () => { await _resetForTests(); /* 同时重置 crypto.ts 的模块级 keyPromise（见 step 3 暴露的 _resetKeyForTests） */ });

it("getOrCreateEncryptionKey persists the raw key in config store", async () => {
  const { getConfig } = await import("@/lib/idb/config-store");
  await getOrCreateEncryptionKey();
  const raw = await getConfig<number[]>("encryption_key");
  expect(Array.isArray(raw)).toBe(true);
  expect(raw).toHaveLength(32);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/crypto.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 crypto.ts**

```ts
import { getConfig, setConfig } from "@/lib/idb/config-store";

const SESSION_KEY_NAME = "encryption_key";
let keyPromise: Promise<CryptoKey> | null = null;

export async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    try {
      const stored = await getConfig<number[]>(SESSION_KEY_NAME);
      if (stored) {
        const rawKey = new Uint8Array(stored);
        return crypto.subtle.importKey("raw", rawKey, "AES-GCM", true, ["encrypt", "decrypt"] as KeyUsage[]);
      }
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", true, ["encrypt", "decrypt"] as KeyUsage[]);
      const exported = await crypto.subtle.exportKey("raw", key);
      await setConfig(SESSION_KEY_NAME, Array.from(new Uint8Array(exported)));
      return key;
    } catch (e) { keyPromise = null; throw e; }
  })();
  return keyPromise;
}

// 测试专用：重置模块级缓存
export function _resetKeyForTests(): void { keyPromise = null; }
```
`encrypt` / `decrypt` 不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "refactor(crypto): store encryption key in IDB config store"
```

---

## Task 10: `instances.ts` 走 IDB

**Files:**
- Modify: `src/lib/instances.ts`
- Test: `src/lib/instances.test.ts`（既有；调整）

`instance_${id}` → `instances` store；`instances_index` / `active_instance_id` → config。

- [ ] **Step 1: 调整测试 setup + 关键断言**

```ts
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
beforeEach(async () => { await _resetForTests(); _resetKeyForTests(); });
```
保留 create/get/list/delete/update/active 的行为断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/instances.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 instances.ts**

```ts
import { tx, STORES } from "@/lib/idb/db";
import { getConfig, setConfig, removeConfig } from "@/lib/idb/config-store";
import { publishChange } from "@/lib/store-bus";

const INDEX_CONFIG_KEY = "instances_index";
const ACTIVE_CONFIG_KEY = "active_instance_id";

async function readIndex(): Promise<string[]> {
  return ((await getConfig<string[]>(INDEX_CONFIG_KEY)) ?? []).slice();
}

// createInstance：
const idx = await readIndex(); idx.push(id);
await tx(STORES.instances, "readwrite", (s) => s.put(stored));
await setConfig(INDEX_CONFIG_KEY, idx);
publishChange("instances", "put", id);

// getInstance：
const stored = await tx<StoredInstance | undefined>(STORES.instances, "readonly", (s) => s.get(id));

// deleteInstance：
await setConfig(INDEX_CONFIG_KEY, idx.filter(x => x !== id));
await tx(STORES.instances, "readwrite", (s) => s.delete(id));
publishChange("instances", "remove", id);
if ((await getActiveInstance()) === id) {
  if (idx.length > 0) await setActiveInstance(idx[0]!);
  else await removeConfig(ACTIVE_CONFIG_KEY);
}

// setActiveInstance / getActiveInstance：用 setConfig/getConfig(ACTIVE_CONFIG_KEY)
// updateInstance：tx get → 改字段 → tx put + publishChange
```
其余纯逻辑（`resolveModelConfig` / `firstModelForProvider` 等）不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/instances.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "refactor(instances): route instance storage through IDB"
```

---

## Task 11: 杂项 config 模块批量迁移

**Files（逐个改 + 各自既有测试调整）:**
- `src/lib/provider-custom-models.ts`（`pcm_${provider}`）
- `src/lib/provider-custom-model-meta.ts`（`pcmm_${provider}`）
- `src/lib/custom-providers.ts`
- `src/lib/search-provider/storage.ts`
- `src/lib/last-model-selection.ts`
- `src/lib/cdp-input-enabled.ts`
- `src/lib/i18n/locale-resolver.ts`
- `src/lib/skills/storage.ts`（`enabled_skills`）

统一改写配方（每个文件相同模式）：

```ts
// 旧：
const r = await chrome.storage.local.get(KEY);
const v = r[KEY] as T | undefined;
await chrome.storage.local.set({ [KEY]: next });
await chrome.storage.local.remove(KEY);

// 新：
import { getConfig, setConfig, removeConfig } from "@/lib/idb/config-store";
const v = await getConfig<T>(KEY);
await setConfig(KEY, next);
await removeConfig(KEY);
```
key 名常量原样保留（迁移 sweep 按这些名字搬家）。

- [ ] **Step 1: 逐文件改写**（每文件一个 commit，循环以下步骤）

对每个文件：先把其测试的 setup 改为 `await _resetForTests()`（import 自 `@/lib/idb/db`），把直接断言 `chrome.storage.local` 的部分改为断言 `getConfig`。

- [ ] **Step 2: 跑该文件测试确认失败 → 改实现 → 确认通过**

Run（示例）: `pnpm test src/lib/provider-custom-models.test.ts`
Expected: 先 FAIL，改后 PASS

- [ ] **Step 3: 全仓库扫剩余 chrome.storage.local（应只剩 sweep 自身 + 订阅点）**

Run: `grep -rln "chrome.storage.local" src --include=*.ts --include=*.tsx | grep -v ".test."`
Expected: 仅剩 `migration-v2.ts`、各 `migration-*` / `cleanup-migration` 模块（读老数据，Task 12 处理）、`SessionDrawer.tsx` 与订阅点（Task 13/14 处理）

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit（每文件或每小组一次）**

```bash
git add src/lib/provider-custom-models.ts src/lib/provider-custom-models.test.ts
git commit -m "refactor: route provider-custom-models through IDB config store"
# … 其余文件同样逐个提交
```

---

## Task 12: V3 迁移 sweep `lib/migration-v3.ts`

**Files:**
- Create: `src/lib/migration-v3.ts`
- Test: `src/lib/migration-v3.test.ts`
- Modify: 启动编排处（见 Step 6 定位）

逻辑：在既有 chrome.storage 迁移之后运行；把 `chrome.storage.local.get(null)` 的全部 key 分类写进 IDB，成功后 `chrome.storage.local.clear()`，最后写 `config.schema_version = 3`。幂等：`schema_version === 3` 直接 return。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/migration-v3.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { migrateV2toV3 } from "./migration-v3";
import { _resetForTests } from "@/lib/idb/db";
import { getConfig } from "@/lib/idb/config-store";
import { getInstance } from "@/lib/instances";

beforeEach(async () => {
  await _resetForTests();
  await chrome.storage.local.clear();
});

describe("migrateV2toV3", () => {
  it("moves a config key, an instance, and the session index into IDB, then clears chrome.storage", async () => {
    await chrome.storage.local.set({
      "theme-mode": "dark",
      "instances_index": ["i1"],
      "instance_i1": { id: "i1", provider: "openai", nickname: "n", encryptedKey: "x", createdAt: 1 },
      "session_index": [{ id: "s1", title: "t", status: "active", lastAccessedAt: 1 }],
      "session_s1_meta": { id: "s1", title: "t", status: "active", lastAccessedAt: 1, createdAt: 1, messages: [] },
      "session_s1_agent": { agentMessages: [], pendingInstructions: [], stepIndex: 0 },
    });

    await migrateV2toV3();

    expect(await getConfig("theme-mode")).toBe("dark");
    expect(await getConfig("schema_version")).toBe(3);
    const inst = await getInstance("i1"); // decrypt will fail (fake key) but record must exist
    expect(inst === null).toBe(false); // record present
    // chrome.storage fully cleared
    const remaining = await chrome.storage.local.get(null);
    expect(Object.keys(remaining)).toHaveLength(0);
  });

  it("is idempotent: second run is a no-op", async () => {
    await chrome.storage.local.set({ "theme-mode": "light" });
    await migrateV2toV3();
    await chrome.storage.local.set({ "should-not-migrate": 1 }); // pretend leftover
    await migrateV2toV3(); // schema_version already 3 → no-op
    expect((await chrome.storage.local.get("should-not-migrate"))["should-not-migrate"]).toBe(1);
  });
});
```

> 说明：getInstance 解密在测试里会因 key 不真实而抛——测试只断言「记录存在」，可改为直接 `tx(STORES.instances,...).get("i1")` 断言。按需调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/migration-v3.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 migration-v3.ts**

```ts
// src/lib/migration-v3.ts
//
// One-time V2→V3 sweep: chrome.storage.local → IndexedDB. Runs AFTER all
// existing chrome.storage-based migrations (migrate-v2, migration-*,
// cleanup-migration) so it sweeps the final settled state. Idempotent via
// config.schema_version.

import { tx, txMulti, STORES } from "@/lib/idb/db";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import type { SessionIndexEntry } from "@/lib/sessions/types";

const SESSION_RE = /^session_(.+)_(meta|agent|archived)$/;

export async function migrateV2toV3(): Promise<void> {
  if ((await getConfig<number>("schema_version")) === 3) return;

  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all);
  if (keys.length === 0) { await setConfig("schema_version", 3); return; }

  // Partition keys.
  const configEntries: [string, unknown][] = [];
  const instanceEntries: [string, unknown][] = [];
  const sessionRecords: Record<string, unknown> = {};
  let sessionIndex: SessionIndexEntry[] | undefined;

  for (const k of keys) {
    const v = all[k];
    if (k === "session_index") { sessionIndex = v as SessionIndexEntry[]; continue; }
    const m = SESSION_RE.exec(k);
    if (m) { sessionRecords[`${m[1]}:${m[2]}`] = v; continue; }
    if (k.startsWith("instance_")) { instanceEntries.push([k.slice("instance_".length), v]); continue; }
    // everything else → config (instances_index, active_instance_id,
    // encryption_key, last_model_selection, theme-mode, locale, pcm_*, pcmm_*,
    // custom providers, search provider, cdp-input-enabled, schema_version,
    // migration_v2_mapping, …)
    configEntries.push([k, v]);
  }

  // Write instances store.
  await txMulti([STORES.instances], "readwrite", (mp) => {
    for (const [id, value] of instanceEntries) mp[STORES.instances].put({ ...(value as object), id });
  });

  // Write sessions + index in one transaction.
  await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (mp) => {
    for (const [id, value] of Object.entries(sessionRecords)) mp[STORES.sessions].put({ id, value });
    if (sessionIndex !== undefined) mp[STORES.sessionIndex].put({ id: "index", value: sessionIndex });
  });

  // Write config entries.
  await txMulti([STORES.config], "readwrite", (mp) => {
    for (const [key, value] of configEntries) mp[STORES.config].put({ key, value });
  });

  // All writes committed → clear old storage, stamp version.
  await chrome.storage.local.clear();
  await setConfig("schema_version", 3);
}
```

> 注意 instance 记录：旧 `StoredInstance` 自带 `id` 字段，sweep 时 keyPath 用其 `id`。上面 `{ ...value, id }` 中 `id` 来自 key 后缀，与记录内 `id` 一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/migration-v3.test.ts`
Expected: PASS

- [ ] **Step 5: 接入启动编排**

定位现有迁移调用顺序：

Run: `grep -rn "migrateV1toV2\|migrate-v2\|hardDeleteExpired\|migrationCleanup\|cleanup-migration" src/sidepanel/App.tsx src/background/index.ts`

在**所有**既有 chrome.storage 迁移（`migrateV1toV2` 及各 `migration-*`、`cleanup-migration`）`await` 完成之后、任何 IDB store 首次读取之前，插入 `await migrateV2toV3()`。同一处串行 await，保证顺序。

```ts
import { migrateV2toV3 } from "@/lib/migration-v3";
// … existing migrations awaited above …
await migrateV2toV3();
```

- [ ] **Step 6: 跑相关测试 + typecheck**

Run: `pnpm test src/lib/migration-v3.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/migration-v3.ts src/lib/migration-v3.test.ts src/sidepanel/App.tsx
git commit -m "feat(migration): add V2->V3 chrome.storage->IDB sweep"
```

---

## Task 13: StorageIndicator 新行为

**Files:**
- Modify: `src/sidepanel/components/SessionDrawer.tsx`（行 47-50 常量、行 91-178 StorageIndicator）
- Create: `src/sidepanel/hooks/useStoreChange.ts`
- Test: `src/sidepanel/hooks/__tests__/useStoreChange.test.ts`

- [ ] **Step 1: 写 useStoreChange 失败测试**

```ts
// src/sidepanel/hooks/__tests__/useStoreChange.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStoreChange } from "../useStoreChange";
import { publishChange } from "@/lib/store-bus";

describe("useStoreChange", () => {
  it("invokes callback when the subscribed store changes", async () => {
    const cb = vi.fn();
    renderHook(() => useStoreChange("sessions", cb));
    act(() => publishChange("sessions", "put", "s1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/hooks/__tests__/useStoreChange.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 useStoreChange + 改 StorageIndicator**

```ts
// src/sidepanel/hooks/useStoreChange.ts
import { useEffect, useRef } from "react";
import { onStoreChange, type StoreChange } from "@/lib/store-bus";
import type { StoreName } from "@/lib/idb/db";

export function useStoreChange(store: StoreName, cb: (c: StoreChange) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onStoreChange(store, (c) => ref.current(c)), [store]);
}
```

```tsx
// SessionDrawer.tsx — 删除 STORAGE_BUDGET_BYTES / STORAGE_WARN_BYTES 常量。
function StorageIndicator() {
  const t = useT();
  const [usedBytes, setUsedBytes] = useState(0);
  const load = useCallback(async () => { setUsedBytes(await getTotalBytes()); }, []);
  useEffect(() => { void load(); }, [load]);
  useStoreChange("sessions", () => { void load(); });
  useStoreChange("config", () => { void load(); });
  useStoreChange("instances", () => { void load(); });

  const usedMB = usedBytes / (1024 * 1024);
  return (
    <div style={{ marginTop: "auto", padding: "14px 16px", borderTop: "1px solid var(--c-line)" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span aria-label={t("sessions.storage")} style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 500, color: "var(--c-fg-3)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          {t("sessions.storage")}
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 500, color: "var(--c-fg-2)" }}>
          {usedMB.toFixed(1)} MB
        </span>
      </div>
    </div>
  );
}
```
进度条 DOM 与 `sessions.storageUsed` i18n 用法删除（或保留 i18n key 不用）。`getTotalBytes` 仍从 `@/lib/sessions/storage` import（Task 6 已改 estimate）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/hooks/__tests__/useStoreChange.test.ts && pnpm test src/sidepanel/components/SessionDrawer`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useStoreChange.ts src/sidepanel/hooks/__tests__/useStoreChange.test.ts src/sidepanel/components/SessionDrawer.tsx
git commit -m "feat(ui): StorageIndicator shows raw usage via storage estimate + store-bus"
```

---

## Task 14: 替换其余 onChanged 订阅点

**Files:**
- Modify: `src/sidepanel/App.tsx`、`src/sidepanel/components/Chat.tsx`、`src/sidepanel/hooks/useSession/index.ts`、`src/sidepanel/components/Settings.tsx`，以及 `grep` 出的其余 `onChanged` 使用点

- [ ] **Step 1: 定位所有订阅点**

Run: `grep -rn "storage.local.onChanged\|onChanged.addListener" src --include=*.ts --include=*.tsx | grep -v ".test."`
Expected: 列出全部需替换处

- [ ] **Step 2: 逐处替换为 useStoreChange（或非 React 上下文用 onStoreChange）**

替换配方：

```ts
// 旧（React 组件内）：
useEffect(() => {
  const l = () => reload();
  chrome.storage.local.onChanged.addListener(l);
  return () => chrome.storage.local.onChanged.removeListener(l);
}, []);

// 新：按该订阅原本关心的数据选 store 名
useStoreChange("sessions", () => reload());   // 关心会话列表
useStoreChange("config", () => reload());     // 关心 active instance / theme / 等
```
非 React（background/SW）上下文用 `onStoreChange(store, cb)`（来自 `@/lib/store-bus`）。

> 判断 store 名：原 listener 若按 key 前缀过滤（如 `changes["session_index"]`），映射到对应 store；若监听 instance/active/theme 等 → `config`（active_instance_id 在 config）或 `instances`。

- [ ] **Step 3: 全仓库确认无残留 onChanged**

Run: `grep -rn "storage.local.onChanged" src --include=*.ts --include=*.tsx | grep -v ".test."`
Expected: 无匹配

- [ ] **Step 4: 跑相关测试 + typecheck**

Run: `pnpm test src/sidepanel && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel
git commit -m "refactor(ui): replace storage.onChanged subscribers with store-bus"
```

---

## Task 15: 既有迁移模块与遗留测试收尾

**Files:**
- `src/lib/migration-v2.ts` 及各 `migration-*` / `cleanup-migration` / `migrate-instance-model.ts` / `sessions/migration.ts` / `skills/migration-*`
- 各对应测试

策略：这些模块**读老 chrome.storage key**，是 V3 sweep 的上游，**保持操作 chrome.storage.local 不变**（它们在 sweep 前运行）。仅需确认它们的测试在引入 fake-indexeddb 后仍绿。

- [ ] **Step 1: 跑这些模块的测试**

Run: `pnpm test src/lib/migration-v2.test.ts src/lib/skills src/lib/sessions/migration.test.ts`
Expected: PASS（它们仍打 chrome.storage mock）

- [ ] **Step 2: 跑全量测试，修复任何因 fake-indexeddb 全局注入产生的连带失败**

Run: `pnpm test`
Expected: 全绿。逐个修复跨层测试（`src/__tests__/cross-layer/*`）中对存储后端的假设。

- [ ] **Step 3: 全量 typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 均通过

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: green full suite on IDB backend"
```

---

## Task 16: 文档与不变量更新

**Files:**
- Modify: `pie-ai-agent/CLAUDE.md`（Architecture Invariants：新增 IDB 存储层不变量；更新「API keys 存 chrome.storage.local」描述）
- Modify: `docs/ROADMAP.md`（记录本次迁移）
- Create: `docs/solutions/`（可选：落地后的 invariant trace doc）

- [ ] **Step 1: 更新 CLAUDE.md 不变量段**

把「API keys: …存 `chrome.storage.local`」「Session 持久化: storage at-rest…」等描述改为 IDB；新增不变量：单 `pie` database 多 store、跨 store 原子写靠 `txMulti`、变更通知靠 `store-bus`、无 LRU 自动归档、StorageIndicator 显示 origin estimate。

- [ ] **Step 2: 在 ROADMAP 记录交付**

- [ ] **Step 3: Commit**

```bash
git add pie-ai-agent/CLAUDE.md docs/ROADMAP.md docs/solutions
git commit -m "docs: record IDB storage migration invariants"
```

---

## 验收清单（合并前）

- [ ] `grep -rn "chrome.storage.local" src --include=*.ts --include=*.tsx | grep -v ".test."` 仅剩 `migration-v2.ts` 与各既有 `migration-*`/`cleanup-migration` 模块（sweep 上游）。
- [ ] `grep -rn "storage.local.onChanged" src | grep -v ".test."` 无匹配。
- [ ] `grep -rn "checkAndArchiveLRU\|QUOTA_BYTES\|QUOTA_GUARD_BYTES" src` 无匹配。
- [ ] `pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。
- [ ] manifest.json 未新增权限（无 unlimitedStorage）。
- [ ] 真机回归：全新安装 + 从旧版本升级（验证 V3 sweep 把既有会话/实例/配置完整搬入 IDB、API key 仍能解密、会话列表与存储条正常、archive/restore/delete/30天过期正常）。

## 未做（留给后续）

- per-store / per-session 字节明细面板、一键清空某域、清理建议按钮 → **#4 内容管理 issue**（本迁移合并后单独开）。
- `navigator.storage.persist()` 可选增强（无需权限）→ 可在内容管理 issue 一并评估。
