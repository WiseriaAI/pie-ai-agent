# Chrome 标签控制 v1（open_url + multi-pin）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `open_url(url, active=false)` tool and upgrade single pinned tab → `pinnedTabs[]` array so agent can spawn additional tabs without dropping the original pin and sibling sessions share tabs without R7 false positives.

**Architecture:**
- **Schema upgrade with lazy alias** — `SessionMeta.pinnedTabs?: Array<{tabId, origin}>` + `SessionIndexEntry.pinnedTabIds?: number[]` are the new canonical shape; legacy `pinnedTabId/pinnedOrigin` and `pinnedTabId` (index) are kept as **derived alias** (= `pinnedTabs[0]`) for v1, dropped over the next two releases. A normalization helper (`getPinnedTabsFromMeta`) is the single read-time source of truth so call sites never branch on shape.
- **`open_url` is always-high tab tool** with explicit `http:|https:` + non-empty host allow-list + 4096-char hard cap; risk classifier folds the URL into the reason string and the SW dispatcher synthesizes a dedicated confirm payload (URL + origin + active flag), bypassing the existing `tabTargets[]` shape (the target tab does not exist yet).
- **Auto-pin post-handler interception** — loop dispatch detects successful `open_url` tool result, parses created `tabId` from the handler's structured observation, and pushes `{tabId, origin}` into the calling session's `pinnedTabs[]` (writes meta + index in one `writeAtomic`). Cross-session registry refresh on the next iteration picks the new pin up automatically (existing TOCTOU fix).
- **Primary pin = `pinnedTabs[0]`** drives `ctx.pinned`, system prompt's `<pinned_tabs>` block, Phase 2 DOM/keyboard implicit `ctx.tabId`, and per-iteration origin re-check. Secondary pins exist for: agent-side `activate_tab` + tab-tool target with explicit `tabId`, and cross-session R7 lock (union of all sibling pins).

**Tech Stack:** TypeScript 6, Vitest (happy-dom), React 19 + @testing-library/react, Chrome MV3 (`chrome.tabs.create`, `chrome.tabs.query`, existing `<all_urls>` host_permission). No new permissions or dependencies.

---

## File Structure

**Modified:**
- `src/lib/sessions/types.ts` — add `pinnedTabs?: Array<{tabId,origin}>` to `SessionMeta`; add `pinnedTabIds?: number[]` to `SessionIndexEntry`; mark legacy fields deprecated in JSDoc
- `src/lib/sessions/storage.ts` — `indexEntryFromMeta` writes both shapes; `createSession` / `setSessionMeta` normalize via helper; `updateLastAccessed` accepts new shape
- `src/lib/sessions/pinned-tab-registry.ts` — `getActivePinnedTabs` returns flat union (one row per pinned tab, multiple per session ok); `getCrossSessionPinnedTabIds` computes union from `pinnedTabIds[]` with legacy fallback
- `src/lib/agent/tool-names.ts` — append `"open_url"` to `TAB_TOOL_NAMES`; add `open_url: "write"` to `TOOL_CLASSES`
- `src/lib/agent/risk.ts` — append `"open_url"` to `ALWAYS_HIGH_TAB_TOOLS`; add `open_url` branch to `classifyRisk` (always high, URL folded into reason)
- `src/lib/agent/tools/tabs.ts` — add `openUrlTool` to `TAB_TOOLS`; new helper `validateOpenUrlInput`
- `src/lib/agent/loop.ts` — `buildTabTargets` skips `open_url` (no existing tab); new `buildOpenUrlPayload` emits dedicated confirm payload; post-handler auto-pin push for `open_url` success path; `<pinned_tabs>` block via `buildAgentSystemPrompt`
- `src/lib/agent/prompt.ts` — `buildAgentSystemPrompt` accepts `pinnedTabs[]` instead of single `{tabId,origin}`; renders `<pinned_tabs>` with primary marker; describes `open_url` and multi-pin semantics in tab-tools section
- `src/sidepanel/hooks/useSession.ts` — `captureActivePinned` continues returning single primary pin; bootstrap/setActive/backfill normalize via helper; `pinnedOrigin` field reflects `pinnedTabs[0].origin`
- `src/sidepanel/components/AgentConfirmCard.tsx` — new `OpenUrlConfirmRow` component for tool==="open_url"; URL display with ≥1024-char fold; origin row (punycode-correct via `URL.host`); active flag text
- `src/sidepanel/components/SkillsList.tsx` — chip badge "per-call gate" for skills whose `allowedTools` includes `open_url`
- `src/types/index.ts` — add `OpenUrlConfirmPayload` to wire types; thread through `AgentConfirmRequestMessage`
- `public/manifest.json` — version `0.4` → `0.5`
- `docs/solutions/2026-05-03-multi-session-invariant-trace.md` — append "Multi-pin v1" section documenting R7 union semantics + open_url auto-pin invariant

**Created:**
- `src/lib/sessions/pinned-tabs.ts` — single source of truth for normalization: `getPinnedTabsFromMeta(meta)`, `getPrimaryPinFromMeta(meta)`, `getPinnedTabIdsFromIndexEntry(entry)`. All read sites use these helpers; type-level `pinnedTabs?` stays optional.
- `src/lib/sessions/pinned-tabs.test.ts` — normalization helper tests
- `src/lib/agent/tools/open-url.test.ts` — co-located unit tests for `validateOpenUrlInput` + `openUrlTool` (URL allow-list, length cap, scheme rejection, host check)

---

## Tasks

### Task 1: Schema types + pinned-tabs normalization helper

**Files:**
- Modify: `src/lib/sessions/types.ts:65-93` (SessionMeta), `src/lib/sessions/types.ts:195-211` (SessionIndexEntry)
- Create: `src/lib/sessions/pinned-tabs.ts`
- Create: `src/lib/sessions/pinned-tabs.test.ts`

- [ ] **Step 1.1: Write the failing test for `getPinnedTabsFromMeta` normalization**

Create `src/lib/sessions/pinned-tabs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  getPinnedTabsFromMeta,
  getPrimaryPinFromMeta,
  getPinnedTabIdsFromIndexEntry,
} from "./pinned-tabs";
import type { SessionMeta, SessionIndexEntry } from "./types";

const baseMeta = (overrides: Partial<SessionMeta>): SessionMeta => ({
  id: "abc",
  createdAt: 0,
  lastAccessedAt: 0,
  status: "active",
  messages: [],
  ...overrides,
});

describe("getPinnedTabsFromMeta", () => {
  it("returns array verbatim when pinnedTabs is set", () => {
    const m = baseMeta({
      pinnedTabs: [
        { tabId: 1, origin: "https://a.com" },
        { tabId: 2, origin: "https://b.com" },
      ],
    });
    expect(getPinnedTabsFromMeta(m)).toEqual([
      { tabId: 1, origin: "https://a.com" },
      { tabId: 2, origin: "https://b.com" },
    ]);
  });

  it("derives single-element array from legacy pinnedTabId/Origin", () => {
    const m = baseMeta({ pinnedTabId: 42, pinnedOrigin: "https://legacy.com" });
    expect(getPinnedTabsFromMeta(m)).toEqual([
      { tabId: 42, origin: "https://legacy.com" },
    ]);
  });

  it("returns empty array when neither shape is present", () => {
    expect(getPinnedTabsFromMeta(baseMeta({}))).toEqual([]);
  });

  it("array shape wins when BOTH legacy and new are set (forward-compat)", () => {
    const m = baseMeta({
      pinnedTabId: 99,
      pinnedOrigin: "https://stale.com",
      pinnedTabs: [{ tabId: 1, origin: "https://fresh.com" }],
    });
    expect(getPinnedTabsFromMeta(m)).toEqual([
      { tabId: 1, origin: "https://fresh.com" },
    ]);
  });

  it("returns empty array when legacy fields are partially set (only id, no origin)", () => {
    const m = baseMeta({ pinnedTabId: 7 });
    expect(getPinnedTabsFromMeta(m)).toEqual([]);
  });
});

describe("getPrimaryPinFromMeta", () => {
  it("returns first element of pinnedTabs", () => {
    const m = baseMeta({
      pinnedTabs: [
        { tabId: 1, origin: "https://a.com" },
        { tabId: 2, origin: "https://b.com" },
      ],
    });
    expect(getPrimaryPinFromMeta(m)).toEqual({ tabId: 1, origin: "https://a.com" });
  });

  it("returns null when no pin (neither shape)", () => {
    expect(getPrimaryPinFromMeta(baseMeta({}))).toBeNull();
  });

  it("derives from legacy fields", () => {
    const m = baseMeta({ pinnedTabId: 5, pinnedOrigin: "https://legacy.com" });
    expect(getPrimaryPinFromMeta(m)).toEqual({ tabId: 5, origin: "https://legacy.com" });
  });
});

describe("getPinnedTabIdsFromIndexEntry", () => {
  const baseEntry = (overrides: Partial<SessionIndexEntry>): SessionIndexEntry => ({
    id: "abc",
    lastAccessedAt: 0,
    status: "active",
    ...overrides,
  });

  it("returns pinnedTabIds verbatim", () => {
    expect(
      getPinnedTabIdsFromIndexEntry(baseEntry({ pinnedTabIds: [1, 2, 3] })),
    ).toEqual([1, 2, 3]);
  });

  it("derives single-element array from legacy pinnedTabId", () => {
    expect(
      getPinnedTabIdsFromIndexEntry(baseEntry({ pinnedTabId: 7 })),
    ).toEqual([7]);
  });

  it("returns empty array when neither set", () => {
    expect(getPinnedTabIdsFromIndexEntry(baseEntry({}))).toEqual([]);
  });

  it("array wins when both set", () => {
    expect(
      getPinnedTabIdsFromIndexEntry(
        baseEntry({ pinnedTabId: 99, pinnedTabIds: [1, 2] }),
      ),
    ).toEqual([1, 2]);
  });
});
```

- [ ] **Step 1.2: Run test, confirm failure**

Run: `pnpm vitest run src/lib/sessions/pinned-tabs.test.ts`
Expected: FAIL — `pinned-tabs.ts` does not exist.

