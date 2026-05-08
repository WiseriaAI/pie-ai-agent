# open_url + Multi-Pin (Path A: focus_tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agents to create new tabs (`open_url`) and operate across multiple owned tabs in a single task (`focus_tab` to switch the snapshotted tab), composing cleanly with the M5 three-mode `pinMode` state machine that just shipped.

**Architecture:** Replace `SessionMeta.pinnedTabId/Origin` (single) with `SessionMeta.pinnedTabs[]` (array of `{tabId, origin}`). Add `SessionAgentState.currentFocusTabId` (task-scoped pointer into the array; default = `pinnedTabs[0]`). Two new tools — `focus_tab(tabId)` (low risk, snapshot-barrier: takes effect next iteration) and `open_url(url, active?)` (always-high, pushes new tab into `pinnedTabs[]`). All existing per-pin gates (R7 cross-session lock, K-9 close protection, drift check, pageChanged banner) extend to walk the array. Lazy normalize-on-write migration drops legacy single fields after first `setSessionMeta`.

**Tech Stack:** TypeScript 6, React 19, Chrome MV3, Vitest + happy-dom + @testing-library/react.

**Supersedes:** `docs/plans/2026-05-04-tabs-create-and-multi-pin.md` (pre-M5 single-pin assumption).

---

## Design context

### Why Path A (focus_tab + iteration boundary)