- [ ] **Step 1.3: Add `pinnedTabs?` to SessionMeta and `pinnedTabIds?` to SessionIndexEntry**

Edit `src/lib/sessions/types.ts:84-86` (after `pinnedOrigin?: string;`):

```ts
  pinnedOrigin?: string;
  /**
   * Multi-pin v1 — array of pinned tabs for this session. The first element
   * is the **primary pin** (= what `pinnedTabId/pinnedOrigin` used to mean).
   * Additional elements come from `open_url` calls within the session.
   *
   * Migration policy: when this field is set, it is the source of truth.
   * The legacy `pinnedTabId/pinnedOrigin` fields are kept as a derived alias
   * (= `pinnedTabs[0]`) by all writers for v1 forward-compat. Use the
   * `getPinnedTabsFromMeta` / `getPrimaryPinFromMeta` helpers in
   * `pinned-tabs.ts` for read-time normalization — never branch on shape
   * directly at call sites.
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
```

Edit `src/lib/sessions/types.ts:200-211` (after `pinnedTabId?: number;`):

```ts
  pinnedTabId?: number;
  /**
   * Multi-pin v1 — list of every pinned tab id this session owns.
   * Source of truth for `getCrossSessionPinnedTabIds` union (R7 lock).
   * Legacy `pinnedTabId` is kept as a derived alias (= `pinnedTabIds[0]`)
   * by writers; readers use `getPinnedTabIdsFromIndexEntry` in
   * `pinned-tabs.ts` to normalize.
   */
  pinnedTabIds?: number[];
```

- [ ] **Step 1.4: Implement the helper module**

Create `src/lib/sessions/pinned-tabs.ts`:

```ts
// Multi-pin v1 — normalization helpers. All read sites should go through
// these instead of branching on `pinnedTabs?` vs `pinnedTabId/Origin?`
// directly. Single source of truth for the v1 alias-keep policy.
//
// Migration policy:
//   - v1 (this PR): writers emit BOTH shapes (pinnedTabs + pinnedTabId/Origin
//     where pinnedTabId/Origin = pinnedTabs[0]); readers prefer the new shape
//     and fall back to legacy.
//   - v1.1: stop writing legacy aliases.
//   - v1.2: drop legacy field reads + types.

import type { SessionMeta, SessionIndexEntry } from "./types";

export interface PinnedTabRef {
  tabId: number;
  origin: string;
}

/**
 * Returns the canonical pinned tabs array for a session.
 * - If `pinnedTabs` is present, it wins.
 * - Else if BOTH legacy fields (pinnedTabId AND pinnedOrigin) are set, derive
 *   a single-element array.
 * - Else return an empty array (no pin yet).
 *
 * Partial legacy state (one of the two fields) is treated as no-pin — same
 * conservative bar the loop's anchor step uses for restricted URLs.
 */
export function getPinnedTabsFromMeta(meta: SessionMeta): PinnedTabRef[] {
  if (meta.pinnedTabs && meta.pinnedTabs.length > 0) {
    return meta.pinnedTabs;
  }
  if (typeof meta.pinnedTabId === "number" && typeof meta.pinnedOrigin === "string") {
    return [{ tabId: meta.pinnedTabId, origin: meta.pinnedOrigin }];
  }
  return [];
}

/**
 * Returns the primary pin (first element) or null. Drives `ctx.pinned` in
 * the loop, the `<pinned_tabs>` system prompt block's primary marker, and
 * the panel's `pinnedOrigin` field.
 */
export function getPrimaryPinFromMeta(meta: SessionMeta): PinnedTabRef | null {
  const tabs = getPinnedTabsFromMeta(meta);
  return tabs.length > 0 ? tabs[0] : null;
}

/**
 * Returns the canonical pinnedTabIds array for an index entry.
 * Used by `getCrossSessionPinnedTabIds` to compute the cross-session union.
 */
export function getPinnedTabIdsFromIndexEntry(entry: SessionIndexEntry): number[] {
  if (entry.pinnedTabIds && entry.pinnedTabIds.length > 0) {
    return entry.pinnedTabIds;
  }
  if (typeof entry.pinnedTabId === "number") {
    return [entry.pinnedTabId];
  }
  return [];
}
```

- [ ] **Step 1.5: Run tests to confirm green**

Run: `pnpm vitest run src/lib/sessions/pinned-tabs.test.ts`
Expected: PASS — 11 tests green.

- [ ] **Step 1.6: Commit**

```bash
git add src/lib/sessions/types.ts src/lib/sessions/pinned-tabs.ts src/lib/sessions/pinned-tabs.test.ts
git commit -m "feat(sessions): add pinnedTabs[] / pinnedTabIds[] schema + normalization helpers"
```

---

### Task 2: Storage write path emits dual fields (legacy alias preservation)

**Files:**
- Modify: `src/lib/sessions/storage.ts:89-99` (`indexEntryFromMeta`), `:111-145` (`createSession`), `:217-246` (`setSessionMeta`)
- Modify: `src/lib/sessions/storage.test.ts` (existing — extend)

- [ ] **Step 2.1: Write the failing test for dual-write semantics**

Append to `src/lib/sessions/storage.test.ts` (locate existing `describe("createSession", …)` block and add inside):

```ts
  it("createSession with pinnedTabs persists array AND legacy alias", async () => {
    const meta = await createSession({
      pinnedTabs: [
        { tabId: 5, origin: "https://primary.com" },
        { tabId: 9, origin: "https://secondary.com" },
      ],
    });

    // Meta carries new shape
    expect(meta.pinnedTabs).toEqual([
      { tabId: 5, origin: "https://primary.com" },
      { tabId: 9, origin: "https://secondary.com" },
    ]);
    // Legacy alias = primary pin
    expect(meta.pinnedTabId).toBe(5);
    expect(meta.pinnedOrigin).toBe("https://primary.com");

    // Index entry carries new shape AND legacy alias
    const idx = await listSessionIndex();
    const entry = idx.find((e) => e.id === meta.id);
    expect(entry?.pinnedTabIds).toEqual([5, 9]);
    expect(entry?.pinnedTabId).toBe(5);
  });

  it("createSession with legacy pinnedTabId/Origin still works (alias path)", async () => {
    const meta = await createSession({
      pinnedTabId: 7,
      pinnedOrigin: "https://legacy.com",
    });
    // Helper-derived array shape on read
    expect(getPinnedTabsFromMeta(meta)).toEqual([
      { tabId: 7, origin: "https://legacy.com" },
    ]);
    expect(meta.pinnedTabId).toBe(7);
  });
```

(Add `import { getPinnedTabsFromMeta } from "./pinned-tabs";` at top of `storage.test.ts` if not already.)

Also add a `setSessionMeta` round-trip test in the same file:

```ts
  it("setSessionMeta with multi-pin survives round-trip and updates index union", async () => {
    const meta = await createSession({
      pinnedTabs: [{ tabId: 1, origin: "https://a.com" }],
    });
    await setSessionMeta({
      ...meta,
      pinnedTabs: [
        { tabId: 1, origin: "https://a.com" },
        { tabId: 2, origin: "https://b.com" },
      ],
    });
    const back = await getSessionMeta(meta.id);
    expect(back?.pinnedTabs).toHaveLength(2);
    const idx = await listSessionIndex();
    expect(idx.find((e) => e.id === meta.id)?.pinnedTabIds).toEqual([1, 2]);
  });
```

- [ ] **Step 2.2: Run test to confirm failure**

Run: `pnpm vitest run src/lib/sessions/storage.test.ts`
Expected: FAIL — `createSession` does not yet accept `pinnedTabs`; `indexEntryFromMeta` does not emit `pinnedTabIds`.

- [ ] **Step 2.3: Update `indexEntryFromMeta` to emit both shapes**

Edit `src/lib/sessions/storage.ts:89-99`:

```ts
function indexEntryFromMeta(meta: SessionMeta): SessionIndexEntry {
  const tabs = getPinnedTabsFromMeta(meta);
  const entry: SessionIndexEntry = {
    id: meta.id,
    lastAccessedAt: meta.lastAccessedAt,
    status: meta.status,
    messageCount: meta.messages.length,
  };
  if (meta.title !== undefined) entry.title = meta.title;
  if (tabs.length > 0) {
    entry.pinnedTabIds = tabs.map((t) => t.tabId);
    // Legacy alias = primary pin (v1 forward-compat; drop in v1.1)
    entry.pinnedTabId = tabs[0].tabId;
  }
  return entry;
}
```

Add `import { getPinnedTabsFromMeta } from "./pinned-tabs";` at top.

- [ ] **Step 2.4: Update `CreateSessionOptions` and `createSession` to accept multi-pin**

Edit `src/lib/sessions/storage.ts:111-119`:

```ts
export interface CreateSessionOptions {
  /** v1 — multi-pin shape. Persisted as the canonical form. */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  /** Legacy single-pin shape. Accepted for backwards compatibility — the
   *  caller can pass either; both end up as `pinnedTabs: [{tabId, origin}]`. */
  pinnedTabId?: number;
  pinnedOrigin?: string;
  /** Initial messages, e.g. for migration scenarios. M1 callers omit. */
  messages?: SessionMeta["messages"];
  /** Override clock for tests. Defaults to Date.now(). */
  now?: number;
}
```

Edit `src/lib/sessions/storage.ts:127-145` (createSession body):