- LLM picks which tab is "active" via `focus_tab(tabId)`; DOM tools (click/type/scroll/screenshot/get_text) keep their unchanged schemas and read `ctx.tabId` implicitly.
- `focus_tab` is a **snapshot barrier**: it updates `SessionAgentState.currentFocusTabId`, but the current iteration's snapshot was taken before dispatch. So the new focus takes effect on the **next** iteration's snapshot. This avoids per-iteration N×snapshot cost (Path B) and stale-element-index hazards (clicking element 5 of tab A's snapshot while tabId resolves to tab B).
- Workflow shape: `focus_tab(tabA) → read → focus_tab(tabB) → write → focus_tab(tabA) → ...`. Prompt tells the LLM that focus_tab takes effect next iteration; do not batch other tools after focus_tab in the same response if they are intended for the new focus.

### Lifecycle invariants (post-this-plan)

| pinMode | `pinnedTabs[]` shape | `currentFocusTabId` |
|---|---|---|
| `auto` | empty / undefined | undefined (no in-flight task) |
| `task` | ≥1; index 0 = chat-start capture; later indices = open_url-created tabs | one of pinnedTabs.tabId; defaults to pinnedTabs[0].tabId |
| `user` | ≥1; user-toggled tabs (multi-select supported in v1) | pinnedTabs[0].tabId |

- **chat-start (auto→task)**: SW writes `pinnedTabs: [{capture}]` (single element). `currentFocusTabId` reset to `pinnedTabs[0].tabId`.
- **open_url**: pushes new entry; `currentFocusTabId` UNCHANGED (LLM must explicitly `focus_tab` to switch).
- **focus_tab**: validates `tabId ∈ pinnedTabs`, mutates `currentFocusTabId`. No tab state mutation.
- **emitDone (task→auto)**: clears entire `pinnedTabs[]` AND `currentFocusTabId`.
- **user-mode dropdown**: toggles individual tab membership in pinnedTabs[]; first toggle from auto enters user mode; unpicking the last tab flips back to auto.

### Resolved Outstanding Questions (from brainstorm § Outstanding Questions)

1. **Schema migration**: **Clean break, no migration code.** User confirmed they will reinstall to clear chrome.storage. All legacy single-field paths (`SessionMeta.pinnedTabId/Origin`, `SessionIndexEntry.pinnedTabId`, `RiskClassifyContext.pinnedOrigin`, `AgentLoopContext.pinned`) are **deleted outright**. No back-compat fallback in helpers / registry / risk classifier. Existing M5 sessions on disk will fail to load post-upgrade — acceptable since user base is "self-test only" and reinstall is the intended path.
2. **tabId selection per tool call**: Path A — DOM tools implicit (use `ctx.tabId` = currently-focused). Tab tools (`close_tabs`/`group_tabs`/`get_tab_content`/etc.) explicit (already accept `tabIds` arg). New `focus_tab` switches focus.
3. **R7 cross-session lock under multi-pin**: `getActivePinnedTabs()` expands `pinnedTabIds[]` per session into one entry per (sessionId, tabId). Sibling session's write tool hitting any of caller's `pinnedTabs[].tabId` → reject with R7 message. Sibling pinning the same tab is allowed (set membership ≠ exclusive lock).
4. **URL.protocol allowlist edge cases**: strict `protocol === 'http:' || protocol === 'https:'`. percent-encoded scheme parses to non-`http:` and rejects. Relative URL throws in `new URL(...)` and rejects. No special handling needed beyond the strict allowlist.

### File map

| File | Touch | Responsibility |
|---|---|---|
| `src/lib/sessions/types.ts` | Modify | **Replace** `pinnedTabId`/`pinnedOrigin` with `pinnedTabs[]` on `SessionMeta`. **Replace** `pinnedTabId` with `pinnedTabIds[]` on `SessionIndexEntry`. Add `currentFocusTabId?` to `SessionAgentState`. Legacy fields deleted, not deprecated. |
| `src/lib/sessions/pin-state.ts` | Modify | Rewrite all helpers to operate on array. Add `getPrimaryPin`, `addPinToMeta`, `removePinFromMeta`, `togglePinTabUserMode`. No legacy fallback. |
| `src/lib/sessions/storage.ts` | Modify | `indexEntryFromMeta` writes `pinnedTabIds[]`; `upgradeAutoToTaskAtChatStart` writes `pinnedTabs: [{...}]`. No normalize-on-write helper (no legacy data path). |
| `src/lib/sessions/pinned-tab-registry.ts` | Modify | Read `pinnedTabIds[]`, expand per-tab entries. No legacy fallback. |
| `src/lib/agent/risk.ts` | Modify | **Replace** `RiskClassifyContext.pinnedOrigin` with `pinnedTabs[]`. `hasCrossOriginTab` walks array. |
| `src/lib/agent/types.ts` | Modify | `ToolHandlerContext.pinnedTabs?: Array<{tabId, origin}>`. |
| `src/lib/agent/loop.ts` | Modify | **Replace** `AgentLoopContext.pinned` (single) with `pinnedTabs[]` + `initialFocusTabId`. Per-iteration snapshot reads focused tab. emitDone clears whole array. Tool dispatch passes `pinnedTabs` through ctx. |
| `src/lib/agent/tools/tabs.ts` | Modify | Add `focusTabTool` and `openUrlTool`. K-9 in `closeTabsTool` checks intersection with `pinnedTabs[]`. |
| `src/lib/agent/tool-names.ts` | Modify | Add `"focus_tab"` and `"open_url"` to `TAB_TOOL_NAMES` + `TOOL_CLASSES`. |
| `src/lib/agent/prompt-builder.ts` | Modify | List pinnedTabs + current focus in tab tools section. |
| `src/background/index.ts` | Modify | `checkPinnedDrift` walks array. `captureSwActivePinned` unchanged (SW captures one tab; loop pushes from open_url). Confirm card payload for open_url. |
| `src/sidepanel/components/Chat.tsx` | Modify | `pageChanged` effect filters `chrome.tabs.onUpdated` by `tabId ∈ pinnedTabIds`. Top-bar PIN row shows count badge for ≥2 pins. |
| `src/sidepanel/components/AgentConfirmCard.tsx` | Modify | New variant for `open_url` confirm: URL display (≥1024 chars folded; >4096 reject upstream), `URL.host` (punycode), active=true|false badge. |
| `src/sidepanel/components/SkillsList.tsx` | Modify | Skills with `allowedTools.includes('open_url')` get a "Tab creation requires per-call approval" badge. |
| `src/sidepanel/hooks/useSession.ts` | Modify | **Replace** `pinnedOrigin`/`pinnedTabId` state with `pinnedTabs` array. **Replace** `setUserPin` API with `togglePinTab(tabId, origin)` (toggles membership; auto→user on first toggle; flips back to auto when last entry unpicked). |
| `src/sidepanel/components/PinnedTabDropdown.tsx` | Modify | Multi-select: each tab row toggles membership; checkmark per pinned entry; "Auto" row clears all and flips to auto. |
| `manifest.json` | Modify | 0.5.1 → 0.5.2. |
| `docs/solutions/2026-05-03-multi-session-invariant-trace.md` | Append | Multi-pin section. |

---

## Task 1: Schema + helper functions (clean break)

Goal: **Replace** legacy single-pin fields with `pinnedTabs[]` on `SessionMeta`, `pinnedTabIds[]` on `SessionIndexEntry`. Add `currentFocusTabId` to `SessionAgentState`. Rewrite `pin-state.ts` helpers without legacy fallback. Pure data-layer change with no SW or panel touch.

**Migration policy:** legacy fields are DELETED outright (user reinstalls extension to clear chrome.storage). No fallback code paths in helpers.

**Files:**
- Modify: `src/lib/sessions/types.ts`
- Modify: `src/lib/sessions/pin-state.ts`
- Test: `src/lib/sessions/pin-state.test.ts`

- [ ] **Step 1: Write failing tests for new array helpers**

**Replace** the existing `pin-state.test.ts` body (M5 single-pin tests). The clean-break means we don't need legacy fallback tests.

```typescript
import { describe, it, expect } from "vitest";
import {
  getPrimaryPin,
  addPinToMeta,
  removePinFromMeta,
  getEffectivePinMode,
  clearTaskPinIfActive,
  togglePinTabUserMode,
  clearUserPin,
} from "./pin-state";
import type { SessionMeta, SessionAgentState } from "./types";

const FRESH = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: "s1",
  createdAt: 0,
  lastAccessedAt: 0,
  status: "active",
  messages: [],
  ...overrides,
});

const AGENT = (stepIndex: number): SessionAgentState => ({
  agentMessages: [],
  stepIndex,
  skillExecutionScopeStack: [],
  hasImageContent: false,
});

describe("v1.5 pin-state helpers (multi-pin Path A)", () => {
  it("getPrimaryPin returns first entry of pinnedTabs", () => {
    const meta = FRESH({
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    expect(getPrimaryPin(meta)).toEqual({ tabId: 12, origin: "https://a.com" });
  });

  it("getPrimaryPin returns undefined for empty / absent array", () => {
    expect(getPrimaryPin(FRESH())).toBeUndefined();
    expect(getPrimaryPin(FRESH({ pinnedTabs: [] }))).toBeUndefined();
  });

  it("addPinToMeta pushes new entry", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    const next = addPinToMeta(meta, { tabId: 13, origin: "https://b.com" });
    expect(next.pinnedTabs).toEqual([
      { tabId: 12, origin: "https://a.com" },
      { tabId: 13, origin: "https://b.com" },
    ]);
  });

  it("addPinToMeta is idempotent for duplicate tabId", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    const next = addPinToMeta(meta, { tabId: 12, origin: "https://a.com" });
    expect(next.pinnedTabs).toHaveLength(1);
  });

  it("removePinFromMeta drops matching tabId", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    const next = removePinFromMeta(meta, 13);
    expect(next.pinnedTabs).toEqual([{ tabId: 12, origin: "https://a.com" }]);
  });

  it("clearTaskPinIfActive empties pinnedTabs array in task mode", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    const next = clearTaskPinIfActive(meta);
    expect(next.pinMode).toBe("auto");
    expect(next.pinnedTabs).toBeUndefined();
  });

  it("clearTaskPinIfActive preserves user-mode array", () => {
    const meta = FRESH({
      pinMode: "user",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    expect(clearTaskPinIfActive(meta)).toBe(meta);
  });

  describe("togglePinTabUserMode", () => {
    it("from auto: first toggle adds + flips to user mode", () => {
      const meta = FRESH({ pinMode: "auto" });
      const next = togglePinTabUserMode(meta, { tabId: 12, origin: "https://a.com" });
      expect(next.pinMode).toBe("user");
      expect(next.pinnedTabs).toEqual([{ tabId: 12, origin: "https://a.com" }]);
    });

    it("from user with one pin: toggling another adds (multi-select)", () => {
      const meta = FRESH({
        pinMode: "user",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      });
      const next = togglePinTabUserMode(meta, { tabId: 13, origin: "https://b.com" });
      expect(next.pinMode).toBe("user");
      expect(next.pinnedTabs).toEqual([
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ]);
    });

    it("from user with two pins: toggling existing tab removes it", () => {
      const meta = FRESH({
        pinMode: "user",
        pinnedTabs: [
          { tabId: 12, origin: "https://a.com" },
          { tabId: 13, origin: "https://b.com" },
        ],
      });
      const next = togglePinTabUserMode(meta, { tabId: 12, origin: "https://a.com" });
      expect(next.pinMode).toBe("user");
      expect(next.pinnedTabs).toEqual([{ tabId: 13, origin: "https://b.com" }]);
    });

    it("from user with one pin: toggling that tab removes it AND flips to auto", () => {
      const meta = FRESH({
        pinMode: "user",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      });
      const next = togglePinTabUserMode(meta, { tabId: 12, origin: "https://a.com" });
      expect(next.pinMode).toBe("auto");
      expect(next.pinnedTabs).toBeUndefined();
    });

    it("from task mode: refuses (no-op identity) — loop owns task pins", () => {
      const meta = FRESH({
        pinMode: "task",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      });
      const next = togglePinTabUserMode(meta, { tabId: 13, origin: "https://b.com" });
      expect(next).toBe(meta);
    });
  });

  it("clearUserPin clears all pinnedTabs and flips to auto; no-op for task mode", () => {
    const userMeta = FRESH({
      pinMode: "user",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    const cleared = clearUserPin(userMeta);
    expect(cleared.pinMode).toBe("auto");
    expect(cleared.pinnedTabs).toBeUndefined();

    const taskMeta = FRESH({
      pinMode: "task",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    expect(clearUserPin(taskMeta)).toBe(taskMeta);
  });

  it("getEffectivePinMode infers 'task' from non-empty pinnedTabs + in-flight agent", () => {
    const meta = FRESH({
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    expect(getEffectivePinMode(meta, AGENT(3))).toBe("task");
  });

  it("getEffectivePinMode returns 'auto' for empty array even with in-flight agent", () => {
    const meta = FRESH({ pinnedTabs: [] });
    expect(getEffectivePinMode(meta, AGENT(3))).toBe("auto");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/sessions/pin-state.test.ts`
Expected: All new test cases FAIL with "getPrimaryPin is not a function" / "addPinToMeta is not a function" / etc., or with assertion mismatches because helpers still operate on single fields.

- [ ] **Step 3: Update `SessionMeta`, `SessionAgentState`, `SessionIndexEntry` types (additive; legacy fields retained as @deprecated)**

> **IMPORTANT — phased deletion:** legacy fields (`SessionMeta.pinnedTabId/Origin`, `SessionIndexEntry.pinnedTabId`) MUST stay declared in this task to avoid breaking compile across all callsites (storage.ts, useSession.ts, Chat.tsx, background/index.ts, etc.). They're marked `@deprecated v1.5` here, **not actually removed**. Final cleanup Task (Task 10) deletes them once Tasks 2-9 have migrated every consumer to read `pinnedTabs[]` instead. Helpers in this task's pin-state.ts MUST still treat the array as the only source of truth (no legacy fallback) — that's the runtime clean-break.

In `src/lib/sessions/types.ts`, **add** to `SessionMeta`:

```typescript
  /**
   * v1.5 multi-pin (Path A) — array of pinned tabs owned by this session.
   *
   * Lifecycle invariants:
   *   - pinMode='auto'  → empty / undefined
   *   - pinMode='task'  → pinnedTabs[0] = chat-start capture; pinnedTabs[1..N]
   *                       = open_url-created tabs in chronological order
   *   - pinMode='user'  → ≥1 entries; user-toggled via PinnedTabDropdown.
   *
   * Replaces pre-v1.5 `pinnedTabId` + `pinnedOrigin` single fields outright
   * (no back-compat fallback — clean break, user reinstalls extension).
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
```

In `SessionAgentState`, add:

```typescript
  /**
   * v1.5 — task-scoped pointer to the currently-focused tab among
   * `SessionMeta.pinnedTabs[]`. Snapshot is taken on this tab each
   * iteration. Mutated by `focus_tab` tool; reset to pinnedTabs[0].tabId
   * at chat-start; cleared at task end (via tombstone).
   */
  currentFocusTabId?: number;
```

**Mark** the existing `pinnedTabId?: number` and `pinnedOrigin?: string` fields with `@deprecated v1.5 — read by legacy callsites only; will be removed in Task 10 once all consumers migrate. Storage no longer writes these.` (Do NOT delete the field declarations.)

In `SessionIndexEntry`, **add** (alongside the existing `pinnedTabId?: number`, which is also marked `@deprecated v1.5`):

```typescript
  /**
   * v1.5 multi-pin — flat list of pinned tab ids for cross-session R7 lock
   * lookup. Replaces single `pinnedTabId` outright.
   */
  pinnedTabIds?: number[];
```

- [ ] **Step 4: Rewrite `pin-state.ts` (clean break, no legacy fallback)**

Replace `src/lib/sessions/pin-state.ts` body. Keep file header comment. Full content:

```typescript
import type { SessionMeta, SessionAgentState } from "./types";

export type PinMode = "auto" | "task" | "user";
export type Pin = { tabId: number; origin: string };

/** Read the primary (oldest) pin. Returns undefined when no pin. */
export function getPrimaryPin(meta: SessionMeta): Pin | undefined {
  if (meta.pinnedTabs && meta.pinnedTabs.length > 0) return meta.pinnedTabs[0];
  return undefined;
}

/**
 * Append a pin. Idempotent on duplicate tabId. Caller is responsible for
 * pinMode (open_url during agent execution invariantly has mode='task').
 */
export function addPinToMeta(meta: SessionMeta, pin: Pin): SessionMeta {
  const current = meta.pinnedTabs ?? [];
  if (current.some((p) => p.tabId === pin.tabId)) return meta;
  return { ...meta, pinnedTabs: [...current, pin] };
}

/** Remove the entry matching tabId. No-op when absent. */
export function removePinFromMeta(meta: SessionMeta, tabId: number): SessionMeta {
  const current = meta.pinnedTabs ?? [];
  if (!current.some((p) => p.tabId === tabId)) return meta;
  return { ...meta, pinnedTabs: current.filter((p) => p.tabId !== tabId) };
}

/**
 * Effective pin mode. Reads explicit pinMode if set; else infers:
 *   - non-empty pinnedTabs[] AND in-flight agent → 'task'
 *   - otherwise → 'auto'
 */
export function getEffectivePinMode(
  meta: SessionMeta,
  agent: SessionAgentState | null,
): PinMode {
  if (meta.pinMode) return meta.pinMode;
  const hasPin = meta.pinnedTabs !== undefined && meta.pinnedTabs.length > 0;
  if (hasPin && agent !== null && agent.stepIndex > 0) return "task";
  return "auto";
}

/**
 * emitDone helper. Task mode → flip to auto + clear array. user/auto → identity.
 */
export function clearTaskPinIfActive(meta: SessionMeta): SessionMeta {
  if (meta.pinMode !== "task") return meta;
  const next: SessionMeta = { ...meta, pinMode: "auto" };
  delete next.pinnedTabs;
  return next;
}

/**
 * UI dropdown handler — toggle a tab's membership in user-mode pinnedTabs[].
 *
 * Semantics:
 *   - From `auto`: adds pin, flips mode → `user`.
 *   - From `user` containing pin: removes pin. If pinnedTabs becomes empty,
 *     flips back to `auto` (clears the array).
 *   - From `user` not containing pin: appends pin (multi-select).
 *   - From `task`: refuses (returns identity) — loop owns task-mode pins.
 */
export function togglePinTabUserMode(meta: SessionMeta, pin: Pin): SessionMeta {
  if (meta.pinMode === "task") return meta;
  const current = meta.pinnedTabs ?? [];
  const has = current.some((p) => p.tabId === pin.tabId);
  if (has) {
    const remaining = current.filter((p) => p.tabId !== pin.tabId);
    if (remaining.length === 0) {
      const next: SessionMeta = { ...meta, pinMode: "auto" };
      delete next.pinnedTabs;
      return next;
    }
    return { ...meta, pinMode: "user", pinnedTabs: remaining };
  }
  return { ...meta, pinMode: "user", pinnedTabs: [...current, pin] };
}

/**
 * UI dropdown "Auto" row handler — flip user → auto, clear all pins.
 * No-op for non-user modes (loop owns task-mode pins; auto is already cleared).
 */
export function clearUserPin(meta: SessionMeta): SessionMeta {
  if (meta.pinMode !== "user") return meta;
  const next: SessionMeta = { ...meta, pinMode: "auto" };
  delete next.pinnedTabs;
  return next;
}
```

- [ ] **Step 5: Run tests + commit**

Run: `pnpm vitest run src/lib/sessions/pin-state.test.ts`
Expected: PASS (all new + existing M5 tests).

Run: `pnpm vitest run` to verify no regressions in other suites.

```bash
git add src/lib/sessions/types.ts src/lib/sessions/pin-state.ts src/lib/sessions/pin-state.test.ts
git commit -m "feat(sessions)!: replace single pin fields with pinnedTabs[] + togglePinTabUserMode (Path A unit 1)

BREAKING: SessionMeta.pinnedTabId/Origin and SessionIndexEntry.pinnedTabId
deleted. Existing chrome.storage data must be cleared (extension reinstall)."
```

---

## Task 2: Storage writes `pinnedTabIds[]` to index + chat-start writes array

Goal: `indexEntryFromMeta` writes `pinnedTabIds[]` derived from `pinnedTabs[]`. `upgradeAutoToTaskAtChatStart` writes the new array shape. No migration helper — clean break.

**Files:**
- Modify: `src/lib/sessions/storage.ts`
- Test: `src/lib/sessions/storage.test.ts` (append cases; remove old single-pin tests)

- [ ] **Step 1: Write failing tests**

Append to `src/lib/sessions/storage.test.ts` (and **delete** any existing tests that assert on `meta.pinnedTabId` / `meta.pinnedOrigin` — they reference deleted fields):

```typescript
describe("v1.5 multi-pin storage", () => {
  beforeEach(() => {
    chrome.storage.local._reset();
  });

  it("indexEntryFromMeta writes pinnedTabIds[] from array", async () => {
    const meta: SessionMeta = {
      id: "s1",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    };
    await setSessionMeta(meta);
    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === "s1");
    expect(entry?.pinnedTabIds).toEqual([12, 13]);
  });

  it("indexEntryFromMeta omits pinnedTabIds when array empty (auto mode)", async () => {
    const meta: SessionMeta = {
      id: "s2",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "auto",
    };
    await setSessionMeta(meta);
    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === "s2");
    expect(entry?.pinnedTabIds).toBeUndefined();
  });

  it("upgradeAutoToTaskAtChatStart writes pinnedTabs:[{capture}]", async () => {
    const meta: SessionMeta = {
      id: "s3",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "auto",
    };
    await setSessionMeta(meta);
    const result = await upgradeAutoToTaskAtChatStart("s3", async () => ({
      tabId: 42,
      origin: "https://example.com",
    }));
    expect(result).toEqual({ tabId: 42, origin: "https://example.com" });
    const back = await getSessionMeta("s3");
    expect(back?.pinMode).toBe("task");
    expect(back?.pinnedTabs).toEqual([{ tabId: 42, origin: "https://example.com" }]);
  });

  it("upgradeAutoToTaskAtChatStart no-op when already in task mode", async () => {
    const meta: SessionMeta = {
      id: "s4",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "task",
      pinnedTabs: [{ tabId: 5, origin: "https://x.com" }],
    };
    await setSessionMeta(meta);
    await setSessionAgent("s4", {
      agentMessages: [],
      stepIndex: 1,
      skillExecutionScopeStack: [],
      hasImageContent: false,
    });
    const result = await upgradeAutoToTaskAtChatStart("s4", async () => ({
      tabId: 999,
      origin: "https://other.com",
    }));
    expect(result).toBeNull();
    const back = await getSessionMeta("s4");
    expect(back?.pinnedTabs).toEqual([{ tabId: 5, origin: "https://x.com" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/sessions/storage.test.ts -t "v1.5 multi-pin"`
Expected: FAIL — `indexEntryFromMeta` reads `meta.pinnedTabId` (deleted field, type-error first).

- [ ] **Step 3: Update `indexEntryFromMeta`**

In `src/lib/sessions/storage.ts:90-100`, replace the function body:

```typescript
function indexEntryFromMeta(meta: SessionMeta): SessionIndexEntry {
  const entry: SessionIndexEntry = {
    id: meta.id,
    lastAccessedAt: meta.lastAccessedAt,
    status: meta.status,
    messageCount: meta.messages.length,
  };
  if (meta.title !== undefined) entry.title = meta.title;
  if (meta.pinnedTabs && meta.pinnedTabs.length > 0) {
    entry.pinnedTabIds = meta.pinnedTabs.map((p) => p.tabId);
  }
  return entry;
}
```

- [ ] **Step 4: Update `upgradeAutoToTaskAtChatStart`**

In `src/lib/sessions/storage.ts`, replace the existing body:

```typescript
export async function upgradeAutoToTaskAtChatStart(
  sessionId: string,
  captureFn: () => Promise<{ tabId: number; origin: string } | null>,
): Promise<{ tabId: number; origin: string } | null> {
  const meta = await getSessionMeta(sessionId);
  if (!meta) return null;
  const agent = await getSessionAgent(sessionId);
  const mode = getEffectivePinMode(meta, agent);
  if (mode !== "auto") return null;
  const pin = await captureFn();
  if (!pin) return null;
  await setSessionMeta({
    ...meta,
    pinMode: "task",
    pinnedTabs: [pin],
  });
  return pin;
}
```

`setSessionMeta` itself needs no normalize helper — the legacy fields no longer exist on `SessionMeta`, so the type system enforces correct shape.

- [ ] **Step 5: Run tests + commit**

Run: `pnpm vitest run`
Expected: PASS.

```bash
git add src/lib/sessions/storage.ts src/lib/sessions/storage.test.ts
git commit -m "feat(sessions): write pinnedTabIds[] to index + array shape on chat-start (Path A unit 2)"
```

---

## Task 3: Cross-session R7 registry reads array

Goal: `getActivePinnedTabs()` expands `pinnedTabIds[]` into one ActivePinnedTab entry per (sessionId, tabId). Falls back to legacy `pinnedTabId` for unmigrated index entries.

**Files:**
- Modify: `src/lib/sessions/pinned-tab-registry.ts`
- Test: `src/lib/sessions/pinned-tab-registry.test.ts` (append cases — file may already exist; if not, create)

- [ ] **Step 1: Write failing tests**

In `src/lib/sessions/pinned-tab-registry.test.ts`:

```typescript
describe("v1.5 multi-pin registry", () => {
  beforeEach(() => chrome.storage.local._reset());

  it("getActivePinnedTabs expands pinnedTabIds[] into per-tab entries", async () => {
    await chrome.storage.local.set({
      session_index: [
        {
          id: "sA",
          lastAccessedAt: 1,
          status: "active",
          pinnedTabIds: [12, 13, 14],
          messageCount: 3,
        },
        {
          id: "sB",
          lastAccessedAt: 2,
          status: "active",
          pinnedTabIds: [99],
          messageCount: 1,
        },
      ],
    });
    const all = await getActivePinnedTabs();
    expect(all).toEqual(
      expect.arrayContaining([
        { sessionId: "sA", tabId: 12, status: "active" },
        { sessionId: "sA", tabId: 13, status: "active" },
        { sessionId: "sA", tabId: 14, status: "active" },
        { sessionId: "sB", tabId: 99, status: "active" },
      ]),
    );
    expect(all).toHaveLength(4);
  });

  it("getCrossSessionPinnedTabIds returns the union excluding caller", async () => {
    await chrome.storage.local.set({
      session_index: [
        { id: "self", lastAccessedAt: 1, status: "active", pinnedTabIds: [10, 11], messageCount: 1 },
        { id: "other", lastAccessedAt: 2, status: "active", pinnedTabIds: [20, 21], messageCount: 1 },
      ],
    });
    const set = await getCrossSessionPinnedTabIds("self");
    expect(set.has(20)).toBe(true);
    expect(set.has(21)).toBe(true);
    expect(set.has(10)).toBe(false);
    expect(set.has(11)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/sessions/pinned-tab-registry.test.ts -t "v1.5 multi-pin"`
Expected: FAIL — `getActivePinnedTabs` reads `entry.pinnedTabId` only.

- [ ] **Step 3: Update `getActivePinnedTabs`**

Replace `src/lib/sessions/pinned-tab-registry.ts:57-70`:

```typescript
export async function getActivePinnedTabs(): Promise<ActivePinnedTab[]> {
  const index = await listSessionIndex();
  const out: ActivePinnedTab[] = [];
  for (const entry of index) {
    if (!OWNING_STATUSES.has(entry.status)) continue;
    if (!Array.isArray(entry.pinnedTabIds)) continue;
    for (const tabId of entry.pinnedTabIds) {
      if (typeof tabId !== "number") continue;
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

`getCrossSessionPinnedTabIds` body is unchanged — it consumes `getActivePinnedTabs`.

- [ ] **Step 4: Run tests + commit**

Run: `pnpm vitest run src/lib/sessions/pinned-tab-registry.test.ts`
Expected: PASS.

```bash
git add src/lib/sessions/pinned-tab-registry.ts src/lib/sessions/pinned-tab-registry.test.ts
git commit -m "feat(sessions): R7 registry expands pinnedTabIds[] per-tab (Path A unit 3)"
```

---

## Task 4: Risk classifier walks pinnedTabs array

Goal: `RiskClassifyContext.pinnedOrigin` (single) → `pinnedTabs[]`. `hasCrossOriginTab` checks if each `args.tabIds` entry matches one of the session's pinned tabs by exact `(tabId, origin)`. Tabs not in `pinnedTabs[]` are conservatively cross-origin.

**Files:**
- Modify: `src/lib/agent/risk.ts`
- Test: `src/lib/agent/risk.test.ts` (append cases)

- [ ] **Step 1: Write failing tests**

In `src/lib/agent/risk.test.ts`:

```typescript
describe("v1.5 multi-pin cross-origin detection", () => {
  it("hasCrossOriginTab returns crossOrigin=false when args.tabIds ⊆ pinnedTabs", () => {
    const ctx = {
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
      allTabsCache: new Map([
        [12, { origin: "https://a.com" }],
        [13, { origin: "https://b.com" }],
      ]),
    };
    const result = hasCrossOriginTab({ tabIds: [12, 13] }, ctx);
    expect(result.crossOrigin).toBe(false);
  });

  it("hasCrossOriginTab flags cross-origin when args target an unpinned tab", () => {
    const ctx = {
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      allTabsCache: new Map([
        [12, { origin: "https://a.com" }],
        [99, { origin: "https://malicious.com" }],
      ]),
    };
    const result = hasCrossOriginTab({ tabIds: [12, 99] }, ctx);
    expect(result.crossOrigin).toBe(true);
    expect(result.offendingOrigins).toContain("https://malicious.com");
  });

  it("hasCrossOriginTab tolerates pinnedTabs[] empty (auto mode safety)", () => {
    const ctx = {
      pinnedTabs: [],
      allTabsCache: new Map([[12, { origin: "https://a.com" }]]),
    };
    const result = hasCrossOriginTab({ tabIds: [12] }, ctx);
    // No pin to compare against; conservatively flag cross-origin.
    expect(result.crossOrigin).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/agent/risk.test.ts -t "v1.5 multi-pin"`
Expected: FAIL — `hasCrossOriginTab` reads `ctx.pinnedOrigin`.

- [ ] **Step 3: Update `RiskClassifyContext` and `hasCrossOriginTab` (clean break)**

In `src/lib/agent/risk.ts:17-21`, **delete** `pinnedOrigin?: string` and **replace** with:

```typescript
export interface RiskClassifyContext {
  /**
   * v1.5 — full session pinned tabs. The classifier flags any tabId not in
   * this list as cross-origin (conservative).
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  allTabsCache?: Map<number, { origin: string }>;
}
```

Replace `hasCrossOriginTab` (lines ~32-59):

```typescript
export function hasCrossOriginTab(
  args: { tabIds?: number[]; tabId?: number },
  ctx: RiskClassifyContext | undefined,
): { crossOrigin: boolean; offendingOrigins: string[] } {
  if (!ctx?.allTabsCache) {
    return { crossOrigin: false, offendingOrigins: [] };
  }
  const ownedByTabId = new Map<number, string>();
  if (ctx.pinnedTabs && ctx.pinnedTabs.length > 0) {
    for (const p of ctx.pinnedTabs) ownedByTabId.set(p.tabId, p.origin);
  }
  const ids = collectIds(args);
  if (ownedByTabId.size === 0) {
    // No pin → conservative fail-high so any tab tool target is cross-origin.
    const offending = new Set<string>();
    for (const id of ids) {
      const info = ctx.allTabsCache.get(id);
      offending.add(info?.origin ?? "(unknown)");
    }
    return {
      crossOrigin: ids.length > 0,
      offendingOrigins: Array.from(offending),
    };
  }
  const offending = new Set<string>();
  for (const id of ids) {
    if (ownedByTabId.has(id)) continue; // owned tab, same-origin by definition
    const info = ctx.allTabsCache.get(id);
    offending.add(info?.origin ?? "(unknown)");
  }
  return {
    crossOrigin: offending.size > 0,
    offendingOrigins: Array.from(offending),
  };
}

function collectIds(args: { tabIds?: number[]; tabId?: number }): number[] {
  const ids: number[] = [];
  if (Array.isArray(args.tabIds)) ids.push(...args.tabIds);
  if (typeof args.tabId === "number") ids.push(args.tabId);
  return ids;
}
```

Search for any other `pinnedOrigin` references in `risk.ts` and the rest of the codebase (`grep -rn "pinnedOrigin" src/`) and **delete** all of them — the field is gone.

- [ ] **Step 4: Run tests + commit**

Run: `pnpm vitest run src/lib/agent/risk.test.ts`
Expected: PASS.

```bash
git add src/lib/agent/risk.ts src/lib/agent/risk.test.ts
git commit -m "feat(agent): risk classifier walks pinnedTabs[] for cross-origin (Path A unit 4)"
```

---

## Task 5: Loop dispatcher pinnedTabs threading + currentFocusTabId

Goal: `AgentLoopContext.pinned` (single) → `pinnedTabs[]` + a mutable cell `currentFocusTabId`. Per-iteration: read `SessionAgentState.currentFocusTabId` (default `pinnedTabs[0].tabId`); snapshot that tab. `ctx.tabId` resolves from this. emitDone clears whole array via `clearTaskPinAtSessionEnd`.

**Files:**
- Modify: `src/lib/agent/loop.ts`
- Modify: `src/lib/agent/types.ts`
- Modify: `src/background/index.ts` (call site)
- Test: `src/lib/agent/loop.test.ts` (append cases — focus-on-snapshot behavior)

This task is the largest single edit. Break the implementation into careful sub-steps.

- [ ] **Step 1: Update `ToolHandlerContext` in types.ts**

In `src/lib/agent/types.ts:40-58`, add `pinnedTabs`:

```typescript
export interface ToolHandlerContext {
  tabId: number;
  snapshot: PageSnapshot;
  confirmedTabTargets?: Map<number, ConfirmedTabTarget>;
  preFetchedContent?: Map<number, PreFetchedTabContent>;
  pinMode?: "auto" | "task" | "user";
  /**
   * v1.5 — full pinnedTabs array carried into the handler. focus_tab uses it
   * to validate target tabId; close_tabs K-9 checks intersection; open_url
   * pushes new entries via the writer below.
   */
  pinnedTabs?: ReadonlyArray<{ tabId: number; origin: string }>;
  /**
   * v1.5 — write-side hooks for tools that mutate pinnedTabs / focus.
   * Loop installs these; tests pass undefined and the tools handle it.
   */
  appendPinnedTab?: (pin: { tabId: number; origin: string }) => Promise<void>;
  setCurrentFocusTabId?: (tabId: number) => Promise<void>;
}
```

- [ ] **Step 2: Update `AgentLoopContext` in loop.ts (delete `pinned`)**

In `src/lib/agent/loop.ts:170-186`, **delete** the `pinned?: { tabId: number; origin: string }` field. **Replace** with:

```typescript
  /**
   * v1.5 multi-pin — full set of pinned tabs owned by this session.
   * Index 0 is the chat-start capture; later indices are open_url
   * pushes. The loop's per-iteration snapshot is taken on the tab whose
   * id matches `SessionAgentState.currentFocusTabId` (default = index 0
   * tabId). `focus_tab` mutates that pointer.
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  /**
   * v1.5 — initial focus on chat-start. Defaults to pinnedTabs[0].tabId.
   * Resume path reads SessionAgentState.currentFocusTabId; chat-start
   * resets it to pinnedTabs[0].tabId.
   */
  initialFocusTabId?: number;
```

Search the loop.ts body for `ctx.pinned` and `ctx.pinned?.tabId` / `ctx.pinned?.origin` references — replace each with the focused-tab equivalent (see Step 3) or with `ctx.pinnedTabs?.[0]` where the original code semantically meant "the primary pin".

- [ ] **Step 3: Update per-iteration snapshot to use focused tab**

In `src/lib/agent/loop.ts`, find the per-iteration code that opens a snapshot. The pattern looks roughly like:

```typescript
// existing
const tab = await chrome.tabs.get(ctx.pinned!.tabId);
```

Replace with focused-tab resolution. Add near the top of the iteration loop:

```typescript
// v1.5 multi-pin: read currentFocusTabId from agent state; default to pinnedTabs[0].
const agentState = await getSessionAgent(sessionId);
const focusTabId =
  agentState?.currentFocusTabId ??
  ctx.pinnedTabs?.[0]?.tabId;
if (typeof focusTabId !== "number") {
  // No pin at all — this should never happen during task mode; abort defensively.
  await emitDone({ status: "fail", reason: "no-pinned-tab" });
  return;
}
const tab = await chrome.tabs.get(focusTabId);
```

(Engineer: search for the existing `chrome.tabs.get(ctx.pinned` callsites in loop.ts and route them through `focusTabId`.)

- [ ] **Step 4: Update tool dispatch ctx construction**

Find the dispatch block (around line 1958 per grep). Replace ctx construction:

```typescript
const ctx: ToolHandlerContext = {
  tabId: focusTabId,
  snapshot,
  pinMode: ctx_outer.pinMode,
  pinnedTabs: ctx_outer.pinnedTabs,
  confirmedTabTargets,
  preFetchedContent,
  appendPinnedTab: async (pin) => {
    const meta = await getSessionMeta(sessionId);
    if (!meta) return;
    await setSessionMeta(addPinToMeta(meta, pin));
  },
  setCurrentFocusTabId: async (tabId) => {
    const cur = await getSessionAgent(sessionId);
    if (!cur) return;
    await setSessionAgent(sessionId, { ...cur, currentFocusTabId: tabId });
  },
};
```

(Engineer: import `addPinToMeta`, `getSessionMeta`, `setSessionMeta`, `setSessionAgent`, `getSessionAgent` from sessions/storage.)

- [ ] **Step 5: emitDone clears full array**

In `src/lib/agent/loop.ts`, the existing `emitDone` already calls `ctx.onTaskDone()` which routes to `clearTaskPinAtSessionEnd` in storage. `clearTaskPinIfActive` in pin-state.ts (Task 1) now clears the whole array. **No code change here**; verify by re-running the loop tests.

Also ensure `buildSessionAgentTombstone` clears `currentFocusTabId`. Find that helper in loop.ts and add:

```typescript
function buildSessionAgentTombstone(): SessionAgentState {
  return {
    agentMessages: [],
    stepIndex: 0,
    skillExecutionScopeStack: [],
    hasImageContent: false,
    // currentFocusTabId intentionally omitted (undefined) — fresh task.
  };
}
```

- [ ] **Step 6: Update `background/index.ts` call sites**

Find `runAgentLoop` invocations in `src/background/index.ts` (chat-start path ~1294 and resume path ~787). Replace `pinned` with `pinnedTabs`:

```typescript
runAgentLoop({
  // ...
  pinnedTabs: meta.pinnedTabs ?? [],
  initialFocusTabId: agent?.currentFocusTabId ?? meta.pinnedTabs?.[0]?.tabId,
  pinMode: getEffectivePinMode(meta, agent),
  // `pinned: { tabId, origin }` field is DELETED — read from pinnedTabs[0] internally.
});
```

For chat-start, after `upgradeAutoToTaskAtChatStart` returns, re-read meta to pick up the freshly written `pinnedTabs`.

- [ ] **Step 7: Append loop tests for focus-on-snapshot**

In `src/lib/agent/loop.test.ts`:

```typescript
describe("v1.5 multi-pin focus-on-snapshot", () => {
  it("snapshots the tab matching SessionAgentState.currentFocusTabId", async () => {
    const meta = mkMeta({
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    await setSessionMeta(meta);
    await setSessionAgent("s", {
      agentMessages: [],
      stepIndex: 1,
      skillExecutionScopeStack: [],
      hasImageContent: false,
      currentFocusTabId: 13, // user previously focus_tab'd to tab 13
    });
    const tabsGet = vi.fn().mockResolvedValueOnce({
      id: 13,
      url: "https://b.com/page",
    });
    chrome.tabs.get = tabsGet;
    // run one iteration of runAgentLoop with stub LLM that returns done()
    await runAgentLoopOneIteration({ sessionId: "s", /* fixtures */ });
    expect(tabsGet).toHaveBeenCalledWith(13);
  });
});
```

(Engineer: the existing `loop.test.ts` may already have a fixtures harness; reuse `mkMeta` / `runAgentLoopOneIteration` analogues. If the harness can't run a single iteration cleanly, write a smaller test on the per-iteration helper if loop.ts exports one.)

- [ ] **Step 8: Run all tests + commit**

Run: `pnpm vitest run`
Expected: PASS (with possibly some tests in legacy paths needing the `pinned` → `pinnedTabs` shim).

```bash
git add src/lib/agent/loop.ts src/lib/agent/types.ts src/background/index.ts src/lib/agent/loop.test.ts
git commit -m "feat(agent): loop threads pinnedTabs[] + currentFocusTabId through ctx (Path A unit 5)"
```

---

## Task 6: focus_tab tool + prompt-builder updates

Goal: Add `focus_tab(tabId)` tool with low risk, validates `tabId ∈ pinnedTabs`, updates `currentFocusTabId` via `ctx.setCurrentFocusTabId`. Prompt builder lists pinnedTabs and current focus so the LLM knows what's available.

**Files:**
- Modify: `src/lib/agent/tools/tabs.ts` (new tool)
- Modify: `src/lib/agent/tool-names.ts` (register name + class)
- Modify: `src/lib/agent/risk.ts` (add `focus_tab` to a new ALWAYS_LOW_TAB_TOOLS bucket)
- Modify: `src/lib/agent/prompt-builder.ts` (list multi-pin)
- Test: `src/lib/agent/tools/tabs.test.ts` (focus_tab cases)
- Test: `src/lib/agent/prompt-builder.test.ts` (multi-pin section)

- [ ] **Step 1: Write failing tests for focus_tab**

In `src/lib/agent/tools/tabs.test.ts`:

```typescript
import { focusTabTool } from "./tabs";

describe("focus_tab tool", () => {
  it("validates tabId against pinnedTabs[] and rejects unknown ids", async () => {
    const setFocus = vi.fn();
    const result = await focusTabTool.handler(
      { tabId: 99 },
      {
        tabId: 12,
        snapshot: emptySnapshot(),
        pinMode: "task",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
        setCurrentFocusTabId: setFocus,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in pinnedTabs/);
    expect(setFocus).not.toHaveBeenCalled();
  });

  it("updates currentFocusTabId on valid tabId and returns observation", async () => {
    const setFocus = vi.fn().mockResolvedValue(undefined);
    const result = await focusTabTool.handler(
      { tabId: 13 },
      {
        tabId: 12,
        snapshot: emptySnapshot(),
        pinMode: "task",
        pinnedTabs: [
          { tabId: 12, origin: "https://a.com" },
          { tabId: 13, origin: "https://b.com" },
        ],
        setCurrentFocusTabId: setFocus,
      },
    );
    expect(result.success).toBe(true);
    expect(setFocus).toHaveBeenCalledWith(13);
    expect(result.observation).toMatch(/focus changed/);
    expect(result.observation).toMatch(/next iteration/);
  });

  it("rejects when ctx.pinnedTabs missing (defensive)", async () => {
    const result = await focusTabTool.handler(
      { tabId: 12 },
      { tabId: 12, snapshot: emptySnapshot(), pinMode: "task" },
    );
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/agent/tools/tabs.test.ts -t "focus_tab"`
Expected: FAIL — focusTabTool not exported.

- [ ] **Step 3: Implement `focusTabTool`**

In `src/lib/agent/tools/tabs.ts`, add (alongside `closeTabsTool` etc.):

```typescript
const focusTabTool: Tool = {
  name: "focus_tab",
  description:
    "Switch the agent's snapshot focus to one of the session's pinned tabs. " +
    "Takes effect on the NEXT iteration (the current iteration's snapshot was " +
    "already taken). Use this to operate across multiple pinned tabs in a " +
    "single task: focus_tab(N), then on the next response use click/type/" +
    "get_tab_content/etc. against tab N. Pinned tabs are listed in the " +
    "system prompt; tabs created by open_url are added to that list.",
  parameters: {
    type: "object",
    properties: {
      tabId: {
        type: "integer",
        description: "Tab id to switch focus to. Must already be one of the session's pinned tabs.",
      },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = (args ?? {}) as { tabId?: number };
    if (typeof a.tabId !== "number") {
      return { success: false, error: "focus_tab requires a numeric tabId" };
    }
    if (!ctx.pinnedTabs || ctx.pinnedTabs.length === 0) {
      return {
        success: false,
        error: "focus_tab: no pinned tabs in this session (auto mode?).",
      };
    }
    const target = ctx.pinnedTabs.find((p) => p.tabId === a.tabId);
    if (!target) {
      const ids = ctx.pinnedTabs.map((p) => p.tabId).join(", ");
      return {
        success: false,
        error: `focus_tab: tab ${a.tabId} not in pinnedTabs (current: [${ids}]). Use open_url to create a new pinned tab, or pick an existing one.`,
      };
    }
    if (!ctx.setCurrentFocusTabId) {
      return {
        success: false,
        error: "focus_tab: handler context missing setCurrentFocusTabId (test/legacy harness).",
      };
    }
    await ctx.setCurrentFocusTabId(a.tabId);
    return {
      success: true,
      observation:
        `focus changed to tab ${a.tabId} (origin ${target.origin}). ` +
        `The new tab's page snapshot will be available on the next iteration; ` +
        `do NOT batch click/type/scroll on this tab in the same response.`,
    };
  },
};

// Append at the end:
export { focusTabTool };
```

Add to `TAB_TOOLS` export array:

```typescript
export const TAB_TOOLS: Tool[] = [
  listTabsTool,
  closeTabsTool,
  activateTabTool,
  groupTabsTool,
  ungroupTabsTool,
  moveTabsTool,
  getTabContentTool,
  focusTabTool,
];
```

- [ ] **Step 4: Register tool name + class + risk**

In `src/lib/agent/tool-names.ts`, add to `TAB_TOOL_NAMES` array:

```typescript
export const TAB_TOOL_NAMES = [
  "list_tabs",
  "get_tab_content",
  "close_tabs",
  "activate_tab",
  "group_tabs",
  "ungroup_tabs",
  "move_tabs",
  "focus_tab", // v1.5 multi-pin
] as const;
```

In the `TOOL_CLASSES` block, add:

```typescript
  focus_tab: "read", // mutates only internal session pointer, no tab state change
```

In `src/lib/agent/risk.ts`, after `ARGS_CONDITIONAL_TAB_TOOLS`, add a new bucket:

```typescript
// v1.5 — always-low cross-tab tools. focus_tab only mutates the session's
// internal focus pointer; no observable tab/page side effect.
const ALWAYS_LOW_TAB_TOOLS = new Set<string>(["focus_tab"]);
```

Update the G-1 acceptance gate to include this bucket:

```typescript
for (const name of TAB_TOOL_NAMES) {
  if (
    !ALWAYS_HIGH_TAB_TOOLS.has(name) &&
    !ARGS_CONDITIONAL_TAB_TOOLS.has(name) &&
    !ALWAYS_LOW_TAB_TOOLS.has(name)
  ) {
    throw new Error(
      `[G-1] cross-tab tool "${name}" is in TAB_TOOL_NAMES but not classified ` +
        `in risk.ts (ALWAYS_HIGH / ARGS_CONDITIONAL / ALWAYS_LOW). See plan G-1.`,
    );
  }
}
```

In `classifyRisk`, before the existing per-tool branches, add an explicit branch:

```typescript
  if (toolName === "focus_tab") {
    return { level: "low" };
  }
```

- [ ] **Step 5: Update prompt-builder to list pinnedTabs + focus**

In `src/lib/agent/prompt-builder.ts`, locate the section that mentions the pinned tab. Replace with logic that lists all pinned tabs and identifies current focus. Sketch:

```typescript
// In the system prompt builder where pinned-tab info is added:
function pinnedTabsSection(
  pinnedTabs: Array<{ tabId: number; origin: string }>,
  currentFocusTabId: number,
): string {
  if (pinnedTabs.length === 0) return "";
  const lines = pinnedTabs.map((p) => {
    const marker = p.tabId === currentFocusTabId ? " ← current focus" : "";
    return `  - tab ${p.tabId} (${p.origin})${marker}`;
  });
  const intro =
    pinnedTabs.length === 1
      ? "Your pinned tab:"
      : `Your pinned tabs (${pinnedTabs.length}):`;
  const guidance =
    pinnedTabs.length > 1
      ? "\nUse focus_tab(tabId) to switch which pinned tab the next snapshot is taken from. Effect applies NEXT iteration."
      : "";
  return `${intro}\n${lines.join("\n")}${guidance}`;
}
```

Caller passes `pinnedTabs` (from `ctx.pinnedTabs`) and `currentFocusTabId` (from `agentState.currentFocusTabId ?? pinnedTabs[0].tabId`). Engineer: search for current pinnedOrigin/pinnedTabId references in prompt-builder.ts and route through this helper.

- [ ] **Step 6: Append prompt-builder tests**

In `src/lib/agent/prompt-builder.test.ts`:

```typescript
describe("v1.5 multi-pin prompt section", () => {
  it("lists all pinned tabs and marks current focus", () => {
    const prompt = buildAgentSystemPrompt({
      // ... fixtures
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
      currentFocusTabId: 13,
    });
    expect(prompt).toContain("tab 12 (https://a.com)");
    expect(prompt).toContain("tab 13 (https://b.com) ← current focus");
    expect(prompt).toContain("focus_tab(tabId)");
  });

  it("omits multi-tab guidance when only one pin", () => {
    const prompt = buildAgentSystemPrompt({
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      currentFocusTabId: 12,
    });
    expect(prompt).not.toContain("focus_tab(tabId)");
  });
});
```

- [ ] **Step 7: Run tests + commit**

Run: `pnpm vitest run`
Expected: PASS.

```bash
git add src/lib/agent/tools/tabs.ts src/lib/agent/tools/tabs.test.ts \
        src/lib/agent/tool-names.ts src/lib/agent/risk.ts \
        src/lib/agent/prompt-builder.ts src/lib/agent/prompt-builder.test.ts
git commit -m "feat(agent): focus_tab tool + multi-pin prompt section (Path A unit 6)"
```

---

## Task 7: open_url tool + URL allowlist

Goal: Add `open_url(url, active?)` tool. Strict `http:`/`https:` allowlist. `chrome.tabs.create` then push `{tabId, origin}` to session pinnedTabs via `ctx.appendPinnedTab`. Always-high risk.

**Files:**
- Modify: `src/lib/agent/tools/tabs.ts`
- Modify: `src/lib/agent/tool-names.ts`
- Modify: `src/lib/agent/risk.ts`
- Test: `src/lib/agent/tools/tabs.test.ts` (open_url cases)

- [ ] **Step 1: Write failing tests**

```typescript
describe("open_url tool", () => {
  beforeEach(() => {
    chrome.tabs.create = vi.fn().mockResolvedValue({
      id: 999,
      url: "https://example.com/",
    });
  });

  it("rejects non-http/https schemes", async () => {
    const cases = [
      "javascript:alert(1)",
      "data:text/html,xxx",
      "file:///etc/passwd",
      "chrome://settings",
      "view-source:https://example.com",
      "mailto:foo@bar.com",
      "ftp://example.com",
      "ws://example.com",
      "blob:https://x/abc",
    ];
    for (const url of cases) {
      const r = await openUrlTool.handler(
        { url },
        { tabId: 12, snapshot: emptySnapshot() },
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/unsafe-url-scheme/);
    }
  });

  it("rejects empty / non-string url", async () => {
    for (const url of ["", null, undefined, 42, {}]) {
      const r = await openUrlTool.handler(
        { url } as any,
        { tabId: 12, snapshot: emptySnapshot() },
      );
      expect(r.success).toBe(false);
    }
  });

  it("rejects URL longer than 4096 chars", async () => {
    const url = "https://example.com/" + "a".repeat(5000);
    const r = await openUrlTool.handler(
      { url },
      { tabId: 12, snapshot: emptySnapshot() },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/url-too-long/);
  });

  it("creates tab and pushes pin on success", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const r = await openUrlTool.handler(
      { url: "https://example.com/page" },
      {
        tabId: 12,
        snapshot: emptySnapshot(),
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
        appendPinnedTab: append,
      },
    );
    expect(r.success).toBe(true);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://example.com/page",
      active: false,
    });
    expect(append).toHaveBeenCalledWith({
      tabId: 999,
      origin: "https://example.com",
    });
  });

  it("respects active=true", async () => {
    await openUrlTool.handler(
      { url: "https://example.com/", active: true },
      {
        tabId: 12,
        snapshot: emptySnapshot(),
        appendPinnedTab: vi.fn(),
      },
    );
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://example.com/",
      active: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/agent/tools/tabs.test.ts -t "open_url"`
Expected: FAIL — openUrlTool not exported.

- [ ] **Step 3: Implement `openUrlTool`**

In `src/lib/agent/tools/tabs.ts`:

```typescript
const OPEN_URL_MAX_LEN = 4096;

const openUrlTool: Tool = {
  name: "open_url",
  description:
    "Open a new browser tab loading the given URL. Each call requires user " +
    "approval (high risk). The new tab is added to this session's pinned tab " +
    "list — use focus_tab(newTabId) on the next iteration to operate on it. " +
    "Only http: and https: are allowed; other schemes are rejected.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: `Absolute http: or https: URL to open. Max ${OPEN_URL_MAX_LEN} chars.`,
      },
      active: {
        type: "boolean",
        description:
          "If true, the new tab takes focus (steals the user's view). Default false (loads in background).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = (args ?? {}) as { url?: unknown; active?: unknown };
    if (typeof a.url !== "string" || a.url.length === 0) {
      return { success: false, error: "open_url: url must be a non-empty string" };
    }
    if (a.url.length > OPEN_URL_MAX_LEN) {
      return {
        success: false,
        error: `open_url: url-too-long (>${OPEN_URL_MAX_LEN} chars)`,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(a.url);
    } catch {
      return { success: false, error: "open_url: invalid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        success: false,
        error: `open_url: unsafe-url-scheme "${parsed.protocol}" (only http: and https: are allowed)`,
      };
    }
    const active = a.active === true;
    let newTab: chrome.tabs.Tab;
    try {
      newTab = await chrome.tabs.create({ url: a.url, active });
    } catch (e) {
      return {
        success: false,
        error: `open_url: chrome.tabs.create failed — ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (typeof newTab.id !== "number" || newTab.id < 0) {
      return { success: false, error: "open_url: chrome returned no tab id" };
    }
    if (ctx.appendPinnedTab) {
      try {
        await ctx.appendPinnedTab({ tabId: newTab.id, origin: parsed.origin });
      } catch (e) {
        // Tab was created but pin write failed. The tab is already open in the
        // browser; surface the warning but do not retract the create.
        return {
          success: true,
          observation:
            `Opened tab ${newTab.id} at ${parsed.origin}, but failed to add it ` +
            `to the session's pinnedTabs (${e instanceof Error ? e.message : String(e)}). ` +
            `Use focus_tab(${newTab.id}) anyway; if it fails, retry open_url next iteration.`,
        };
      }
    }
    return {
      success: true,
      observation:
        `Opened tab ${newTab.id} at ${parsed.origin}` +
        (active ? " (focused: stole user's view)" : " (background)") +
        `. Added to pinnedTabs[]; call focus_tab(${newTab.id}) on the next iteration to operate on it.`,
    };
  },
};

export { openUrlTool };
```

Add to `TAB_TOOLS` array.

- [ ] **Step 4: Register tool name + class + risk**

In `src/lib/agent/tool-names.ts`:

```typescript
export const TAB_TOOL_NAMES = [
  // ...
  "focus_tab",
  "open_url", // v1.5
] as const;
```

```typescript
  open_url: "write", // creates a new tab; mutates browser state
```

In `src/lib/agent/risk.ts`, add `open_url` to `ALWAYS_HIGH_TAB_TOOLS`:

```typescript
const ALWAYS_HIGH_TAB_TOOLS = new Set<string>([
  "close_tabs",
  "group_tabs",
  "ungroup_tabs",
  "move_tabs",
  "get_tab_content",
  "open_url", // v1.5
]);
```

Add explicit branch in `classifyRisk` before existing tab-tool branches:

```typescript
  if (toolName === "open_url") {
    return {
      level: "high",
      reason:
        "Opens a new tab — review the URL and origin in the confirm card before approving.",
    };
  }
```

- [ ] **Step 5: Run tests + commit**

```bash
pnpm vitest run src/lib/agent/tools/tabs.test.ts
pnpm build  # G-1 + TOOL_CLASSES build-time checks
```

```bash
git add src/lib/agent/tools/tabs.ts src/lib/agent/tools/tabs.test.ts \
        src/lib/agent/tool-names.ts src/lib/agent/risk.ts
git commit -m "feat(agent): open_url tool with strict http(s) allowlist (Path A unit 7)"
```

---

## Task 8: open_url confirm UI + SkillsList badge

Goal: Confirm card displays URL (≥1024 fold), `URL.host` (already punycode), active=true|false badge with red/green semantic. SkillsList shows "Tab creation requires per-call approval" for skills containing open_url.

**Files:**
- Modify: `src/sidepanel/components/AgentConfirmCard.tsx`
- Modify: `src/sidepanel/components/SkillsList.tsx`
- Modify: `src/background/index.ts` (build the confirm payload variant for open_url)
- Test: `src/sidepanel/components/AgentConfirmCard.test.tsx` (open_url variant)
- Test: `src/sidepanel/components/SkillsList.test.tsx` (badge presence)

- [ ] **Step 1: Decide payload shape (no test — design step)**

Add to the confirm card's tab-target type union (search `AgentConfirmCard.tsx` for `tabTargets` to find the existing structure):

```typescript
// Existing variants (close_tabs / group_tabs / etc.) carry tabTargets[].
// New variant for open_url:
type OpenUrlConfirm = {
  kind: "open_url";
  url: string; // raw, may exceed 1024 chars
  host: string; // URL.host (punycode for IDN)
  origin: string;
  active: boolean;
};
```

The SW dispatcher (background/index.ts) should produce this on every open_url confirm. The card decides folding.

- [ ] **Step 2: Write failing tests**

In `src/sidepanel/components/AgentConfirmCard.test.tsx`:

```typescript
describe("open_url confirm variant", () => {
  it("renders URL inline when ≤1024 chars", () => {
    render(
      <AgentConfirmCard
        confirmation={{
          confirmationId: "c1",
          kind: "agent-tool",
          payload: {
            kind: "open_url",
            url: "https://example.com/short",
            host: "example.com",
            origin: "https://example.com",
            active: false,
          },
        }}
        onResolve={vi.fn()}
      />
    );
    expect(screen.getByText(/https:\/\/example\.com\/short/)).toBeInTheDocument();
    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/loads in background/i)).toBeInTheDocument();
  });

  it("renders punycode host for IDN URLs", () => {
    render(
      <AgentConfirmCard
        confirmation={{
          confirmationId: "c2",
          kind: "agent-tool",
          payload: {
            kind: "open_url",
            url: "https://xn--80akhbyknj4f.com/page",
            host: "xn--80akhbyknj4f.com",
            origin: "https://xn--80akhbyknj4f.com",
            active: false,
          },
        }}
        onResolve={vi.fn()}
      />
    );
    expect(screen.getByText(/xn--80akhbyknj4f\.com/)).toBeInTheDocument();
  });

  it("renders WILL STEAL FOCUS badge when active=true", () => {
    render(
      <AgentConfirmCard
        confirmation={{
          confirmationId: "c3",
          kind: "agent-tool",
          payload: {
            kind: "open_url",
            url: "https://example.com/",
            host: "example.com",
            origin: "https://example.com",
            active: true,
          },
        }}
        onResolve={vi.fn()}
      />
    );
    expect(screen.getByText(/will steal focus/i)).toBeInTheDocument();
  });

  it("folds URL ≥1024 chars into a collapsed expandable", () => {
    const longUrl = "https://example.com/" + "x".repeat(2000);
    render(
      <AgentConfirmCard
        confirmation={{
          confirmationId: "c4",
          kind: "agent-tool",
          payload: {
            kind: "open_url",
            url: longUrl,
            host: "example.com",
            origin: "https://example.com",
            active: false,
          },
        }}
        onResolve={vi.fn()}
      />
    );
    // Collapsed: only the first chunk shown, plus a "show full URL" toggle.
    expect(screen.getByRole("button", { name: /show full url/i })).toBeInTheDocument();
    expect(screen.queryByText(longUrl)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Implement open_url variant in AgentConfirmCard**

In `src/sidepanel/components/AgentConfirmCard.tsx`, locate the payload-routing switch and add:

```tsx
if (payload?.kind === "open_url") {
  return <OpenUrlConfirmContent payload={payload as OpenUrlConfirm} />;
}
```

```tsx
const URL_FOLD_THRESHOLD = 1024;

function OpenUrlConfirmContent({ payload }: { payload: OpenUrlConfirm }) {
  const [expanded, setExpanded] = useState(false);
  const long = payload.url.length >= URL_FOLD_THRESHOLD;
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-fg-2">Open new tab at:</div>
      <div className="font-mono text-[11px] break-all text-fg-1">
        {long && !expanded ? (
          <>
            {payload.url.slice(0, 256)}…
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="ml-2 text-accent underline"
            >
              show full URL
            </button>
          </>
        ) : (
          payload.url
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-fg-3">
        <span className="font-mono">{payload.host}</span>
        {payload.active ? (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 font-medium">
            WILL STEAL FOCUS
          </span>
        ) : (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700">
            loads in background
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: SW builds the open_url confirm payload**

In `src/background/index.ts`, find the confirm-request build site (search for `kind: "agent-tool"` / `tabTargets`). Add a branch:

```typescript
if (toolName === "open_url") {
  let host = "(invalid)";
  let origin = "(invalid)";
  try {
    const u = new URL(args.url as string);
    host = u.host; // already punycode for IDN
    origin = u.origin;
  } catch {
    // shouldn't happen — handler validates before SW reaches confirm phase
  }
  payload = {
    kind: "open_url",
    url: args.url,
    host,
    origin,
    active: args.active === true,
  };
}
```

- [ ] **Step 5: SkillsList badge for skills with open_url**

In `src/sidepanel/components/SkillsList.tsx`, locate the per-skill row render. Add:

```tsx
{skill.allowedTools?.includes("open_url") && (
  <span
    className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
    title="Each open_url call requires user approval"
  >
    Per-call approval
  </span>
)}
```

Test in `SkillsList.test.tsx`:

```typescript
it("shows per-call approval badge when skill includes open_url", () => {
  render(
    <SkillsList
      skills={[
        {
          id: "s1",
          name: "Research",
          allowedTools: ["list_tabs", "get_tab_content", "open_url"],
          // ... other fixtures
        },
      ]}
    />
  );
  expect(screen.getByText(/per-call approval/i)).toBeInTheDocument();
});
```

- [ ] **Step 6: Run tests + commit**

```bash
pnpm vitest run src/sidepanel/components/AgentConfirmCard.test.tsx \
                src/sidepanel/components/SkillsList.test.tsx
```

```bash
git add src/sidepanel/components/AgentConfirmCard.tsx \
        src/sidepanel/components/AgentConfirmCard.test.tsx \
        src/sidepanel/components/SkillsList.tsx \
        src/sidepanel/components/SkillsList.test.tsx \
        src/background/index.ts
git commit -m "feat(panel): open_url confirm UI + SkillsList per-call approval badge (Path A unit 8)"
```

---

## Task 9: K-9 / drift / pageChanged extend to pinnedTabs[] + useSession + manifest + docs

Goal: K-9 close protection refuses any tab in `pinnedTabs[]` for user mode. Drift check walks all task-mode pinnedTabs[]. Chat.tsx pageChanged effect filters `chrome.tabs.onUpdated` by `tabId ∈ pinnedTabIds`. useSession exposes `pinnedTabs` (replaces single `pinnedOrigin`/`pinnedTabId`). manifest 0.5.1 → 0.5.2. M3 trace doc append.

**Files:**
- Modify: `src/lib/agent/tools/tabs.ts` (K-9 walk array)
- Modify: `src/background/index.ts` (checkPinnedDrift array)
- Modify: `src/sidepanel/components/Chat.tsx` (pageChanged + count badge)
- Modify: `src/sidepanel/hooks/useSession.ts` (pinnedTabs state)
- Modify: `src/sidepanel/components/PinnedTabDropdown.tsx` (multi-pin display)
- Modify: `manifest.json`
- Modify: `docs/solutions/2026-05-03-multi-session-invariant-trace.md`
- Test: existing test files, append cases

- [ ] **Step 1: Update K-9 in close_tabs**

In `src/lib/agent/tools/tabs.ts`, replace the K-9 block in `closeTabsTool.handler` (lines ~394-410):

```typescript
    // K-9 (v1.5): user-locked pin protects ALL pinnedTabs[] entries from agent close.
    if (ctx.pinMode === "user" && ctx.pinnedTabs && ctx.pinnedTabs.length > 0) {
      const pinnedIds = new Set(ctx.pinnedTabs.map((p) => p.tabId));
      const blocked = a.tabIds.filter((id) => pinnedIds.has(id));
      if (blocked.length > 0) {
        return {
          success: false,
          error:
            `close_tabs cannot close user-pinned tab(s) [${blocked.join(", ")}] (pinMode=user). ` +
            `Use the PINNED dropdown to clear or change the pin, then retry.`,
        };
      }
    }
```

Append a test case:

```typescript
it("K-9 v1.5: user mode refuses close on any tab in pinnedTabs", async () => {
  const r = await closeTabsTool.handler(
    { tabIds: [12, 13] },
    {
      tabId: 12,
      snapshot: emptySnapshot(),
      pinMode: "user",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    },
  );
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/cannot close user-pinned tab/);
});
```

- [ ] **Step 2: Update `checkPinnedDrift` in background**

In `src/background/index.ts`, search for `checkPinnedDrift` (~line 411). Replace its meta-reading line to walk pinnedTabs:

```typescript
async function checkPinnedDrift(meta: SessionMeta, agentStepIndex: number) {
  // Only fire for task mode (M5 invariant).
  const mode = getEffectivePinMode(meta, { stepIndex: agentStepIndex } as SessionAgentState);
  if (mode !== "task") return null;

  const pins = meta.pinnedTabs ?? [];
  for (const pin of pins) {
    let live: chrome.tabs.Tab | null;
    try {
      live = await chrome.tabs.get(pin.tabId);
    } catch {
      // Tab is gone — drift card "tab closed" variant.
      return { kind: "closed", tabId: pin.tabId } as const;
    }
    const liveOrigin = live.url ? new URL(live.url).origin : null;
    if (liveOrigin && liveOrigin !== pin.origin) {
      return { kind: "navigated", tabId: pin.tabId, expected: pin.origin, actual: liveOrigin } as const;
    }
  }
  return null;
}
```

(Engineer: existing checkPinnedDrift signature/return shape may differ; preserve the calling convention. Key change: walk `meta.pinnedTabs` array.)

- [ ] **Step 3: Update useSession pinnedTabs state + replace setUserPin → togglePinTab**

In `src/sidepanel/hooks/useSession.ts`, **delete** the `pinnedOriginState` / `pinnedTabIdState` hooks. **Add**:

```typescript
const [pinnedTabsState, setPinnedTabsState] = useState<
  ReadonlyArray<{ tabId: number; origin: string }> | null
>(null);
```

Update the `UseSession` interface — **delete** `pinnedOrigin`, `pinnedTabId`, `setUserPin`:

```typescript
  /**
   * v1.5 — full pinnedTabs[] for the active session. null pre-bootstrap.
   * Empty array = auto mode. ≥1 entries = task or user mode.
   */
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;

  /**
   * v1.5 — toggle a tab's membership in user-mode pinnedTabs[].
   *   - From auto: adds + flips to user mode.
   *   - From user containing tab: removes (and flips to auto if last entry).
   *   - From user not containing tab: appends (multi-select).
   *   - From task mode: no-op (loop owns task pins).
   */
  togglePinTab: (tabId: number, origin: string) => Promise<void>;
  clearUserPin: () => Promise<void>; // unchanged signature
```

In the storage onChanged listener and bootstrap, route through `meta.pinnedTabs`:

```typescript
const pins = newMeta?.pinnedTabs ?? [];
setPinnedTabsState(pins.length > 0 ? pins : null);
```

Replace the existing `setUserPin` callback body with:

```typescript
const togglePinTab = useCallback(
  async (tabId: number, origin: string): Promise<void> => {
    if (!sessionId) return;
    const meta = await getSessionMeta(sessionId);
    if (!meta) return;
    const next = togglePinTabUserMode(meta, { tabId, origin });
    if (next === meta) return; // no-op (e.g. task mode)
    await setSessionMeta(next);
  },
  [sessionId],
);
```

(Import `togglePinTabUserMode` from `@/lib/sessions/pin-state`.)

Update `clearUserPin` callback to call `pinState.clearUserPin(meta)` (unchanged from M5 behavior; just removed the now-deleted `pinnedTabId/Origin` field clearing because they're gone).

**Find every consumer of the deleted fields** (`pinnedOrigin` / `pinnedTabId` / `setUserPin`) — `grep -rn "pinnedOrigin\|pinnedTabId\|\.setUserPin(" src/sidepanel/` — and update them to use `pinnedTabs` / `togglePinTab` respectively.

- [ ] **Step 4: Update Chat.tsx pageChanged + badge**

In `src/sidepanel/components/Chat.tsx`, the pageChanged effect:

```typescript
const pinnedTabIds = useMemo(
  () => new Set((pinnedTabs ?? []).map((p) => p.tabId)),
  [pinnedTabs],
);

useEffect(() => {
  if (pinMode !== "task") return;
  if (pinnedTabIds.size === 0) return;
  const onUpdated = (
    tabId: number,
    info: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => {
    if (!pinnedTabIds.has(tabId)) return;
    if (!info.url) return;
    setPageChanged(true);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => chrome.tabs.onUpdated.removeListener(onUpdated);
}, [pinMode, pinnedTabIds]);
```

Top-bar PIN row: show count badge when ≥2 pins.

```tsx
{pinnedTabs && pinnedTabs.length > 1 ? (
  <span className="ml-1 rounded bg-accent-tint px-1 text-[10px] text-accent">
    ×{pinnedTabs.length}
  </span>
) : null}
```

- [ ] **Step 5: PinnedTabDropdown multi-select toggle**

In `src/sidepanel/components/PinnedTabDropdown.tsx`, replace the single-pick prop shape with multi-select semantics:

```typescript
interface PinnedTabDropdownProps {
  pinMode: PinMode | null;
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  streaming: boolean;
  /** Toggle membership: pick to add, pick again to remove. Caller closes the
   *  dropdown only on Auto-row click (multi-select stays open for further picks). */
  onToggle: (tabId: number, origin: string) => void;
  /** Clear all user pins → auto mode. */
  onClearPin: () => void;
  onClose: () => void;
}
```

In the tab-row render:

```tsx
const pinnedSet = useMemo(
  () => new Set((pinnedTabs ?? []).map((p) => p.tabId)),
  [pinnedTabs],
);
// per row click handler:
onMouseDown={(e) => {
  e.preventDefault();
  if (disabled) return;
  onToggle(t.id, t.origin);
  // do NOT close the dropdown — multi-select stays open
}}
// per row:
const selected = pinnedSet.has(t.id);
```

The "Auto" row still closes the dropdown after click (`onClearPin(); onClose();`).

Add a header hint when in user mode with ≥1 pin:

```tsx
{pinMode === "user" && pinnedTabs && pinnedTabs.length > 0 && (
  <div className="mt-1 text-[11px] text-fg-3">
    {pinnedTabs.length} tab{pinnedTabs.length > 1 ? "s" : ""} pinned. Click again to unpin.
  </div>
)}
```

Append a test in `PinnedTabDropdown.test.tsx`:

```typescript
it("toggling a pinned tab calls onToggle and stays open", () => {
  const onToggle = vi.fn();
  const onClose = vi.fn();
  const { getByText } = render(
    <PinnedTabDropdown
      pinMode="user"
      pinnedTabs={[{ tabId: 12, origin: "https://a.com" }]}
      streaming={false}
      onToggle={onToggle}
      onClearPin={vi.fn()}
      onClose={onClose}
    />,
  );
  // Mock chrome.tabs.query to return tabs 12 and 13.
  // ... (test harness already does this in existing tests)
  fireEvent.mouseDown(getByText(/some tab title/i));
  expect(onToggle).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled(); // multi-select stays open
});
```

- [ ] **Step 6: manifest version + docs**

`manifest.json`:

```json
"version": "0.5.2",
```

Append section to `docs/solutions/2026-05-03-multi-session-invariant-trace.md`:

```markdown
## v1.5 — Multi-Pin (Path A: focus_tab)

Schema:
- `SessionMeta.pinnedTabs?: Array<{tabId, origin}>` replaces `pinnedTabId/Origin`.
- `SessionAgentState.currentFocusTabId?: number` task-scoped pointer.
- `SessionIndexEntry.pinnedTabIds?: number[]` replaces single `pinnedTabId`.

Lifecycle (per pinMode):
| Mode | pinnedTabs[] | currentFocusTabId | R7 registry |
|---|---|---|---|
| auto | empty | undefined | skipped |
| task | [chat-start, ...open_url pushes] | mutable via focus_tab; reset at chat-start | listed (all entries) |
| user | exactly 1 | always pinnedTabs[0].tabId | listed |

New tools:
- `focus_tab(tabId)` — low risk; mutates currentFocusTabId; takes effect next iteration.
- `open_url(url, active?)` — always-high; chrome.tabs.create + push to pinnedTabs[].

Migration:
- Lazy normalize-on-write in `setSessionMeta`. Legacy `pinnedTabId/Origin` folded into `pinnedTabs:[{...}]` and dropped on first write.
```

- [ ] **Step 7: Run all tests + manual smoke**

```bash
pnpm vitest run
pnpm build
```

Manual smoke (browser, dist loaded as unpacked):

1. New empty session → PIN shows current active tab. Switch tab → PIN follows.
2. Send first message → pinnedTabs[] = [{capture}]. PIN locked.
3. Agent calls open_url("https://example.com") → confirm card shows URL+host+badge. Approve → new tab opens, PIN top-bar shows "×2".
4. Agent calls focus_tab(newTabId) → next iteration's snapshot is the new tab.
5. Agent calls click on new tab's element → operates on new tab.
6. Task ends → emitDone → pinnedTabs[] cleared, PIN back to live preview.
7. K-9 v1.5: user toggles tabA + tabB in dropdown → user mode, pinnedTabs=[A,B]; agent close_tabs([tabA, tabB]) → refused with both ids in error message.
8. R7 v1.5: session A pins tabs [12, 13]; session B's write tool on tab 13 → refused.
9. Drift v1.5: pinnedTabs=[tab12@a.com, tab13@b.com]; user navigates tab 13 to c.com → drift card fires.
10. Page-changed banner: pinned tabs A and B; user switches active tab to C (not pinned) → no banner. User navigates B to a new origin → banner fires.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(v1.5): multi-pin + open_url + focus_tab end-to-end (Path A unit 9)

- K-9 walks pinnedTabs[] for user mode close protection
- checkPinnedDrift walks all task-mode pinnedTabs
- Chat.tsx pageChanged filters chrome.tabs.onUpdated by pinnedTabIds
- useSession exposes pinnedTabs[] (with single-pin back-compat accessors)
- PinnedTabDropdown shows multi-pin selected state
- manifest 0.5.1 → 0.5.2
- docs/solutions trace doc updated"
```

---

## Task 10: Final cleanup — delete @deprecated legacy fields

Goal: After Tasks 1-9 have migrated every consumer to read `pinnedTabs[]` / `pinnedTabIds[]`, delete the now-unreferenced `@deprecated` legacy fields from `SessionMeta` and `SessionIndexEntry`. This is the actual "clean break" moment — until this task lands the legacy fields exist as TypeScript-only stubs to keep compile green.

**Files:**
- Modify: `src/lib/sessions/types.ts`

- [ ] **Step 1: Search for any remaining consumers of legacy fields**

```bash
grep -rn "\.pinnedTabId\b\|\.pinnedOrigin\b" src/ --include="*.ts" --include="*.tsx"
```

Expected: zero non-test hits, and only test files asserting the field is `undefined` after migration. If non-test hits exist, the prior task missed them — go back and fix before deleting the field.

- [ ] **Step 2: Delete the @deprecated fields**

In `src/lib/sessions/types.ts`:

- Delete `pinnedTabId?: number` from `SessionMeta`
- Delete `pinnedOrigin?: string` from `SessionMeta`
- Delete `pinnedTabId?: number` from `SessionIndexEntry`

- [ ] **Step 3: Run the full test + build**

```bash
pnpm vitest run
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sessions/types.ts
git commit -m "feat(sessions)!: delete @deprecated legacy single-pin fields (Path A unit 10)

BREAKING: SessionMeta.pinnedTabId/Origin and SessionIndexEntry.pinnedTabId
are now removed entirely. Existing chrome.storage data with these fields
will be ignored on read (no migration); user must reinstall."
```

---

## Self-review checklist (run before handing off)

After all 10 tasks land, verify:

- [ ] **Spec coverage**: every brainstorm requirement R1–R14 has a corresponding task or is intentionally deferred (and the deferral noted).
  - R1 open_url tool — Task 7
  - R2 auto-add to pinnedTabs — Task 7 (`appendPinnedTab`)
  - R3 SessionMeta multi-pin schema — Task 1
  - R4 SessionIndexEntry pinnedTabIds — Task 1+2
  - R5 migration — **superseded** by clean-break decision (user reinstalls; Tasks 1+2 delete legacy fields outright)
  - R6 URL allowlist — Task 7
  - R7 invalid URL handling — Task 7
  - R8 always-high — Task 7
  - R9 confirm card content — Task 8
  - R10 confirm card a11y baseline — inherited from Phase 3 base; no new code
  - R11 skill allowedTools includes open_url — already supported by string[] schema
  - R12 SkillsList badge — Task 8
  - R13 R7 cross-session lock under multi-pin — Task 3
  - R14 open_url new tab cross-session safe — Task 3 (new tab not in any sibling's pinnedTabs by construction)

- [ ] **K-10 confirm reject**: open_url confirms count toward the 3-reject task abort threshold (uniform with close_tabs/etc.). Verify by reading the SW reject counter logic; no special branch needed for open_url.

- [ ] **Build-time invariants**: `pnpm build` passes G-1 acceptance gate (TAB_TOOL_NAMES ∋ open_url AND open_url ∈ ALWAYS_HIGH_TAB_TOOLS) and TOOL_CLASSES exhaustiveness.

- [ ] **No placeholder leaks**: no "TODO", "later", "implement later" in any committed code.

- [ ] **Type consistency**: `pinnedTabs` is `Array<{tabId, origin}>` everywhere (not occasionally `Array<{tab, origin}>` or similar drift).

- [ ] **Backward compat**: NONE. M5 single-pin sessions on disk will fail to load post-upgrade. Engineer should announce in commit message that re-install is required for any tester with persisted M5 sessions. Empty `chrome.storage.local` / fresh install works without issue.

---

## Execution notes

- Each task is sized for one focused review session. Tasks 5 and 9 are larger than others — split the commit if needed but keep tests passing at every commit.
- Tasks 1–3 are pure data-layer; tasks 4–6 are agent-runtime; tasks 7–9 are tools + UI + integration. The dependency order is strict: do not skip ahead.
- Existing M5 tests should continue to pass throughout. If a regression surfaces, it's a sign the migration broke a back-compat path — fix before moving on.
- Path A trade-off the LLM must learn: `focus_tab` is a snapshot barrier. Prompt should be explicit. If LLM misuse becomes a real pattern, future v1.6 may add an "auto-snapshot-after-focus" mode at higher per-iteration cost.