```ts
export async function createSession(
  options: CreateSessionOptions = {},
): Promise<SessionMeta> {
  const id = crypto.randomUUID();
  const now = options.now ?? Date.now();

  // Normalize input: prefer pinnedTabs[]; fall back to legacy fields.
  let pinnedTabs: Array<{ tabId: number; origin: string }> | undefined;
  if (options.pinnedTabs && options.pinnedTabs.length > 0) {
    pinnedTabs = options.pinnedTabs;
  } else if (
    typeof options.pinnedTabId === "number" &&
    typeof options.pinnedOrigin === "string"
  ) {
    pinnedTabs = [{ tabId: options.pinnedTabId, origin: options.pinnedOrigin }];
  }

  const rawMeta: SessionMeta = {
    id,
    createdAt: now,
    lastAccessedAt: now,
    status: "active",
    messages: options.messages ?? [],
    ...(pinnedTabs ? { pinnedTabs } : {}),
    // Legacy alias write (v1 forward-compat; drop in v1.1)
    ...(pinnedTabs ? { pinnedTabId: pinnedTabs[0].tabId } : {}),
    ...(pinnedTabs ? { pinnedOrigin: pinnedTabs[0].origin } : {}),
  };

  const meta = scrubAttachmentBytes(rawMeta);

  const agent: SessionAgentState = {
    agentMessages: [],
    stepIndex: 0,
    skillExecutionScopeStack: [],
    hasImageContent: false,
  };

  const index = await readIndex();
  const updatedIndex = upsertIndexEntry(index, indexEntryFromMeta(meta));

  await writeAtomic({
    [metaKey(id)]: meta,
    [agentKey(id)]: agent,
    [INDEX_KEY]: updatedIndex,
  });

  return meta;
}
```

- [ ] **Step 2.5: Update `setSessionMeta` to keep legacy alias in sync on every write**

Edit `src/lib/sessions/storage.ts:227-246` (setSessionMeta body) — add alias-sync block before `scrubbedMeta`:

```ts
export async function setSessionMeta(meta: SessionMeta): Promise<void> {
  // v1 alias-keep: every write of pinnedTabs[] also rewrites the legacy
  // pinnedTabId/Origin so old read sites that haven't yet migrated to
  // getPrimaryPinFromMeta keep working.
  const tabs = getPinnedTabsFromMeta(meta);
  const aliasFixed: SessionMeta = tabs.length > 0
    ? { ...meta, pinnedTabId: tabs[0].tabId, pinnedOrigin: tabs[0].origin }
    : meta;

  const scrubbedMeta = scrubAttachmentBytes(aliasFixed);
  // … rest unchanged
}
```

Also update `updateLastAccessed` similarly — when caller passes `pinnedTabId`, treat as legacy single-pin and propagate to `pinnedTabs` if not present:

Edit `src/lib/sessions/storage.ts:307-331`:

```ts
export async function updateLastAccessed(
  id: string,
  options: {
    now?: number;
    status?: SessionStatus;
    title?: string;
    pinnedTabId?: number;
    pinnedOrigin?: string;
    pinnedTabs?: Array<{ tabId: number; origin: string }>;
  } = {},
): Promise<boolean> {
  const meta = await getSessionMeta(id);
  if (!meta) return false;

  // Normalize the pinned-tab patch: prefer pinnedTabs; else if legacy
  // fields are passed AND the existing meta has no pinnedTabs, treat
  // legacy as single-element array; else leave existing pinnedTabs alone.
  let nextPinnedTabs = meta.pinnedTabs;
  if (options.pinnedTabs !== undefined) {
    nextPinnedTabs = options.pinnedTabs;
  } else if (
    typeof options.pinnedTabId === "number" &&
    typeof options.pinnedOrigin === "string" &&
    !meta.pinnedTabs
  ) {
    nextPinnedTabs = [
      { tabId: options.pinnedTabId, origin: options.pinnedOrigin },
    ];
  }

  const updated: SessionMeta = {
    ...meta,
    lastAccessedAt: options.now ?? Date.now(),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(nextPinnedTabs !== undefined ? { pinnedTabs: nextPinnedTabs } : {}),
  };

  await setSessionMeta(updated);
  return true;
}
```

- [ ] **Step 2.6: Run tests to confirm green**

Run: `pnpm vitest run src/lib/sessions/storage.test.ts`
Expected: PASS — all storage tests green (existing + 3 new).

- [ ] **Step 2.7: Commit**

```bash
git add src/lib/sessions/storage.ts src/lib/sessions/storage.test.ts
git commit -m "feat(sessions): storage dual-writes pinnedTabs[] + legacy alias for v1 forward-compat"
```

---

### Task 3: pinned-tab-registry returns multi-pin union

**Files:**
- Modify: `src/lib/sessions/pinned-tab-registry.ts`
- Modify: `src/lib/sessions/pinned-tab-registry.test.ts`

- [ ] **Step 3.1: Write failing test for multi-pin union**

Append to `src/lib/sessions/pinned-tab-registry.test.ts` inside the existing `describe`:

```ts
  it("getActivePinnedTabs returns a row per pinned tab when a session has multiple", async () => {
    await createSession({
      pinnedTabs: [
        { tabId: 1, origin: "https://a.com" },
        { tabId: 2, origin: "https://b.com" },
      ],
    });
    const tabs = await getActivePinnedTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.tabId).sort()).toEqual([1, 2]);
  });

  it("getCrossSessionPinnedTabIds union covers every sibling session's pins", async () => {
    const a = await createSession({
      pinnedTabs: [{ tabId: 1, origin: "https://a.com" }],
    });
    await createSession({
      pinnedTabs: [
        { tabId: 2, origin: "https://b.com" },
        { tabId: 3, origin: "https://c.com" },
      ],
    });
    const cross = await getCrossSessionPinnedTabIds(a.id);
    expect(cross).toEqual(new Set([2, 3]));
  });

  it("getCrossSessionPinnedTabIds excludes calling session even when it has multiple pins", async () => {
    const a = await createSession({
      pinnedTabs: [
        { tabId: 1, origin: "https://a.com" },
        { tabId: 4, origin: "https://d.com" },
      ],
    });
    await createSession({
      pinnedTabs: [{ tabId: 2, origin: "https://b.com" }],
    });
    const cross = await getCrossSessionPinnedTabIds(a.id);
    expect(cross).toEqual(new Set([2]));
  });

  it("legacy single-pin index entries still flow through (alias path)", async () => {
    // Simulate a pre-multi-pin index entry on disk via direct chrome.storage write.
    await chrome.storage.local.set({
      session_index: [
        {
          id: "legacy-session",
          lastAccessedAt: 1,
          status: "active",
          pinnedTabId: 99,
        },
      ],
    });
    const cross = await getCrossSessionPinnedTabIds("other-session");
    expect(cross).toEqual(new Set([99]));
  });
```

- [ ] **Step 3.2: Run test, confirm failure**

Run: `pnpm vitest run src/lib/sessions/pinned-tab-registry.test.ts`
Expected: FAIL — `getActivePinnedTabs` only emits one row per session (legacy path); union from `pinnedTabIds[]` not yet implemented.

- [ ] **Step 3.3: Update `getActivePinnedTabs` to flatten multi-pin**

Edit `src/lib/sessions/pinned-tab-registry.ts:57-70`:

```ts
export async function getActivePinnedTabs(): Promise<ActivePinnedTab[]> {
  const index = await listSessionIndex();
  const out: ActivePinnedTab[] = [];
  for (const entry of index) {
    if (!OWNING_STATUSES.has(entry.status)) continue;
    const ids = getPinnedTabIdsFromIndexEntry(entry);
    for (const tabId of ids) {
      out.push({
        sessionId: entry.id,
        tabId,
        status: entry.status as "active" | "paused",
      });
    }
  }
  return out;
}
```

Add `import { getPinnedTabIdsFromIndexEntry } from "./pinned-tabs";` at top.

`getCrossSessionPinnedTabIds` (lines 83-93) already iterates `getActivePinnedTabs()` and skips matching sessionId — no change needed; the union behavior emerges from the flatten in `getActivePinnedTabs`.

- [ ] **Step 3.4: Run tests to confirm green**

Run: `pnpm vitest run src/lib/sessions/pinned-tab-registry.test.ts`
Expected: PASS — all 4 new tests + existing tests green.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/sessions/pinned-tab-registry.ts src/lib/sessions/pinned-tab-registry.test.ts
git commit -m "feat(sessions): pinned-tab-registry returns multi-pin union for R7 cross-session lock"
```

---

### Task 4: open_url tool — registry, classification, and handler

**Files:**
- Modify: `src/lib/agent/tool-names.ts:39-47` (TAB_TOOL_NAMES), `:112-140` (TOOL_CLASSES)
- Modify: `src/lib/agent/risk.ts:189-218` (write-tool branch), `:367-374` (ALWAYS_HIGH_TAB_TOOLS)
- Modify: `src/lib/agent/tools/tabs.ts` (add openUrlTool)
- Create: `src/lib/agent/tools/open-url.test.ts`

- [ ] **Step 4.1: Write failing test for `validateOpenUrlInput`**

Create `src/lib/agent/tools/open-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateOpenUrlInput } from "./tabs";

describe("validateOpenUrlInput (R6 + R7)", () => {
  it("accepts http URL with non-empty host", () => {
    const r = validateOpenUrlInput({ url: "http://example.com/path" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.protocol).toBe("http:");
      expect(r.parsed.host).toBe("example.com");
    }
  });

  it("accepts https URL with non-empty host", () => {
    const r = validateOpenUrlInput({ url: "https://example.com/" });
    expect(r.ok).toBe(true);
  });

  it("rejects javascript:", () => {
    const r = validateOpenUrlInput({ url: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe-url-scheme");
  });

  it("rejects data: URL", () => {
    const r = validateOpenUrlInput({ url: "data:text/html,<script>alert(1)</script>" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe-url-scheme");
  });

  it("rejects view-source: URL", () => {
    const r = validateOpenUrlInput({ url: "view-source:https://example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe-url-scheme");
  });

  it("rejects mailto: URL", () => {
    const r = validateOpenUrlInput({ url: "mailto:a@b.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe-url-scheme");
  });

  it("rejects chrome:// URL", () => {
    const r = validateOpenUrlInput({ url: "chrome://settings" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe-url-scheme");
  });

  it("rejects file:// URL", () => {
    const r = validateOpenUrlInput({ url: "file:///etc/passwd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsafe-url-scheme");
  });

  it("rejects empty string", () => {
    const r = validateOpenUrlInput({ url: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-url");
  });

  it("rejects null url", () => {
    const r = validateOpenUrlInput({ url: null as unknown as string });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-url");
  });

  it("rejects non-string url", () => {
    const r = validateOpenUrlInput({ url: 42 as unknown as string });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-url");
  });

  it("rejects relative path (no scheme)", () => {
    const r = validateOpenUrlInput({ url: "/example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-url");
  });

  it("rejects protocol-relative URL", () => {
    const r = validateOpenUrlInput({ url: "//example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-url");
  });

  it("rejects percent-encoded scheme", () => {
    // `https%3A//example.com` parses as a relative path → URL throws
    const r = validateOpenUrlInput({ url: "https%3A//example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-url");
  });

  it("rejects scheme-only URL with no host (https:)", () => {
    // new URL("https:") is actually invalid in Node; covered by URL throw → invalid-url
    const r = validateOpenUrlInput({ url: "https:" });
    expect(r.ok).toBe(false);
  });

  it("rejects URL longer than 4096 chars", () => {
    const longTail = "a".repeat(5000);
    const r = validateOpenUrlInput({ url: `https://example.com/${longTail}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("url-too-long");
  });

  it("accepts URL at the 4096 boundary", () => {
    const base = "https://example.com/";
    const padding = "a".repeat(4096 - base.length);
    const url = base + padding;
    expect(url.length).toBe(4096);
    const r = validateOpenUrlInput({ url });
    expect(r.ok).toBe(true);
  });

  it("accepts IDN URL preserving punycode form for confirm", () => {
    const r = validateOpenUrlInput({ url: "https://xn--80akhbyknj4f.com/" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // URL.host preserves punycode (`xn--…`) even though `URL.hostname`
      // depends on JS engine — this is the host the confirm card displays.
      expect(r.parsed.host).toBe("xn--80akhbyknj4f.com");
    }
  });
});
```

- [ ] **Step 4.2: Run test, confirm failure**

Run: `pnpm vitest run src/lib/agent/tools/open-url.test.ts`
Expected: FAIL — `validateOpenUrlInput` not exported from `tabs.ts`.

- [ ] **Step 4.3: Implement `validateOpenUrlInput` and `openUrlTool` in tabs.ts**

Append to `src/lib/agent/tools/tabs.ts` (before the `TAB_TOOLS` export at line 1011):

```ts
// ── Multi-pin v1 — open_url tool (R1, R6, R7) ──────────────────────────────

const OPEN_URL_MAX_LEN = 4096;

interface OpenUrlArgs {
  url: string;
  active?: boolean;
}

export type OpenUrlValidationResult =
  | { ok: true; parsed: URL }
  | { ok: false; code: "invalid-url" | "unsafe-url-scheme" | "url-too-long"; reason: string };

/**
 * R6 + R7 — validate an LLM-supplied URL for open_url.
 *
 * Allow-list (NOT deny-list) so future Chrome schemes default to reject:
 *   - protocol must be exactly 'http:' or 'https:'
 *   - host must be non-empty (rejects scheme-only inputs like 'https:')
 *   - URL.constructor must not throw (rejects relative / protocol-relative / percent-encoded scheme)
 *   - total length ≤ 4096 chars (R6 length cap; ≥1024 fold is UI concern only)
 *
 * Returns structured result so the handler can surface a precise observation
 * code to the LLM (R7 isError + LLM re-plans, NOT task abort).
 */
export function validateOpenUrlInput(args: OpenUrlArgs): OpenUrlValidationResult {
  if (typeof args.url !== "string" || args.url.length === 0) {
    return { ok: false, code: "invalid-url", reason: "url must be a non-empty string" };
  }
  if (args.url.length > OPEN_URL_MAX_LEN) {
    return {
      ok: false,
      code: "url-too-long",
      reason: `url exceeds the ${OPEN_URL_MAX_LEN}-character cap (received ${args.url.length})`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return {
      ok: false,
      code: "invalid-url",
      reason: "url could not be parsed as an absolute URL",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "unsafe-url-scheme",
      reason: `url scheme '${parsed.protocol}' is not allowed; only http: and https: are permitted`,
    };
  }
  if (!parsed.host || parsed.host.length === 0) {
    return {
      ok: false,
      code: "invalid-url",
      reason: "url must have a non-empty host",
    };
  }
  return { ok: true, parsed };
}

/**
 * Marker prefix for open_url's structured observation. Loop dispatch
 * scans the observation string for this prefix to extract the created
 * tabId for the post-handler auto-pin push.
 */
export const OPEN_URL_RESULT_PREFIX = "open_url:created:";

const openUrlTool: Tool = {
  name: "open_url",
  description:
    "Open a new tab at the given URL within the current window. The new " +
    "tab is automatically added to the agent's pinned tabs (does NOT " +
    "replace existing pins). Only http: and https: URLs are accepted; " +
    "other schemes (data:, javascript:, view-source:, mailto:, chrome:, " +
    "file:, etc.) are rejected before dispatch. Each call requires user " +
    "approval (always-high risk).",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: `Absolute http: or https: URL to open (max ${OPEN_URL_MAX_LEN} chars).`,
      },
      active: {
        type: "boolean",
        description:
          "If true, the new tab steals focus (user is taken to it). " +
          "If false (default), the tab loads in the background and " +
          "executes scripts without switching the user's view.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as OpenUrlArgs;
    const v = validateOpenUrlInput(a);
    if (!v.ok) {
      return { success: false, error: `${v.code}: ${v.reason}` };
    }
    const active = a.active === true;

    let createdTab: chrome.tabs.Tab;
    try {
      createdTab = await chrome.tabs.create({ url: v.parsed.href, active });
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "chrome.tabs.create failed",
      };
    }
    if (typeof createdTab.id !== "number" || createdTab.id < 0) {
      return { success: false, error: "open_url: chrome returned a tab without an addressable id" };
    }
    return {
      success: true,
      // Structured observation: machine-readable line first (loop scans
      // for OPEN_URL_RESULT_PREFIX), human-readable summary second.
      observation:
        `${OPEN_URL_RESULT_PREFIX}${createdTab.id} origin=${v.parsed.origin}\n` +
        `Opened tab ${createdTab.id} at ${v.parsed.origin}${v.parsed.pathname}; pinned to this session (${active ? "active" : "background"}).`,
    };
  },
};
```

Update the export list at line 1011:

```ts
export const TAB_TOOLS: Tool[] = [
  listTabsTool,
  closeTabsTool,
  activateTabTool,
  groupTabsTool,
  ungroupTabsTool,
  moveTabsTool,
  getTabContentTool,
  openUrlTool,
];
```

- [ ] **Step 4.4: Register name in `tool-names.ts` and class**

Edit `src/lib/agent/tool-names.ts:39-47`:

```ts
export const TAB_TOOL_NAMES = [
  "list_tabs",
  "get_tab_content",
  "close_tabs",
  "activate_tab",
  "group_tabs",
  "ungroup_tabs",
  "move_tabs",
  "open_url",
] as const;
```

Edit `src/lib/agent/tool-names.ts:126-134` (inside `TOOL_CLASSES`, after `move_tabs: "write"`):

```ts
  move_tabs: "write",
  open_url: "write",
  // Phase 2.5 CDP keyboard tools
```

- [ ] **Step 4.5: Add risk classification branch in `risk.ts`**

Edit `src/lib/agent/risk.ts:367-373` (inside `ALWAYS_HIGH_TAB_TOOLS`):

```ts
const ALWAYS_HIGH_TAB_TOOLS = new Set<string>([
  "close_tabs",
  "group_tabs",
  "ungroup_tabs",
  "move_tabs",
  "get_tab_content",
  "open_url",
]);
```

Add a new branch in `classifyRisk` between the existing `close_tabs|group_tabs|...` block (line 196) and `get_tab_content` (line 212). Edit `src/lib/agent/risk.ts:189-207` — insert AFTER the close_tabs block:

```ts
  if (toolName === "open_url") {
    // open_url targets a URL, not an existing tab — cross-origin
    // introspection is not meaningful here. The confirm card carries
    // the URL+origin payload; risk reason just signals "review the
    // destination URL" so the user knows what to look for.
    return {
      level: "high",
      reason: "Opening a new tab — review the destination URL on the confirm card.",
    };
  }
```

- [ ] **Step 4.6: Run open-url tests + tool-names build-time check + risk tests**

Run: `pnpm vitest run src/lib/agent/tools/open-url.test.ts src/lib/agent/tool-names.test.ts src/lib/agent/risk.test.ts`
Expected: PASS — all green. Build-time check in `tool-names.ts` and `risk.ts` (G-1 gate) passes because `open_url` is now in TOOL_CLASSES + ALWAYS_HIGH_TAB_TOOLS.

- [ ] **Step 4.7: Commit**

```bash
git add src/lib/agent/tools/tabs.ts src/lib/agent/tools/open-url.test.ts src/lib/agent/tool-names.ts src/lib/agent/risk.ts
git commit -m "feat(agent): add open_url tool with http/https allow-list, 4096-char cap, always-high risk"
```

---

### Task 5: SW dispatch — confirm payload, post-handler auto-pin, system prompt update

**Files:**
- Modify: `src/types/index.ts` (or wherever wire types live — add `OpenUrlConfirmPayload`)
- Modify: `src/lib/agent/loop.ts:1442-1500` (buildTabTargets / pre-confirm) and post-handler ~`1500+`
- Modify: `src/lib/agent/prompt.ts` (system prompt block)
- Modify: `src/sidepanel/hooks/useSession.ts` (no captureActivePinned change; type imports)

- [ ] **Step 5.1: Locate wire types and add `OpenUrlConfirmPayload`**

Run: `grep -n "tabTargets\|contentPreview\|AgentConfirmRequestMessage" src/types/index.ts | head -20`
Read the relevant section; expected to see `AgentConfirmRequestMessage` definition with optional `tabTargets`, `contentPreview` fields.

Edit `src/types/index.ts` — add the type and thread it onto `AgentConfirmRequestMessage`:

```ts
/**
 * Multi-pin v1 — open_url confirm payload. The destination tab does not
 * exist yet, so we cannot reuse `tabTargets` (which references live tab ids
 * via chrome.tabs.get). Carries the parsed URL + origin (punycode-correct
 * via URL.host) + active flag so AgentConfirmCard can render the
 * brainstorm-R9 layout: URL full-text (≥1024-char fold), origin row,
 * active flag tag.
 */
export interface OpenUrlConfirmPayload {
  /** Full URL the agent passed (≤ 4096 chars; UI folds ≥ 1024). */
  url: string;
  /** URL.origin — protocol + host (host preserves IDN punycode form). */
  origin: string;
  /** URL.host — used for the secondary "host" row in the confirm card. */
  host: string;
  /** active flag from args (default false). Drives "Steals focus" vs
   *  "Background load + executes scripts" subtitle. */
  active: boolean;
}
```

Append to `AgentConfirmRequestMessage`:

```ts
export interface AgentConfirmRequestMessage {
  // … existing fields
  /** Multi-pin v1 — set when tool === "open_url"; mutually exclusive with tabTargets. */
  openUrlPayload?: OpenUrlConfirmPayload;
}
```

- [ ] **Step 5.2: Write failing test for the SW payload builder**

Add to `src/lib/agent/loop.test.ts` (near other dispatch tests):

```ts
import { buildOpenUrlConfirmPayload } from "./loop";

describe("buildOpenUrlConfirmPayload", () => {
  it("returns payload with url, origin, host, active", () => {
    const p = buildOpenUrlConfirmPayload({
      url: "https://example.com/path?q=1",
      active: true,
    });
    expect(p).not.toBeNull();
    expect(p!.url).toBe("https://example.com/path?q=1");
    expect(p!.origin).toBe("https://example.com");
    expect(p!.host).toBe("example.com");
    expect(p!.active).toBe(true);
  });

  it("defaults active to false when omitted", () => {
    const p = buildOpenUrlConfirmPayload({ url: "https://x.com/" });
    expect(p!.active).toBe(false);
  });

  it("returns null for invalid URL (handler will reject before dispatch)", () => {
    expect(buildOpenUrlConfirmPayload({ url: "javascript:alert(1)" })).toBeNull();
  });

  it("returns null for null/undefined url (defensive)", () => {
    expect(buildOpenUrlConfirmPayload({ url: null as unknown as string })).toBeNull();
    expect(buildOpenUrlConfirmPayload({} as { url: string })).toBeNull();
  });

  it("preserves IDN punycode in host", () => {
    const p = buildOpenUrlConfirmPayload({ url: "https://xn--80akhbyknj4f.com/" });
    expect(p!.host).toBe("xn--80akhbyknj4f.com");
  });
});
```

- [ ] **Step 5.3: Run test, confirm failure**

Run: `pnpm vitest run src/lib/agent/loop.test.ts -t "buildOpenUrlConfirmPayload"`
Expected: FAIL — `buildOpenUrlConfirmPayload` not exported.

- [ ] **Step 5.4: Implement `buildOpenUrlConfirmPayload` in loop.ts**

Add to `src/lib/agent/loop.ts` (near `tabTargetsToOriginCache` ~line 514):

```ts
import { validateOpenUrlInput } from "./tools/tabs";
import type { OpenUrlConfirmPayload } from "@/types";

/**
 * Multi-pin v1 — pre-confirm payload builder for open_url. Mirrors
 * buildTabTargets's contract but for a tab that does not exist yet.
 * Returns null when validation fails (the handler will reject the tool
 * call with a structured isError observation; we still emit the confirm
 * card so the user sees what was rejected).
 */
export function buildOpenUrlConfirmPayload(
  args: { url?: string; active?: boolean },
): OpenUrlConfirmPayload | null {
  const r = validateOpenUrlInput({ url: args.url ?? "" });
  if (!r.ok) return null;
  return {
    url: r.parsed.href,
    origin: r.parsed.origin,
    host: r.parsed.host,
    active: args.active === true,
  };
}
```

- [ ] **Step 5.5: Wire `buildOpenUrlConfirmPayload` into loop dispatch pre-confirm**

Edit `src/lib/agent/loop.ts:1442-1450` (where `tabTargets` is built):

```ts
        // Phase 3 — pre-compute TabTarget[] for tab tools so the confirm card
        // can render an informed-approval payload (P3-E) AND the risk
        // classifier can do cross-origin args introspection (P3-A) using the
        // already-fetched origins (no second chrome.tabs.get round-trip).
        let tabTargets: TabTarget[] | undefined;
        let openUrlPayload: OpenUrlConfirmPayload | undefined;
        const isTabTool = (TAB_TOOL_NAMES as readonly string[]).includes(tc.name);
        if (isTabTool) {
          if (tc.name === "open_url") {
            // open_url has no existing-tab targets — emit a dedicated
            // payload instead of synthetic TabTarget entries.
            const p = buildOpenUrlConfirmPayload(args);
            if (p) openUrlPayload = p;
          } else {
            tabTargets = await buildTabTargets(tc.name, args, pinnedOrigin);
          }
        }
```

Locate the `sendConfirmRequest` call site (~line 1640+) and thread `openUrlPayload` into the payload object:

```ts
const approval = await sendConfirmRequest(confirmationId, {
  // … existing fields (tool, args, riskReason, tabTargets, contentPreview, …)
  ...(openUrlPayload ? { openUrlPayload } : {}),
});
```

- [ ] **Step 5.6: Write failing test for post-handler auto-pin push**

Add to `src/lib/agent/loop.test.ts`:

```ts
import { extractCreatedTabIdFromObservation } from "./loop";

describe("extractCreatedTabIdFromObservation (open_url auto-pin)", () => {
  it("parses tabId and origin from successful open_url observation", () => {
    const obs = "open_url:created:42 origin=https://example.com\nOpened tab 42 at https://example.com/; pinned (background).";
    const r = extractCreatedTabIdFromObservation(obs);
    expect(r).toEqual({ tabId: 42, origin: "https://example.com" });
  });

  it("returns null when observation lacks the marker", () => {
    expect(extractCreatedTabIdFromObservation("Opened tab 42")).toBeNull();
    expect(extractCreatedTabIdFromObservation("")).toBeNull();
  });

  it("returns null when tabId is non-numeric", () => {
    expect(extractCreatedTabIdFromObservation("open_url:created:foo origin=https://x.com")).toBeNull();
  });
});
```

- [ ] **Step 5.7: Run test, confirm failure**

Run: `pnpm vitest run src/lib/agent/loop.test.ts -t "extractCreatedTabIdFromObservation"`
Expected: FAIL — function not exported.

- [ ] **Step 5.8: Implement `extractCreatedTabIdFromObservation` and the post-handler auto-pin block**

Add to `src/lib/agent/loop.ts` (near `buildOpenUrlConfirmPayload`):

```ts
import { OPEN_URL_RESULT_PREFIX } from "./tools/tabs";

/**
 * Multi-pin v1 — parse the structured observation prefix the open_url
 * handler emits: `open_url:created:<tabId> origin=<origin>`. Returns
 * `null` for any non-conforming observation so the auto-pin push is
 * silently skipped (handler errored or returned a different shape).
 */
export function extractCreatedTabIdFromObservation(
  observation: string,
): { tabId: number; origin: string } | null {
  if (!observation || typeof observation !== "string") return null;
  const firstLine = observation.split("\n", 1)[0];
  if (!firstLine.startsWith(OPEN_URL_RESULT_PREFIX)) return null;
  // Format: open_url:created:<id> origin=<origin>
  const tail = firstLine.slice(OPEN_URL_RESULT_PREFIX.length);
  const match = tail.match(/^(\d+)\s+origin=(\S+)$/);
  if (!match) return null;
  const tabId = Number(match[1]);
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  return { tabId, origin: match[2] };
}
```

Locate the post-handler success branch in loop dispatch (where the tool result is appended after a successful handler call). Add an interception block immediately AFTER the handler returns and BEFORE pushing to `toolResultBlocks`:

```ts
        // Multi-pin v1 — open_url auto-pin push.
        //
        // After a successful chrome.tabs.create, the new tab id is
        // returned via the structured observation prefix (open_url:created:<id>).
        // Push {tabId, origin} into the calling session's pinnedTabs[] in
        // ONE atomic write so the next refreshCrossSessionPinnedTabIds()
        // call (per-iteration TOCTOU refresh) sees the new pin. Sibling
        // sessions' R7 lock fires correctly thereafter.
        //
        // We do not write the new pin into pinnedOrigin/pinnedTabId
        // (legacy alias = primary). Primary stays as it was.
        if (tc.name === "open_url" && handlerResult.success) {
          const created = extractCreatedTabIdFromObservation(
            handlerResult.observation ?? "",
          );
          if (created && ctx.onOpenUrlAutoPin) {
            try {
              await ctx.onOpenUrlAutoPin(created);
            } catch (e) {
              console.warn(
                `[agent] open_url auto-pin push failed for session=${sessionId}:`,
                e,
              );
              // Non-fatal — the LLM still saw the tab id in the observation
              // and can call activate_tab on it. The cross-session R7 lock
              // will still see the pin via the next chat-start since the
              // new tab is in chrome's session anyway; we just lose the
              // immediate per-iteration view.
            }
          }
        }
```

Add `onOpenUrlAutoPin?: (created: { tabId: number; origin: string }) => Promise<void>` to `AgentLoopContext` (loop.ts:74).

- [ ] **Step 5.9: Wire the SW dispatcher to provide `onOpenUrlAutoPin`**

Edit `src/background/index.ts` — both call sites (`runAgentLoop` chat-start ~line 1195 and resume ~line 716). Add `onOpenUrlAutoPin`:

```ts
onOpenUrlAutoPin: async (created) => {
  // Multi-pin v1: append {tabId, origin} to the session's pinnedTabs[].
  // Single writeAtomic (via setSessionMeta) covers meta + index update.
  const meta = await getSessionMeta(sessionId);
  if (!meta) return;
  const existing = getPinnedTabsFromMeta(meta);
  // Idempotent — if the tab is already pinned (rare; LLM re-issuing the
  // same call should already have been blocked by K-10) skip the append.
  if (existing.some((t) => t.tabId === created.tabId)) return;
  await setSessionMeta({
    ...meta,
    pinnedTabs: [...existing, created],
  });
},
```

Add `import { getPinnedTabsFromMeta } from "@/lib/sessions/pinned-tabs";` to `src/background/index.ts`.

- [ ] **Step 5.10: Update system prompt — switch `<pinned_tab>` to `<pinned_tabs>` block**

Run: `grep -n "pinned_tab\|<pinned_tab>" src/lib/agent/prompt.ts`
Identify the existing inline-XML emission. Replace the single-pin block with a multi-pin one.

Edit `src/lib/agent/prompt.ts` — change `buildAgentSystemPrompt` signature from `pinned: { tabId, origin }` to `pinned: { primary: {tabId, origin}; secondaries: Array<{tabId, origin}> }`. Render block:

```ts
function renderPinnedTabsBlock(pinned: {
  primary: { tabId: number; origin: string };
  secondaries: Array<{ tabId: number; origin: string }>;
}): string {
  const lines: string[] = [
    `<pinned_tabs>`,
    `primary tab: id=${pinned.primary.tabId} origin=${pinned.primary.origin}`,
    `(click / type / scroll / select / keyboard tools target the primary tab implicitly)`,
  ];
  if (pinned.secondaries.length > 0) {
    lines.push("secondary tabs (must specify tabId arg to target):");
    for (const t of pinned.secondaries) {
      lines.push(`  - id=${t.tabId} origin=${t.origin}`);
    }
  }
  lines.push("</pinned_tabs>");
  return lines.join("\n");
}
```

Add a paragraph to the tab-tools section describing `open_url` AND the multi-pin operability boundary (per advisor finding A — without this LLM tries `click({tabId: secondary})` which DOM tools don't accept, racks up K-10 rejects, aborts):

```
- open_url: Open a new tab at a URL. Always-high risk; user approves each call.
  After approval the new tab joins this session's pinned tabs (does NOT replace
  primary). Use `active: true` only when the user is expecting to see the page
  immediately; default `active: false` runs in background. Only http: / https:
  URLs accepted.

Multi-pin operability boundary (v1):
- Tab-level tools (list_tabs / get_tab_content / close_tabs / activate_tab /
  group_tabs / ungroup_tabs / move_tabs / open_url) accept any tabId in
  pinnedTabs and can target ANY pin via the `tabId` / `tabIds` argument.
- DOM and keyboard tools (click / type / scroll / select / wait / dispatch_keyboard_input
  / press_key) ALWAYS act on the primary pin only. They do NOT accept a `tabId`
  argument. To run a DOM action on a secondary pin you must FIRST close the
  primary pin's task (or open a new chat session) — there is no in-task way to
  "switch primary". `activate_tab` only changes the user's foreground view; it
  does NOT change which tab DOM tools target.
```

Update the loop call site `loop.ts:973-986` to pass primary + secondaries:

```ts
const primaryAndSecondaries = (() => {
  if (!ctx.pinned) {
    return { primary: { tabId: pinnedTabId, origin: pinnedOrigin }, secondaries: [] };
  }
  // ctx.pinned currently provides only primary; secondaries are read from
  // the session meta the SW dispatcher hands us. We thread them in below
  // (ctx.pinnedSecondaries — added in Step 5.11).
  return {
    primary: ctx.pinned,
    secondaries: ctx.pinnedSecondaries ?? [],
  };
})();

const systemMsg: AgentMessage = {
  role: "system",
  content: buildAgentSystemPrompt(
    task,
    keyboardSimEnabledAtStart,
    /* hasMetaTools */ true,
    primaryAndSecondaries,
  ),
};
```

- [ ] **Step 5.11: Thread `pinnedSecondaries` through `AgentLoopContext` and SW dispatcher (multi-site)**

Add to `AgentLoopContext` (loop.ts:74):

```ts
  /** Multi-pin v1 — secondary pins (everything beyond primary).
   *  Empty when the session has only the primary pin or no pin yet.
   *  Populated by SW dispatcher from session meta's pinnedTabs.slice(1). */
  pinnedSecondaries?: Array<{ tabId: number; origin: string }>;
```

**Update EVERY ctx.pinned construction site, not just chat-start + resume.** Per advisor finding C, the SW has at least four construction points and the `effective-pinned.ts` factory reads `meta.pinnedTabId/Origin` directly. Run:

```bash
grep -nE "meta\.pinnedTabId|meta\.pinnedOrigin|ctx\.pinned|pinned: " \
  src/background/index.ts src/background/effective-pinned.ts
```

For every match, replace direct legacy-field reads with the helper:
- `meta.pinnedTabId` / `meta.pinnedOrigin` paired reads → `const primary = getPrimaryPinFromMeta(meta);` followed by `primary.tabId` / `primary.origin`
- `ctx.pinned` constructions → also compute `pinnedSecondaries: getPinnedTabsFromMeta(meta).slice(1)`

Specifically the four known sites (verify with grep — line numbers may drift):
1. `src/background/index.ts` chat-start dispatch (~line 1195)
2. `src/background/index.ts` resume dispatch (~line 716)
3. `src/background/index.ts` `checkPinnedDrift` (~line 386)
4. `src/background/effective-pinned.ts` `makeResolveEffectivePinned` factory

Sample edit at each site:

```ts
import { getPinnedTabsFromMeta, getPrimaryPinFromMeta } from "@/lib/sessions/pinned-tabs";

const allPins = getPinnedTabsFromMeta(meta);
const pinned = allPins.length > 0 ? allPins[0] : pinnedFromBackfill;
const pinnedSecondaries = allPins.slice(1);
// … inside runAgentLoop({...}):
pinned,
pinnedSecondaries,
```

For `checkPinnedDrift` (line ~386 — the `meta.pinnedTabId === undefined || !meta.pinnedOrigin` shape):

```ts
const primary = getPrimaryPinFromMeta(meta);
if (!primary) {
  // M1 sessions don't have pin anchored at creation (M3-U2 backfill misses) —
  // skip drift check.
  return { drifted: false };
}
let tab: chrome.tabs.Tab;
try {
  tab = await chrome.tabs.get(primary.tabId);
} catch { … }
if (!currentOrigin || currentOrigin !== primary.origin) { … }
```

For `effective-pinned.ts`'s factory: the resolved-pinned path returns the primary pin only (no shape change at factory boundary), but the read of `meta.pinnedTabId/Origin` inside it must go through `getPrimaryPinFromMeta`.

- [ ] **Step 5.12: Run all loop + prompt tests**

Run: `pnpm vitest run src/lib/agent/loop.test.ts src/lib/agent/prompt.test.ts`
Expected: PASS — open_url payload + extract tests + system prompt block green; pre-existing tests still pass (the prompt signature change requires updating any existing prompt.test fixture call).

If `prompt.test.ts` fails on the signature change, update its fixtures to pass `{ primary, secondaries: [] }` shape — the test's intent is unchanged.

- [ ] **Step 5.13: Commit**

```bash
git add src/types/index.ts src/lib/agent/loop.ts src/lib/agent/loop.test.ts src/lib/agent/prompt.ts src/lib/agent/prompt.test.ts src/background/index.ts
git commit -m "feat(agent): SW dispatch open_url confirm payload + post-handler auto-pin push"
```

---

### Task 6: AgentConfirmCard render + SkillsList badge

**Files:**
- Modify: `src/sidepanel/components/AgentConfirmCard.tsx`
- Modify: `src/sidepanel/components/SkillsList.tsx`
- Modify: `src/sidepanel/components/AgentConfirmCard.test.tsx`

- [ ] **Step 6.1: Write failing test for `OpenUrlConfirmRow` rendering**

Add to `src/sidepanel/components/AgentConfirmCard.test.tsx`:

```ts
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentConfirmCard } from "./AgentConfirmCard";

describe("AgentConfirmCard — open_url branch", () => {
  const baseProps = {
    tool: "open_url",
    args: { url: "https://example.com/path", active: false },
    resolvedElement: undefined,
    riskReason: "Opening a new tab — review the destination URL on the confirm card.",
    onApprove: () => {},
    onReject: () => {},
  };

  it("renders URL full text and host (background variant)", () => {
    render(
      <AgentConfirmCard
        {...baseProps}
        openUrlPayload={{
          url: "https://example.com/path",
          origin: "https://example.com",
          host: "example.com",
          active: false,
        }}
      />,
    );
    expect(screen.getByText(/https:\/\/example\.com\/path/)).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText(/Background load/i)).toBeTruthy();
  });

  it("renders 'Steals focus' for active=true", () => {
    render(
      <AgentConfirmCard
        {...baseProps}
        args={{ url: "https://example.com/", active: true }}
        openUrlPayload={{
          url: "https://example.com/",
          origin: "https://example.com",
          host: "example.com",
          active: true,
        }}
      />,
    );
    expect(screen.getByText(/Steals focus/i)).toBeTruthy();
  });

  it("preserves IDN punycode in host display", () => {
    render(
      <AgentConfirmCard
        {...baseProps}
        args={{ url: "https://xn--80akhbyknj4f.com/", active: false }}
        openUrlPayload={{
          url: "https://xn--80akhbyknj4f.com/",
          origin: "https://xn--80akhbyknj4f.com",
          host: "xn--80akhbyknj4f.com",
          active: false,
        }}
      />,
    );
    expect(screen.getByText("xn--80akhbyknj4f.com")).toBeTruthy();
  });

  it("collapses URLs over 1024 chars behind an expand button", () => {
    const longUrl = "https://example.com/" + "a".repeat(1100);
    render(
      <AgentConfirmCard
        {...baseProps}
        args={{ url: longUrl, active: false }}
        openUrlPayload={{
          url: longUrl,
          origin: "https://example.com",
          host: "example.com",
          active: false,
        }}
      />,
    );
    // Initially collapsed — full URL not in DOM
    expect(screen.queryByText(longUrl)).toBeNull();
    // Expand button is present
    const btn = screen.getByRole("button", { name: /show full url/i });
    expect(btn).toBeTruthy();
  });
});
```

- [ ] **Step 6.2: Run test, confirm failure**

Run: `pnpm vitest run src/sidepanel/components/AgentConfirmCard.test.tsx`
Expected: FAIL — `openUrlPayload` prop unrecognized; render branch not implemented.

- [ ] **Step 6.3: Add `OpenUrlConfirmRow` and route it from AgentConfirmCard**

Edit `src/sidepanel/components/AgentConfirmCard.tsx`. Add the prop:

```ts
import type { OpenUrlConfirmPayload } from "@/types";

interface AgentConfirmCardProps {
  // … existing fields
  openUrlPayload?: OpenUrlConfirmPayload;
}
```

Add the component definition (near `OriginSummaryRow`):

```tsx
const OPEN_URL_FOLD_THRESHOLD = 1024;

function OpenUrlConfirmRow({ payload }: { payload: OpenUrlConfirmPayload }) {
  const [expanded, setExpanded] = useState(false);
  const folded = payload.url.length >= OPEN_URL_FOLD_THRESHOLD;
  const visibleUrl = !folded || expanded ? payload.url : payload.url.slice(0, 256) + "…";

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded border border-line bg-field px-2.5 py-1.5">
        <div className="text-[11px] text-fg-3">URL ({payload.url.length} chars)</div>
        <div className="break-all font-mono text-[12px] text-fg-1">{visibleUrl}</div>
        {folded ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-1 text-[11px] text-fg-2 underline hover:text-fg-1"
          >
            {expanded ? "Show less" : "Show full URL"}
          </button>
        ) : null}
      </div>
      <div role="status" className="rounded border border-line bg-field px-2.5 py-1.5 text-[12px]">
        <span className="text-fg-3">host:</span>{" "}
        <code className="font-mono text-fg-1">{payload.host}</code>
      </div>
      <div
        className={`rounded border px-2.5 py-1.5 text-[12px] ${
          payload.active
            ? "border-warning-line bg-warning-tint text-warning"
            : "border-line bg-field text-fg-2"
        }`}
      >
        {payload.active
          ? "Steals focus — opens in a new tab and immediately switches to it."
          : "Background load — opens in a new tab without switching focus. The page will load and execute scripts."}
      </div>
    </div>
  );
}
```

In the main component body, branch on `tool === "open_url"`:

```tsx
{props.openUrlPayload ? (
  <OpenUrlConfirmRow payload={props.openUrlPayload} />
) : props.tabTargets ? (
  // … existing tabTargets render
) : null}
```

(If `border-warning-line/bg-warning-tint/text-warning` tokens don't exist, fall back to existing `border-accent-line bg-accent-tint text-accent` — the brainstorm only requires visible distinction, not a new color.)

Update `describeAction` to handle open_url:

```ts
function describeAction(
  tool: string,
  resolvedElement: ResolvedElement | undefined,
  tabTargets: TabTarget[] | undefined,
  openUrlPayload: OpenUrlConfirmPayload | undefined,
): string {
  if (openUrlPayload) {
    return `open ${openUrlPayload.host}`;
  }
  // … existing logic
}
```

- [ ] **Step 6.4: Run AgentConfirmCard tests**

Run: `pnpm vitest run src/sidepanel/components/AgentConfirmCard.test.tsx`
Expected: PASS — 4 new test cases green.

- [ ] **Step 6.5: Add SkillsList badge for open_url**

Edit `src/sidepanel/components/SkillsList.tsx` — locate the rendered allowed-tools chip area for each skill row. Append a badge when the skill's `allowedTools` array includes `"open_url"`:

```tsx
{skill.allowedTools?.includes("open_url") ? (
  <span
    className="rounded border border-warning-line bg-warning-tint px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-warning"
    title="Each open_url call requires fresh user approval — confirm card per dispatch."
  >
    per-call gate
  </span>
) : null}
```

(Same color fallback as Step 6.3 if warning tokens don't exist.)

- [ ] **Step 6.6: Write a SkillsList visual test (or extend if existing tests cover this)**

Run: `ls src/sidepanel/components/SkillsList.test.* 2>/dev/null`

If no test file exists, skip the test and rely on manual visual verification at Task 7. If one exists, add:

```ts
it("renders 'per-call gate' badge for skills with open_url in allowedTools", async () => {
  // (assumes a render fixture that lets us mount SkillsList with a stubbed skill)
  const skill: SkillDefinition = {
    id: "skill_user_test",
    name: "Open Tabs",
    description: "Opens tabs",
    promptTemplate: "do it",
    toolSchema: { name: "x", description: "x", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    allowedTools: ["open_url", "done"],
    enabled: true,
    builtIn: false,
    author: "user",
  };
  // … mount + assertion that a "per-call gate" element renders
});
```

- [ ] **Step 6.7: Write the wire→useSession→Chat integration test (advisor finding B)**

Per the auto-memory `feedback_cross_layer_integration_tests.md` invariant ("any cross panel↔SW new wire field MUST have a wire→DisplayMessage transit regression test; high unit-test count cannot substitute"). Phase 5 acceptance bug was caused by exactly this miss — a unit-test-only verification let `screenshotPreview` slip through panel→display.

Add to `src/sidepanel/hooks/useSession.test.ts`:

```ts
import type { OpenUrlConfirmPayload } from "@/types";

describe("useSession — open_url confirm payload transit (wire → useSession → DisplayMessage)", () => {
  it("preserves openUrlPayload from SW message all the way through to the rendered confirm card prop", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Dispatch the matching session-confirm-request via the panel's port
    // mock (mirrors how the SW sends to panel).
    const sessionId = result.current.sessionId!;
    const payload: OpenUrlConfirmPayload = {
      url: "https://example.com/longpath",
      origin: "https://example.com",
      host: "example.com",
      active: false,
    };
    act(() => {
      // helper assumed to exist in test file: pushes a message to the
      // panel's persistent port listener
      simulatePortMessage({
        type: "agent-confirm-request",
        sessionId,
        confirmationId: "c1",
        tool: "open_url",
        args: { url: payload.url, active: false },
        riskReason: "Opening a new tab — review the destination URL on the confirm card.",
        openUrlPayload: payload,
      });
    });

    await waitFor(() => {
      const m = result.current.messages.find((msg) => msg.kind === "agent-confirm");
      expect(m).toBeTruthy();
      // KEY ASSERTION — the wire field survived through the DisplayMessage
      // shape that Chat.tsx hands to AgentConfirmCard. If Chat or useSession
      // strips openUrlPayload, this test fails before we ship.
      expect(m && "openUrlPayload" in m && (m as { openUrlPayload?: OpenUrlConfirmPayload }).openUrlPayload).toEqual(payload);
    });
  });

  it("Chat passes openUrlPayload from DisplayMessage to AgentConfirmCard prop", async () => {
    // Render Chat.tsx with a useSession that already has an open_url
    // confirm message in messages[]. The render must include the
    // confirm card with the payload visible.
    // NOTE: this test exercises the Chat.tsx DisplayMessage → prop
    // boundary specifically — that's the layer Phase 5's screenshotPreview
    // bug originated from (commit 517435d).
    const messages = [{
      kind: "agent-confirm" as const,
      confirmationId: "c1",
      tool: "open_url",
      args: { url: "https://example.com/", active: false },
      riskReason: "Opening a new tab",
      openUrlPayload: {
        url: "https://example.com/",
        origin: "https://example.com",
        host: "example.com",
        active: false,
      },
    }];
    // Use the existing Chat test harness (Chat.test.tsx already mounts
    // Chat with mocked useSession). Add a fixture variant that includes
    // openUrlPayload and assert the rendered card has the host string.
    renderChatWithMessages(messages);
    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeTruthy();
      expect(screen.getByText(/Background load/i)).toBeTruthy();
    });
  });
});
```

If `simulatePortMessage` / `renderChatWithMessages` helpers don't exist in the existing useSession.test.ts / Chat.test.tsx, lift them out of the existing port-mock setup blocks (search for `chrome.runtime.connect` mocks already in those files) — they're test-utility functions, not new infrastructure.

The KEY invariant the test enforces: `openUrlPayload` field must transit `PortMessageToPanel` → `useSession.handlePortMessage` → DisplayMessage record → Chat.tsx prop wiring → AgentConfirmCard prop. Any layer that strips or transforms the field during pass-through fails this test before merge.

- [ ] **Step 6.8: Run all sidepanel component + hook tests**

Run: `pnpm vitest run src/sidepanel`
Expected: PASS — including the new wire transit tests.

- [ ] **Step 6.9: Commit**

```bash
git add src/sidepanel/components/AgentConfirmCard.tsx src/sidepanel/components/AgentConfirmCard.test.tsx src/sidepanel/components/SkillsList.tsx src/sidepanel/hooks/useSession.test.ts
git commit -m "feat(panel): AgentConfirmCard renders open_url payload; SkillsList badge; wire→Display integration test"
```

---

### Task 7: Manifest bump, M3 trace doc update, integration smoke

**Files:**
- Modify: `public/manifest.json` (or `manifest.json` at root — locate via grep)
- Modify: `docs/solutions/2026-05-03-multi-session-invariant-trace.md`
- Modify: `CLAUDE.md` (Progress section — add Phase 4/M4 entry)

- [ ] **Step 7.1: Bump manifest version**

Run: `grep -rn "\"version\"" public/manifest.json src/manifest.ts manifest.json 2>/dev/null | head`

Locate manifest, edit version string:

```json
{
  "manifest_version": 3,
  "name": "Chrome AI Agent",
  "version": "0.5",
  …
}
```

- [ ] **Step 7.2: Append "Multi-pin v1" section to M3 trace doc**

Edit `docs/solutions/2026-05-03-multi-session-invariant-trace.md`. Append a new section at the end:

```markdown
## Multi-pin v1 (open_url + pinnedTabs[]) — invariants

| ID  | Invariant | Enforcement | Verified by |
| --- | --- | --- | --- |
| MP-1 | `pinnedTabs[]` is canonical; legacy `pinnedTabId/Origin` is derived alias | `getPinnedTabsFromMeta` reads array first, falls back to legacy | `pinned-tabs.test.ts` |
| MP-2 | Every meta write also writes legacy alias = `pinnedTabs[0]` | `indexEntryFromMeta` + `setSessionMeta` alias-fixup | `storage.test.ts` round-trip |
| MP-3 | Cross-session R7 lock = union of all sibling sessions' pinnedTabIds[] | `getActivePinnedTabs` flatten + `getCrossSessionPinnedTabIds` exclude-self | `pinned-tab-registry.test.ts` |
| MP-4 | Same tabId in 2 sessions' pinnedTabs is allowed (no R7 self-conflict) | `collectCrossSessionConflicts` already excludes `excludeSessionId` | existing `loop.test.ts` |
| MP-5 | open_url URL allow-list = http: \| https: + non-empty host + ≤4096 chars | `validateOpenUrlInput` | `open-url.test.ts` |
| MP-6 | open_url is always-high risk (G-1 gate enforced at build time) | `risk.ts` `ALWAYS_HIGH_TAB_TOOLS` includes open_url | `tool-names.test.ts` build-time check |
| MP-7 | open_url confirm card shows URL + origin (punycode) + active flag | `OpenUrlConfirmRow` in `AgentConfirmCard.tsx` | `AgentConfirmCard.test.tsx` |
| MP-8 | open_url success → push `{tabId, origin}` to calling session's pinnedTabs | `extractCreatedTabIdFromObservation` + `onOpenUrlAutoPin` | `loop.test.ts` |
| MP-9 | Phase 2 DOM/keyboard tools target primary pin (`pinnedTabs[0]`) implicitly | `ctx.pinned` set to primary in SW dispatch | `loop.test.ts` ctx-pinned tests |
| MP-10 | open_url K-10 reject counter shares the global `confirmRejections` map | `loop.ts` K-10 already keys on tool name | `loop.test.ts` K-10 tests |
| MP-11 | open_url skills carry "per-call gate" badge in SkillsList | `SkillsList.tsx` chip rendering | manual visual / SkillsList.test.tsx |

**Q&A on M3-U5 acceptance**: the multi-session locality regression test in `loop.test.ts` (`buildSessionAgentSnapshot independence` + `collectCrossSessionConflicts per-dispatch independence`) carries naturally — `pinnedTabs[]` is per-session storage and `getCrossSessionPinnedTabIds` already excludes the calling session. Multi-pin does NOT weaken the M3-U4 R7 baseline.
```

- [ ] **Step 7.3: Append Phase 4/M4 entry to CLAUDE.md Progress**

Edit `CLAUDE.md` Progress section. Append:

```markdown
- **Phase 4 / M4 (open_url + multi-pin) — COMPLETED**: `SessionMeta.pinnedTabs?: Array<{tabId, origin}>` + `SessionIndexEntry.pinnedTabIds?: number[]` schema upgrade with `pinned-tabs.ts` normalization helper (legacy `pinnedTabId/Origin` kept as v1 alias = `pinnedTabs[0]`, drop in v1.1+v1.2); `getActivePinnedTabs` flattens to multi-pin union; `getCrossSessionPinnedTabIds` excludes calling session's full pinnedTabIds array (R7 stays correct under multi-pin). New `open_url(url, active=false)` tool with R6 `http:|https:` + non-empty host allow-list + 4096-char hard cap, R7 invalid-URL/scheme isError reject (LLM re-plans, not task abort), always-high risk with G-1 build-time gate. SW dispatch synthesizes dedicated `OpenUrlConfirmPayload` (URL + origin + host + active flag) since the destination tab does not exist; AgentConfirmCard renders host (punycode-correct via URL.host) + active-flag tag (`Steals focus` / `Background load`) + ≥1024-char fold. Post-handler auto-pin push: loop scans observation for `open_url:created:<tabId>` marker and calls SW-provided `onOpenUrlAutoPin` to append `{tabId, origin}` to session meta (single `setSessionMeta` writeAtomic). System prompt switches `<pinned_tab>` → `<pinned_tabs>` listing primary + secondary pins so LLM can target via tab tools without list_tabs round-trip. SkillsList shows "per-call gate" badge for skills whose allowedTools includes open_url. Manifest bumped 0.4 → 0.5.
```

- [ ] **Step 7.4: Run the full test suite**

Run: `pnpm vitest run`
Expected: ALL PASS — every test green; no warnings about uncaught rejections.

- [ ] **Step 7.5: Run the production build**

Run: `pnpm build`
Expected: build succeeds without errors. (Verifies the G-1 build-time gate in `risk.ts` and the TOOL_CLASSES exhaustive check in `tool-names.ts` both pass at module load.)

- [ ] **Step 7.6: Manual integration verification (browser smoke)**

Run: `pnpm dev`
1. Load unpacked extension from `dist/` at `chrome://extensions`.
2. Open side panel; ensure no errors in the SW console.
3. Send a chat message: `Open https://example.com in a new tab` (or invoke a slash skill that calls open_url).
4. Verify confirm card shows URL, host (`example.com`), and "Background load" subtitle.
5. Approve. Verify a new tab opens at example.com (background, no focus steal).
6. Verify the side panel's pinned-tab indicator still reflects the primary pin (NOT the new tab).
7. Send a follow-up: `What's in the pinned secondary tab?` — verify the system prompt block surfaces the new pin (LLM should not need to call list_tabs to know about it).
8. Reject `open https://elsewhere.com` 3× in a row — verify K-10 task abort fires (matches existing close_tabs/group_tabs fatigue UX).
9. Try `open chrome://settings` — verify the LLM gets `unsafe-url-scheme` observation and re-plans without aborting.

If any step fails, capture the failure, debug, and iterate. Do NOT mark complete until all 9 steps pass.

- [ ] **Step 7.7: Commit**

```bash
git add public/manifest.json docs/solutions/2026-05-03-multi-session-invariant-trace.md CLAUDE.md
git commit -m "chore: bump manifest to 0.5; document multi-pin v1 invariants in M3 trace + CLAUDE.md"
```

- [ ] **Step 7.8: Open PR**

Run: `git push -u origin <branch>`
Then `gh pr create` with body summarizing:
- new `open_url` tool (always-high; URL allow-list + 4096-char cap)
- `pinnedTabs[]` schema upgrade (legacy alias kept for v1)
- multi-pin R7 union
- system prompt `<pinned_tabs>` block
- AgentConfirmCard render branch
- SkillsList "per-call gate" badge

---

## Self-Review Checklist (run AFTER all tasks)

- [ ] Every brainstorm requirement R1-R14 maps to at least one task — verified inline below.
  - R1 (open_url tool): Task 4
  - R2 (auto-pin push, no replace): Task 5 (auto-pin block)
  - R3 (SessionMeta pinnedTabs[]): Task 1 + 2
  - R4 (SessionIndexEntry pinnedTabIds[]): Task 1 + 2
  - R5 (M2/M3 lazy migration): Task 1 (helper does derivation; no eager script needed)
  - R6 (URL allow-list + length cap): Task 4 (`validateOpenUrlInput`)
  - R7 (URL reject = isError, not abort): Task 4 (handler returns `{success: false}`; loop continues)
  - R8 (always-high in risk.ts): Task 4 (G-1 gate)
  - R9 (confirm card payload — URL, origin, active flag, fold): Task 5 + 6
  - R10 (a11y baseline): Task 6 (reuses existing role=dialog / aria-labelledby / role=status; OpenUrlConfirmRow inherits)
  - R11 (skill allowedTools may include open_url): Task 4 (`open_url` is in `ALL_KNOWN_NON_SKILL_TOOL_NAMES`)
  - R12 (SkillsList per-call-gate badge): Task 6
  - R13 (cross-session multi-pin sharing — sibling sessions pin same tabId without R7 reject): Task 3.1's "sibling sessions pin same tabId" test case + the existing `excludeSessionId` carve-out in `getCrossSessionPinnedTabIds`
  - R14 (open_url new tab never collides with sibling sessions): structurally true — `chrome.tabs.create` returns a fresh id; verified in Task 7.6 step 5.
  - **Wire transit invariant** (auto-memory `feedback_cross_layer_integration_tests.md`): Task 6.7's two wire→useSession→Chat→AgentConfirmCard regression tests
  - **Multi-pin DOM operability boundary** (advisor finding A): Task 5.10's system-prompt boundary paragraph (DOM/keyboard tools always primary; tab-level tools accept any pin's tabId)
- [ ] No placeholder text. Every code step shows actual code. Bash commands include expected results.
- [ ] Type consistency: `OpenUrlConfirmPayload` (Task 5) matches the prop type in AgentConfirmCard (Task 6). `extractCreatedTabIdFromObservation` (Task 5.8) matches `OPEN_URL_RESULT_PREFIX` from `tabs.ts` (Task 4.3).
- [ ] G-1 build-time gate: `open_url` added to `TAB_TOOL_NAMES` (Task 4.4) AND `ALWAYS_HIGH_TAB_TOOLS` (Task 4.5) AND `TOOL_CLASSES` (Task 4.4) — all three required for build to succeed.
- [ ] Legacy alias rule: writers always emit `pinnedTabId/Origin = pinnedTabs[0]` (Task 2.3, 2.5); readers prefer `pinnedTabs` and fall back to legacy (Task 1.4 helper).
- [ ] R7 cross-session lock: union semantics tested in Task 3.1; same-tabId-across-sessions allowed (`excludeSessionId` carve-out preserved).

---

## Out-of-scope (deferred to v1.1+)

- `nav_pinned_tab` cross-origin nav (the original v1 P0; deferred per brainstorm decision)
- Drop legacy `pinnedTabId/pinnedOrigin` writers (v1.1) and readers + types (v1.2)
- `pinnedTabs[]` capacity cap (v1.1 once usage data exists)
- Auto-cleanup of closed tabs from `pinnedTabs[]` (v1 lets stale entries linger; `chrome.tabs.get` rejects naturally)
- Cross-window `open_url` (G-2 gate — deferred until confirm wire carries source/target window context)
- URL phishing reputation black-list (v1 trusts user approval)
