---
date: 2026-05-08
topic: concurrent-sessions
status: ready-to-execute
spec: docs/specs/2026-05-08-concurrent-sessions-design.md
issue: https://github.com/WiseriaAI/Pie/issues/30
---

# Concurrent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate panel-side `useSession` runtime state from single-tenant to `Map<sessionId, T>` with derived active-session view, remove SW-side `R13(c) evictOnSetActive`, scope keep-alive interval to in-flight tasks. Unblocks issue #30 P0.

**Architecture:**
- Panel: `useSession.ts` is split into `useSession/{index, runtime-map, port-handlers}.ts`. Internal `Map<sessionId, SessionRuntimeSlot>` for streaming/text/error/toast/messages/accumulated/streamFinished + `Map<sessionId, Port>` for ports. External `UseSession` interface unchanged — `streaming`/`messages`/etc. are derived from active sessionId. Old port stays connected during session switch. Multiple concurrent ports already supported by SW (PR #29).
- SW: 1) Drop `evictOnSetActive(portSessionId)` call (keep export); 2) Replace permanent `setInterval` with `ensureKeepAlive()` / `maybeStopKeepAlive()` driven by `inFlightSessionIds.size`. Tasks sit in `try { await runAgentLoop(...) } finally { delete + maybeStop }`.

**Tech Stack:** TypeScript 6, React 19, Vitest + happy-dom + @testing-library/react, Chrome MV3 service worker, pnpm.

---

## File Structure

**Create:**
- `src/sidepanel/hooks/useSession/runtime-map.ts` — `SessionRuntimeSlot` type, `EMPTY_SLOT`, `withSlot`, `deriveActiveView` helpers
- `src/sidepanel/hooks/useSession/runtime-map.test.ts` — pure unit tests for the helpers
- `src/sidepanel/hooks/useSession/port-handlers.ts` — `createPortHandlers({...})` factory returning `handleMessage` + `makeDisconnectHandler`
- `src/sidepanel/hooks/useSession/port-handlers.test.ts` — message routing unit tests
- `src/sidepanel/hooks/useSession/index.ts` — main hook (relocated from `useSession.ts`)
- `src/sidepanel/hooks/useSession.concurrent.test.ts` — multi-session integration tests (RTL + happy-dom)
- `src/background/image-cache.concurrent.test.ts` — verifies new port connect does NOT clear other sessions' caches
- `src/__tests__/cross-layer/concurrent-task-summary.test.ts` — wire→DisplayMessage transit regression for concurrent agent-done-task

**Move:**
- `src/sidepanel/hooks/useSession.ts` → `src/sidepanel/hooks/useSession/index.ts` (Vite path resolution makes this transparent to importers)
- `src/sidepanel/hooks/useSession.test.ts` → `src/sidepanel/hooks/useSession/index.test.ts` (keep alongside the relocated hook)

**Modify:**
- `src/sidepanel/hooks/useSession/index.ts` (post-move) — port refs become `portsRef: Map`, runtime state becomes `slotsRef + slots: Map`, `setActive` / `createAndActivate` simplified, unmount disconnects all ports
- `src/background/index.ts` — drop `evictOnSetActive(portSessionId)` (line 1551), replace `keepAliveInterval` block with `ensureKeepAlive` / `maybeStopKeepAlive` helpers wired into `chat-start` / `resume-task` / `handleChatStream` / `handleResumeRequest` / `port.onDisconnect`
- `src/background/image-cache.test.ts` — keep `(c)` unit test, add comment that SW path no longer calls it

---

## Task 1: `runtime-map.ts` — Slot type, helpers, tests

**Files:**
- Create: `src/sidepanel/hooks/useSession/runtime-map.ts`
- Create: `src/sidepanel/hooks/useSession/runtime-map.test.ts`

**Note:** This task creates the new directory `src/sidepanel/hooks/useSession/` for the first time. The existing `useSession.ts` / `useSession.test.ts` files are relocated in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `src/sidepanel/hooks/useSession/runtime-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EMPTY_SLOT,
  deriveActiveView,
  withSlot,
  type SessionRuntimeSlot,
} from "./runtime-map";

describe("runtime-map", () => {
  describe("EMPTY_SLOT", () => {
    it("matches the documented default state", () => {
      expect(EMPTY_SLOT).toEqual({
        streaming: false,
        streamingText: "",
        error: null,
        toast: null,
        messages: [],
        accumulated: "",
        streamFinished: true,
      });
    });
  });

  describe("withSlot", () => {
    it("creates a new slot from EMPTY_SLOT when id is unknown", () => {
      const out = withSlot(new Map(), "s1", { streaming: true });
      expect(out.get("s1")).toEqual({ ...EMPTY_SLOT, streaming: true });
    });

    it("merges patch object into existing slot", () => {
      const prev = new Map<string, SessionRuntimeSlot>([
        ["s1", { ...EMPTY_SLOT, streaming: true, accumulated: "abc" }],
      ]);
      const out = withSlot(prev, "s1", { streamingText: "hi" });
      expect(out.get("s1")).toEqual({
        ...EMPTY_SLOT,
        streaming: true,
        accumulated: "abc",
        streamingText: "hi",
      });
    });

    it("supports a function patch that reads previous slot", () => {
      const prev = new Map<string, SessionRuntimeSlot>([
        ["s1", { ...EMPTY_SLOT, accumulated: "ab" }],
      ]);
      const out = withSlot(prev, "s1", (s) => ({ accumulated: s.accumulated + "c" }));
      expect(out.get("s1")?.accumulated).toBe("abc");
    });

    it("returns a new Map (immutability)", () => {
      const prev = new Map<string, SessionRuntimeSlot>();
      const out = withSlot(prev, "s1", { streaming: true });
      expect(out).not.toBe(prev);
      expect(prev.size).toBe(0);
    });

    it("does not mutate the previous slot object", () => {
      const original: SessionRuntimeSlot = { ...EMPTY_SLOT, streaming: true };
      const prev = new Map<string, SessionRuntimeSlot>([["s1", original]]);
      withSlot(prev, "s1", { streamingText: "x" });
      expect(original.streamingText).toBe("");
    });
  });

  describe("deriveActiveView", () => {
    it("returns EMPTY_SLOT when activeId is null", () => {
      expect(deriveActiveView(new Map(), null)).toEqual(EMPTY_SLOT);
    });

    it("returns EMPTY_SLOT when slot is missing for activeId", () => {
      expect(deriveActiveView(new Map(), "missing")).toEqual(EMPTY_SLOT);
    });

    it("returns the slot for activeId when present", () => {
      const slot: SessionRuntimeSlot = { ...EMPTY_SLOT, streaming: true };
      const map = new Map([["s1", slot]]);
      expect(deriveActiveView(map, "s1")).toBe(slot);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/sidepanel/hooks/useSession/runtime-map.test.ts`
Expected: FAIL with "Cannot find module './runtime-map'"

- [ ] **Step 3: Implement `runtime-map.ts`**

Create `src/sidepanel/hooks/useSession/runtime-map.ts`:

```ts
import type { DisplayMessage } from "@/types";

/**
 * Per-session task runtime state. One Map<sessionId, SessionRuntimeSlot>
 * holds the slots for every session the panel has connected during this
 * mount lifetime. The active session's slot is what the public
 * `UseSession` interface exposes (via `deriveActiveView`); background
 * sessions accumulate streaming text / messages / etc. into their own
 * slot and surface them when the user switches back to that session.
 */
export type SessionRuntimeSlot = {
  streaming: boolean;
  streamingText: string;
  error: string | null;
  toast: { level: "warn" | "error" | "info"; text: string } | null;
  messages: DisplayMessage[];
  /** Mid-stream text accumulator. Equivalent to the legacy
   *  `accumulatedRef.current` (single-tenant). Consumed by chat-chunk /
   *  chat-done / chat-error / agent-step flush paths. */
  accumulated: string;
  /** Equivalent to the legacy `streamFinishedRef.current`. */
  streamFinished: boolean;
};

export const EMPTY_SLOT: SessionRuntimeSlot = {
  streaming: false,
  streamingText: "",
  error: null,
  toast: null,
  messages: [],
  accumulated: "",
  streamFinished: true,
};

/**
 * Immutable patch helper. Returns a new Map with the slot for `id`
 * merged with `patch`. Compresses every `setMap(new Map(prev).set(...))`
 * boilerplate at call sites. Patch can be a partial object or a function
 * `(prev) => partial` for read-then-write updates.
 */
export function withSlot(
  prev: Map<string, SessionRuntimeSlot>,
  id: string,
  patch:
    | Partial<SessionRuntimeSlot>
    | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
): Map<string, SessionRuntimeSlot> {
  const next = new Map(prev);
  const current = next.get(id) ?? EMPTY_SLOT;
  const resolved = typeof patch === "function" ? patch(current) : patch;
  next.set(id, { ...current, ...resolved });
  return next;
}

/**
 * Derive the active session's view. Returns EMPTY_SLOT when activeId is
 * null (bootstrap) or unknown (slot not yet initialized). The returned
 * object is the slot itself (referential identity preserved) when known,
 * which lets React's referential-equality optimizations short-circuit
 * unchanged renders.
 */
export function deriveActiveView(
  slots: Map<string, SessionRuntimeSlot>,
  activeId: string | null,
): SessionRuntimeSlot {
  if (!activeId) return EMPTY_SLOT;
  return slots.get(activeId) ?? EMPTY_SLOT;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/sidepanel/hooks/useSession/runtime-map.test.ts`
Expected: PASS — 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/runtime-map.ts \
        src/sidepanel/hooks/useSession/runtime-map.test.ts
git commit -m "feat(panel): add SessionRuntimeSlot map helpers (#30)"
```

---

## Task 2: `port-handlers.ts` — message router scaffold + first branch (chat-chunk)

**Files:**
- Create: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Create: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

**Strategy:** This task lays down the factory + chat-chunk routing as a foundation. Subsequent branches (chat-done, chat-error, agent-step, agent-confirm-request, agent-done-task, session-confirm-request, session-toast) are added incrementally in Tasks 2a–2g via `replace`-style edits to the same file. Splitting them lets each branch land with its own targeted test.

- [ ] **Step 1: Write the failing test for chat-chunk routing**

Create `src/sidepanel/hooks/useSession/port-handlers.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPortHandlers } from "./port-handlers";
import { EMPTY_SLOT, type SessionRuntimeSlot } from "./runtime-map";
import type { PortMessageToPanel } from "@/types";

function makeDeps() {
  const slotsRef = { current: new Map<string, SessionRuntimeSlot>() };
  const setSlots = vi.fn((updater: any) => {
    slotsRef.current =
      typeof updater === "function" ? updater(slotsRef.current) : updater;
  });
  const persistMessages = vi.fn(async () => {});
  return { slotsRef, setSlots, persistMessages };
}

describe("port-handlers — handleMessage routing", () => {
  describe("chat-chunk", () => {
    it("appends text to the slot identified by message.sessionId", () => {
      const deps = makeDeps();
      const { handleMessage } = createPortHandlers(deps);
      handleMessage({ type: "chat-chunk", text: "hi", sessionId: "s1" } as PortMessageToPanel);
      expect(deps.slotsRef.current.get("s1")?.accumulated).toBe("hi");
      expect(deps.slotsRef.current.get("s1")?.streamingText).toBe("hi");
    });

    it("does not touch other sessions' slots", () => {
      const deps = makeDeps();
      deps.slotsRef.current.set("s2", { ...EMPTY_SLOT, accumulated: "existing" });
      const { handleMessage } = createPortHandlers(deps);
      handleMessage({ type: "chat-chunk", text: "x", sessionId: "s1" } as PortMessageToPanel);
      expect(deps.slotsRef.current.get("s2")?.accumulated).toBe("existing");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: FAIL with "Cannot find module './port-handlers'"

- [ ] **Step 3: Implement the factory + chat-chunk branch**

Create `src/sidepanel/hooks/useSession/port-handlers.ts`:

```ts
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DisplayMessage, PortMessageToPanel } from "@/types";
import { withSlot, type SessionRuntimeSlot } from "./runtime-map";

export interface CreatePortHandlersDeps {
  slotsRef: MutableRefObject<Map<string, SessionRuntimeSlot>>;
  setSlots: Dispatch<SetStateAction<Map<string, SessionRuntimeSlot>>>;
  persistMessages: (sessionId: string, messages: DisplayMessage[]) => Promise<void>;
}

export interface PortHandlers {
  /** Single instance, attached to every port. Routes by `message.sessionId`. */
  handleMessage: (msg: PortMessageToPanel) => void;
  /** Per-port closure capturing sessionId. Created fresh in connectPortFor. */
  makeDisconnectHandler: (sessionId: string) => () => void;
}

export function createPortHandlers(deps: CreatePortHandlersDeps): PortHandlers {
  const { slotsRef, setSlots, persistMessages } = deps;

  /** Sync write to slotsRef (Bug-fix-A truth source) + setSlots for React commit. */
  function patchSlot(
    id: string,
    patch:
      | Partial<SessionRuntimeSlot>
      | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
  ) {
    slotsRef.current = withSlot(slotsRef.current, id, patch);
    setSlots(slotsRef.current);
  }

  const handleMessage = (msg: PortMessageToPanel) => {
    const id = msg.sessionId;

    if (msg.type === "chat-chunk") {
      patchSlot(id, (prev) => {
        const accumulated = prev.accumulated + msg.text;
        return { accumulated, streamingText: accumulated };
      });
      return;
    }
    // Subsequent branches added in Tasks 2a–2g.
  };

  const makeDisconnectHandler = (_sessionId: string) => {
    return () => {
      // Implemented in Task 2h.
    };
  };

  return { handleMessage, makeDisconnectHandler };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers factory + chat-chunk routing (#30)"
```

---

## Task 2a: chat-done branch

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `port-handlers.test.ts`:

```ts
describe("chat-done", () => {
  it("flushes accumulated text into messages and resets streaming", async () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "hello world",
      streamingText: "hello world",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "chat-done", sessionId: "s1" } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([{ role: "assistant", content: "hello world" }]);
    expect(slot.accumulated).toBe("");
    expect(slot.streamingText).toBe("");
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    // persistMessages called with the new messages array
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "assistant", content: "hello world" }],
    );
  });

  it("does not append an empty assistant message when accumulated is whitespace", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "   ",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "chat-done", sessionId: "s1" } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([]);
    expect(slot.streaming).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t chat-done`
Expected: FAIL — accumulated/streaming not cleared.

- [ ] **Step 3: Implement the chat-done branch**

In `port-handlers.ts`, replace the `// Subsequent branches added in Tasks 2a–2g.` line with:

```ts
    if (msg.type === "chat-done") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const baseMessages = prev?.messages ?? [];
      const next: DisplayMessage[] = accumulated.trim()
        ? [...baseMessages, { role: "assistant", content: accumulated }]
        : baseMessages;
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }

    // Subsequent branches added in Tasks 2b–2g.
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t chat-done`
Expected: PASS — 2 new tests green; chat-chunk tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers chat-done branch (#30)"
```

---

## Task 2b: chat-error branch

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `port-handlers.test.ts`:

```ts
describe("chat-error", () => {
  it("flushes partial text and stores the error string", async () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "partial",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "chat-error", error: "boom", sessionId: "s1" } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.error).toBe("boom");
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    expect(slot.messages).toEqual([{ role: "assistant", content: "partial" }]);
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "assistant", content: "partial" }],
    );
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t chat-error`
Expected: FAIL.

- [ ] **Step 3: Implement chat-error branch**

In `port-handlers.ts`, before the `// Subsequent branches added in Tasks 2b–2g.` line, insert:

```ts
    if (msg.type === "chat-error") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const baseMessages = prev?.messages ?? [];
      const next: DisplayMessage[] = accumulated.trim()
        ? [...baseMessages, { role: "assistant", content: accumulated }]
        : baseMessages;
      patchSlot(id, {
        error: msg.error,
        messages: next,
        accumulated: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }
```

Update the trailing comment to: `// Subsequent branches added in Tasks 2c–2g.`

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS — all branches still green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers chat-error branch (#30)"
```

---

## Task 2c: agent-step branch

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

This branch is the most complex. It (a) flushes any pending accumulated text into messages first (mirrors legacy `useSession.ts:349-365`), then (b) either updates the existing trailing step bubble in place (matching stepIndex+tool) or appends a new agent-step entry.

- [ ] **Step 1: Add failing tests**

Append to `port-handlers.test.ts`:

```ts
describe("agent-step", () => {
  it("flushes pending accumulated text before appending the step", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "thinking…",
      streamingText: "thinking…",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 0,
      tool: "click",
      args: { selector: "#x" },
      status: "pending",
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([
      { role: "assistant", content: "thinking…" },
      {
        role: "agent-step",
        stepIndex: 0,
        tool: "click",
        args: { selector: "#x" },
        resolvedElement: undefined,
        status: "pending",
        observation: undefined,
      },
    ]);
    expect(slot.accumulated).toBe("");
    expect(slot.streamingText).toBe("");
  });

  it("updates the existing trailing step bubble when stepIndex+tool match", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      messages: [
        {
          role: "agent-step",
          stepIndex: 0,
          tool: "click",
          args: { selector: "#x" },
          resolvedElement: undefined,
          status: "pending",
          observation: undefined,
        },
      ],
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 0,
      tool: "click",
      args: { selector: "#x" },
      status: "ok",
      observation: "clicked",
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toHaveLength(1);
    expect(slot.messages[0]).toMatchObject({ status: "ok", observation: "clicked" });
  });

  it("appends a new step when stepIndex differs", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      messages: [
        {
          role: "agent-step",
          stepIndex: 0,
          tool: "click",
          args: { selector: "#a" },
          resolvedElement: undefined,
          status: "ok",
          observation: "clicked",
        },
      ],
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 1,
      tool: "type",
      args: { text: "hi" },
      status: "pending",
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")!.messages).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t agent-step`
Expected: FAIL.

- [ ] **Step 3: Implement agent-step branch**

In `port-handlers.ts`, before the trailing comment, insert:

```ts
    if (msg.type === "agent-step") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      const accumulated = prev?.accumulated ?? "";

      // 1. Flush pending accumulated text first (legacy behavior preserved
      //    from useSession.ts:349-365).
      let nextMessages: DisplayMessage[] = baseMessages;
      let flushed = false;
      if (accumulated.trim()) {
        nextMessages = [
          ...nextMessages,
          { role: "assistant", content: accumulated },
        ];
        flushed = true;
      }

      // 2. Either update the trailing matching step in place, or append.
      const { stepIndex, tool, args, resolvedElement, status, observation, image } = msg;
      const tail = nextMessages.length - 1;
      const last = tail >= 0 ? nextMessages[tail] : null;
      const matchesTail =
        last &&
        last.role === "agent-step" &&
        last.stepIndex === stepIndex &&
        last.tool === tool;

      const stepEntry: DisplayMessage = {
        role: "agent-step",
        stepIndex,
        tool,
        args,
        resolvedElement,
        status,
        observation,
        ...(image && { image }),
      };

      if (matchesTail) {
        nextMessages = [...nextMessages.slice(0, tail), stepEntry];
      } else {
        nextMessages = [...nextMessages, stepEntry];
      }

      patchSlot(id, {
        messages: nextMessages,
        ...(flushed ? { accumulated: "", streamingText: "" } : {}),
      });
      return;
    }
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS — all branches still green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers agent-step branch (#30)"
```

---

## Task 2d: agent-confirm-request branch

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: Add failing test**

Append to `port-handlers.test.ts`:

```ts
describe("agent-confirm-request", () => {
  it("appends an agent-confirm DisplayMessage with optional preview fields", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-confirm-request",
      sessionId: "s1",
      confirmationId: "c1",
      tool: "click",
      args: { selector: "#submit" },
      riskReason: "submit-button",
      screenshotPreview: { kind: "image_placeholder", id: "i1", mime: "image/jpeg" },
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toHaveLength(1);
    expect(slot.messages[0]).toMatchObject({
      role: "agent-confirm",
      confirmationId: "c1",
      tool: "click",
      riskReason: "submit-button",
      screenshotPreview: { kind: "image_placeholder", id: "i1", mime: "image/jpeg" },
      resolved: undefined,
    });
  });

  it("is idempotent — same confirmationId does not stack", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    const same = {
      type: "agent-confirm-request",
      sessionId: "s1",
      confirmationId: "c1",
      tool: "click",
      args: {},
    } as PortMessageToPanel;
    handleMessage(same);
    handleMessage(same);
    expect(deps.slotsRef.current.get("s1")!.messages).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t agent-confirm-request`
Expected: FAIL.

- [ ] **Step 3: Implement branch**

Insert in `port-handlers.ts` before trailing comment:

```ts
    if (msg.type === "agent-confirm-request") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      // Idempotent — re-emit on panel-mounted (R4) must not stack.
      for (let i = baseMessages.length - 1; i >= 0; i--) {
        const m = baseMessages[i]!;
        if (m.role === "agent-confirm" && m.confirmationId === msg.confirmationId) {
          return;
        }
      }
      const {
        confirmationId, tool, args, resolvedElement, riskReason,
        metaSkillPreview, screenshotPreview, openUrlPreview, originChangePreview,
      } = msg;
      const entry: DisplayMessage = {
        role: "agent-confirm",
        confirmationId,
        tool,
        args,
        resolvedElement,
        riskReason,
        metaSkillPreview,
        ...(screenshotPreview ? { screenshotPreview } : {}),
        ...(openUrlPreview ? { openUrlPreview } : {}),
        ...(originChangePreview ? { originChangePreview } : {}),
        resolved: undefined,
      };
      patchSlot(id, { messages: [...baseMessages, entry] });
      return;
    }
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers agent-confirm-request branch (#30)"
```

---

## Task 2e: agent-done-task branch

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: Add failing test**

Append to `port-handlers.test.ts`:

```ts
describe("agent-done-task", () => {
  it("appends agent-summary, resets streaming, persists", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", { ...EMPTY_SLOT, streaming: true, streamFinished: false });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-done-task",
      sessionId: "s1",
      success: true,
      summary: "ok",
      stepCount: 3,
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([
      { role: "agent-summary", success: true, summary: "ok", stepCount: 3 },
    ]);
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "agent-summary", success: true, summary: "ok", stepCount: 3 }],
    );
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t agent-done-task`
Expected: FAIL.

- [ ] **Step 3: Implement branch**

Insert in `port-handlers.ts`:

```ts
    if (msg.type === "agent-done-task") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      const next: DisplayMessage[] = [
        ...baseMessages,
        {
          role: "agent-summary",
          success: msg.success,
          summary: msg.summary,
          stepCount: msg.stepCount,
        },
      ];
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers agent-done-task branch (#30)"
```

---

## Task 2f: session-confirm-request + session-toast branches

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `port-handlers.test.ts`:

```ts
describe("session-confirm-request", () => {
  it("appends a session-confirm DisplayMessage", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "session-confirm-request",
      sessionId: "s1",
      confirmationId: "sc1",
      kind: "drift-card",
      payload: { driftedOrigin: "https://x.com" },
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toHaveLength(1);
    expect(slot.messages[0]).toMatchObject({
      role: "session-confirm",
      confirmationId: "sc1",
      kind: "drift-card",
    });
  });

  it("is idempotent on confirmationId", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    const m = {
      type: "session-confirm-request",
      sessionId: "s1",
      confirmationId: "sc1",
      kind: "paused-resume",
      payload: {},
    } as PortMessageToPanel;
    handleMessage(m);
    handleMessage(m);
    expect(deps.slotsRef.current.get("s1")!.messages).toHaveLength(1);
  });
});

describe("session-toast", () => {
  it("sets toast on the addressed session's slot", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "session-toast",
      sessionId: "s1",
      level: "warn",
      text: "flood",
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")!.toast).toEqual({ level: "warn", text: "flood" });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement branches**

Insert in `port-handlers.ts`:

```ts
    if (msg.type === "session-confirm-request") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      for (let i = baseMessages.length - 1; i >= 0; i--) {
        const m = baseMessages[i]!;
        if (m.role === "session-confirm" && m.confirmationId === msg.confirmationId) {
          return;
        }
      }
      const entry: DisplayMessage = {
        role: "session-confirm",
        confirmationId: msg.confirmationId,
        kind: msg.kind,
        payload: msg.payload,
        resolved: undefined,
      };
      patchSlot(id, { messages: [...baseMessages, entry] });
      return;
    }

    if (msg.type === "session-toast") {
      patchSlot(id, { toast: { level: msg.level, text: msg.text } });
      return;
    }
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS — all 11+ tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers session-confirm + session-toast branches (#30)"
```

---

## Task 2g: makeDisconnectHandler — flush partial text on unexpected disconnect

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts`
- Modify: `src/sidepanel/hooks/useSession/port-handlers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `port-handlers.test.ts`:

```ts
describe("makeDisconnectHandler", () => {
  it("no-op when streamFinished is true", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", { ...EMPTY_SLOT, streamFinished: true });
    const { makeDisconnectHandler } = createPortHandlers(deps);
    makeDisconnectHandler("s1")();
    expect(deps.persistMessages).not.toHaveBeenCalled();
    expect(deps.slotsRef.current.get("s1")?.streaming).toBe(false);
  });

  it("flushes partial text and persists when streamFinished is false", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "half",
      streaming: true,
      streamFinished: false,
    });
    const { makeDisconnectHandler } = createPortHandlers(deps);
    makeDisconnectHandler("s1")();
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([{ role: "assistant", content: "half" }]);
    expect(slot.accumulated).toBe("");
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "assistant", content: "half" }],
    );
  });

  it("scopes to the captured sessionId only", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", { ...EMPTY_SLOT, streaming: true, streamFinished: false });
    deps.slotsRef.current.set("s2", { ...EMPTY_SLOT, streaming: true, streamFinished: false });
    const { makeDisconnectHandler } = createPortHandlers(deps);
    makeDisconnectHandler("s1")();
    expect(deps.slotsRef.current.get("s2")?.streaming).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -t makeDisconnectHandler`
Expected: FAIL.

- [ ] **Step 3: Implement makeDisconnectHandler**

Replace the placeholder `makeDisconnectHandler` body in `port-handlers.ts`:

```ts
  const makeDisconnectHandler = (sessionId: string) => {
    return () => {
      const slot = slotsRef.current.get(sessionId);
      if (!slot || slot.streamFinished) return;
      const next: DisplayMessage[] = slot.accumulated.trim()
        ? [...slot.messages, { role: "assistant", content: slot.accumulated }]
        : slot.messages;
      patchSlot(sessionId, {
        messages: next,
        accumulated: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(sessionId, next);
    };
  };
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS — all tests green (~14 in this file).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts \
        src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(panel): port-handlers per-port disconnect handler (#30)"
```

---

## Task 3: Relocate `useSession.ts` → `useSession/index.ts`

**Files:**
- Move: `src/sidepanel/hooks/useSession.ts` → `src/sidepanel/hooks/useSession/index.ts`
- Move: `src/sidepanel/hooks/useSession.test.ts` → `src/sidepanel/hooks/useSession/index.test.ts`

This task does NOT change any logic. It only relocates the existing files so subsequent tasks can edit them inside the new directory alongside `runtime-map.ts` / `port-handlers.ts`.

- [ ] **Step 1: Move the source file via git**

Run:
```bash
git mv src/sidepanel/hooks/useSession.ts src/sidepanel/hooks/useSession/index.ts
```

- [ ] **Step 2: Move the test file via git**

Run:
```bash
git mv src/sidepanel/hooks/useSession.test.ts src/sidepanel/hooks/useSession/index.test.ts
```

- [ ] **Step 3: Verify importers still resolve**

Vite/TypeScript resolves `@/sidepanel/hooks/useSession` to `src/sidepanel/hooks/useSession/index.ts` automatically. Run typecheck + tests:

```bash
pnpm test src/sidepanel/hooks/useSession/index.test.ts
pnpm test src/sidepanel/hooks/useSession/runtime-map.test.ts
pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts
```

Expected: ALL PASS — pre-existing tests untouched, new helper tests still green.

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: build succeeds, no path-resolution errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(panel): relocate useSession.ts to useSession/index.ts (#30)"
```

---

## Task 4: Wire `slots: Map` state + `slotsRef` into `useSession/index.ts`

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

This task introduces the new `slots` state and `slotsRef` alongside the legacy single-tenant state — both coexist temporarily. Subsequent tasks (5–9) migrate readers/writers off the legacy refs onto the slots map. After the migration is complete (Task 9b), the legacy state is deleted in one cleanup commit.

- [ ] **Step 1: Add imports**

In `src/sidepanel/hooks/useSession/index.ts`, near the existing top-of-file imports, add:

```ts
import {
  EMPTY_SLOT,
  deriveActiveView,
  withSlot,
  type SessionRuntimeSlot,
} from "./runtime-map";
import { createPortHandlers } from "./port-handlers";
```

- [ ] **Step 2: Add `slots` state + `slotsRef`**

Inside `useSession()`, immediately after the existing `streamingRef` ref declaration (around line 240), add:

```ts
  // Multi-session migration (#30) — all per-task runtime state is keyed by
  // sessionId. Legacy single-tenant state (streaming, streamingText, error,
  // toast, messages, accumulatedRef, streamFinishedRef, streamingRef) is
  // kept alongside during the migration and removed in a single commit
  // once every reader/writer has been ported.
  const [slots, setSlots] = useState<Map<string, SessionRuntimeSlot>>(new Map());
  const slotsRef = useRef<Map<string, SessionRuntimeSlot>>(new Map());

  // patchSlot — sync write to slotsRef (Bug-fix-A truth source) + setSlots
  // for React commit. Mirrors the contract documented on streamingRef.
  const patchSlot = useCallback(
    (
      id: string,
      patch:
        | Partial<SessionRuntimeSlot>
        | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
    ) => {
      slotsRef.current = withSlot(slotsRef.current, id, patch);
      setSlots(slotsRef.current);
    },
    [],
  );
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: build succeeds. (No callers yet — slots/slotsRef are unused.)

- [ ] **Step 4: Verify tests**

Run: `pnpm test src/sidepanel/hooks/useSession/`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts
git commit -m "feat(panel): scaffold slots map + slotsRef in useSession (#30)"
```

---

## Task 5: Migrate `portRef` → `portsRef: Map<string, Port>`

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

- [ ] **Step 1: Replace the portRef declaration**

Find (around line 224):
```ts
const portRef = useRef<chrome.runtime.Port | null>(null);
```
Replace with:
```ts
// Multi-session (#30) — one Port per sessionId. Switching sessions does
// NOT disconnect the previous port; SW continues delivering messages for
// background tasks via createPortHandlers' single onMessage listener.
// Cleanup: panel unmount disconnects every entry.
const portsRef = useRef<Map<string, chrome.runtime.Port>>(new Map());
```

- [ ] **Step 2: Update every existing reader of `portRef.current`**

Search the file for `portRef.current` and replace each occurrence with the appropriate active-session lookup. The pattern is:

| Old | New |
|-----|-----|
| `portRef.current?.disconnect(); portRef.current = null;` (in setActive/createAndActivate) | DELETE — Tasks 7 + 8 simplify these flows. For now, replace with: `// (multi-session: old port stays connected, deletion deferred to Tasks 7+8)` |
| `portRef.current = connectPortFor(meta.id)` | `portsRef.current.set(meta.id, connectPortFor(meta.id))` |
| `portRef.current = connectPortFor(id)` | `portsRef.current.set(id, connectPortFor(id))` |
| `const port = portRef.current` (in sendMessage / abort / resumeTask / discardTask / resolveConfirm) | `const port = portsRef.current.get(sessionIdRef.current ?? "") ?? null` |
| `portRef.current?.disconnect(); portRef.current = null;` (in handlePortDisconnect) | `portsRef.current.delete(/* sessionId from closure */)` — but `handlePortDisconnect` is replaced wholesale by `makeDisconnectHandler` in Task 8 — leave a TODO marker for now: `// TODO Task 8: replaced by makeDisconnectHandler` |
| Final return: `port: portRef.current` | `port: sessionIdRef.current ? portsRef.current.get(sessionIdRef.current) ?? null : null` |
| Unmount cleanup `portRef.current?.disconnect(); portRef.current = null;` | replaced wholesale in Task 9 — for now: `for (const p of portsRef.current.values()) { try { p.disconnect(); } catch {} } portsRef.current.clear();` |

Use VSCode multi-cursor or a manual review pass — every occurrence needs explicit attention.

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Verify existing tests**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: PASS (pre-existing single-session behavior unchanged — only one entry in `portsRef`).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts
git commit -m "refactor(panel): portRef -> portsRef Map<sessionId, Port> (#30)"
```

---

## Task 6: Migrate `handlePortMessage` and `handlePortDisconnect` to use createPortHandlers

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

- [ ] **Step 1: Add a `persistMessagesById` helper**

The existing `persistMessages: (next: DisplayMessage[]) => Promise<void>` derives sessionId from `sessionIdRef.current`. The new port handlers pass sessionId explicitly. Add a sessionId-aware variant near the existing `persistMessages` declaration (around line 270):

```ts
// Multi-session (#30) — sessionId-explicit variant for port handlers. The
// legacy persistMessages (which reads sessionIdRef) is preserved during
// migration and removed in Task 9b once all callers move off it.
const persistMessagesById = useCallback(
  async (id: string, next: DisplayMessage[]) => {
    const current = await getSessionMeta(id);
    if (!current) return;
    if (current.status === "archived") return;
    const titlePatch =
      current.title === undefined || current.title === ""
        ? deriveTitleFromMessages(next)
        : undefined;
    await setSessionMeta({
      ...current,
      messages: next,
      lastAccessedAt: Date.now(),
      ...(titlePatch !== undefined ? { title: titlePatch } : {}),
    });
  },
  [],
);
```

- [ ] **Step 2: Create the port handlers via the factory**

Below the `persistMessagesById` declaration, add:

```ts
// Multi-session (#30) — single onMessage listener routes by message.sessionId;
// per-port disconnect closure flushes partial text scoped to that port's session.
const portHandlers = useMemo(
  () => createPortHandlers({ slotsRef, setSlots, persistMessages: persistMessagesById }),
  [persistMessagesById],
);
```

Add `useMemo` to the React import line at the top of the file if it isn't already there.

- [ ] **Step 3: Replace handler hookups in `connectPortFor`**

Find the existing `connectPortFor` (around line 543):
```ts
const connectPortFor = useCallback(
  (id: string) => {
    const port = chrome.runtime.connect({ name: `chat-stream-${id}` });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(handlePortDisconnect);
    port.postMessage({ type: "panel-mounted", sessionId: id });
    return port;
  },
  [handlePortMessage, handlePortDisconnect],
);
```

Replace with:
```ts
const connectPortFor = useCallback(
  (id: string) => {
    const port = chrome.runtime.connect({ name: `chat-stream-${id}` });
    port.onMessage.addListener(portHandlers.handleMessage);
    port.onDisconnect.addListener(portHandlers.makeDisconnectHandler(id));
    port.postMessage({ type: "panel-mounted", sessionId: id });
    return port;
  },
  [portHandlers],
);
```

- [ ] **Step 4: Delete the legacy handlers**

Remove the entire `handlePortMessage` and `handlePortDisconnect` `useCallback` definitions (around lines 302–532 — verify exact range with a current Read of the file before deletion). Their behavior is now handled by `portHandlers`.

- [ ] **Step 5: Verify build + run pre-existing tests**

Run: `pnpm build && pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: build PASS; tests should now interact with the new handlers. **Some existing tests may fail** if they hooked directly into the legacy handler closure — fix by making them dispatch via `port.onMessage` (the standard Chrome API path) rather than calling the handler directly. Each fix should be noted in the commit message; do not weaken any assertion.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts \
        src/sidepanel/hooks/useSession/index.test.ts
git commit -m "refactor(panel): route port messages through createPortHandlers (#30)"
```

---

## Task 7: Simplify `setActive` — drop disconnect, drop streaming guard, gate port creation by status

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

- [ ] **Step 1: Add a failing regression test in index.test.ts**

Append to `src/sidepanel/hooks/useSession/index.test.ts`:

```ts
describe("setActive — multi-session port lifecycle (#30)", () => {
  it("does not disconnect the previous session's port on switch", async () => {
    // Arrange: bootstrap two sessions, capture ports
    // (Use the existing test harness pattern — chrome mock with
    // runtime.connect returning a recorded port object.)
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = lastConnectedPort(); // helper from existing harness

    // Create a second session
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = lastConnectedPort();

    expect(portA.disconnect).not.toHaveBeenCalled();
    expect(portB).not.toBe(portA);
    expect(result.current.sessionId).toBe(idB);
  });

  it("does not refuse setActive while streaming", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    // Force streaming = true on the active slot
    act(() => {
      result.current.sendMessage({ content: "hello" });
    });
    expect(result.current.streaming).toBe(true);
    // Create a second session — should NOT return null (streaming guard removed)
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    expect(idB).not.toBeNull();
  });
});
```

If the existing test file does not already export `lastConnectedPort()` and similar harness helpers, examine the file and reuse whatever fixture pattern is already in place. Add minimal helpers if needed and document them inline.

- [ ] **Step 2: Verify the tests fail against current code**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts -t "multi-session port lifecycle"`
Expected: FAIL — `portA.disconnect` IS called by the legacy `setActive`; `createAndActivate` returns null when streaming.

- [ ] **Step 3: Simplify `setActive`**

Find the existing `setActive` body (around lines 972–1056). Replace its body with:

```ts
const setActive = useCallback(async (id: string): Promise<string | null> => {
  // #30 — streaming guard removed: switching sessions no longer kills tasks.
  // Old port stays connected; SW keeps streaming into its session's slot.

  const meta = await getSessionMeta(id);
  if (!meta) return null;
  if (sessionIdRef.current === id) return id;

  // Legacy-pin migration (M3-U2 post-acceptance) — preserved verbatim.
  let metaForActivate = meta;
  let didMigrate = false;
  const sessionHasContent = (meta.messages?.length ?? 0) > 0;
  if (sessionHasContent && (!meta.pinnedTabs || meta.pinnedTabs.length === 0)) {
    const pinned = await captureActivePinned();
    if (pinned) {
      const pinEntry = { tabId: pinned.pinnedTabId, origin: pinned.pinnedOrigin };
      const patched = {
        ...meta,
        pinMode: "task" as const,
        pinnedTabs: [pinEntry],
        lastAccessedAt: Date.now(),
      };
      await setSessionMeta(patched);
      metaForActivate = patched;
      didMigrate = true;
    }
  }
  if (!didMigrate) await updateLastAccessed(id);

  sessionIdRef.current = id;
  setSessionId(id);
  setStatus(metaForActivate.status);
  const activatePins = metaForActivate.pinnedTabs;
  setPinnedTabsState(activatePins && activatePins.length > 0 ? activatePins : null);
  setPinModeState(metaForActivate.pinMode ?? "auto");

  // Multi-session: hydrate slot from storage IFF the slot doesn't already
  // hold streaming state (a background task on this session would have
  // a live slot already; do not clobber it with stale storage messages).
  patchSlot(id, (prev) => {
    if (prev.streaming) return {}; // keep live slot intact
    return {
      messages: metaForActivate.messages ?? [],
      error: null,
      toast: null,
      accumulated: "",
      streamingText: "",
      streaming: false,
      streamFinished: true,
    };
  });

  // §3.4 invariant — paused / archived sessions do NOT auto-create a port.
  // Resume / archived-readonly flows decide explicitly when to connect.
  if (
    !portsRef.current.has(id) &&
    metaForActivate.status !== "archived" &&
    metaForActivate.status !== "paused"
  ) {
    portsRef.current.set(id, connectPortFor(id));
  }

  return id;
}, [connectPortFor, patchSlot]);
```

- [ ] **Step 4: Verify the new tests pass + existing tests still pass**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: PASS — both new regression tests + existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts \
        src/sidepanel/hooks/useSession/index.test.ts
git commit -m "feat(panel): simplify setActive — keep background ports alive (#30)"
```

---

## Task 8: Simplify `createAndActivate` — drop disconnect + drop #29 streaming guard

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

- [ ] **Step 1: Verify existing #29 guard test would now fail (intentional)**

Locate the regression test introduced by PR #29 in `index.test.ts` (search: "Stop the current task before starting a new session"). This test asserts the streaming guard refuses session creation. With multi-session enabled, that guard is gone — the test should now FAIL or be deleted.

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts -t "streamingRef.current"`
If the test still passes, examine its body — it may be testing the old behavior. Either:
1. Delete the test if it was purely an Issue #24 Bug 2 regression
2. Rewrite it to test the new behavior (streaming session creates a sibling without affecting the running task)

Document the choice in commit message.

- [ ] **Step 2: Simplify `createAndActivate`**

Replace the entire `createAndActivate` body (around lines 1068–1114):

```ts
const createAndActivate = useCallback(async (): Promise<string | null> => {
  // #30 — streaming guard removed; old port stays connected for the
  // background task. SW already supports concurrent ports per PR #29.
  const meta = await createSession();
  sessionIdRef.current = meta.id;
  setSessionId(meta.id);
  setStatus(meta.status);
  setPinnedTabsState(null);
  setPinModeState("auto");
  patchSlot(meta.id, EMPTY_SLOT);
  portsRef.current.set(meta.id, connectPortFor(meta.id));
  return meta.id;
}, [connectPortFor, patchSlot]);
```

- [ ] **Step 3: Verify multi-session lifecycle test still passes**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: PASS — including the Task 7 regression tests for "does not refuse setActive while streaming" and "does not disconnect the previous session's port".

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts \
        src/sidepanel/hooks/useSession/index.test.ts
git commit -m "feat(panel): drop #29 streaming guard — concurrent sessions enabled (#30)"
```

---

## Task 9: Migrate readers off legacy single-tenant state onto `slots`/`slotsRef`

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

This task replaces `streaming` / `streamingText` / `error` / `toast` / `messages` / `accumulatedRef` / `streamFinishedRef` / `streamingRef` reads with `slots`-based equivalents. After this task, the legacy state declarations themselves can be deleted (Task 9b).

- [ ] **Step 1: Add the active-view derivation**

Inside the hook body (after `slots` state declaration), add:

```ts
// #30 — derive active session view; passed back through UseSession interface.
const active = deriveActiveView(slots, sessionId);
```

- [ ] **Step 2: Replace return-statement reads**

Find the final `return { ... }` (around line 1158). Replace the streaming/text/error/toast/messages fields:

```ts
return {
  sessionId,
  ready,
  status,
  pinnedTabs: pinnedTabsState,
  pinMode,
  messages: active.messages,
  streaming: active.streaming,
  streamingText: active.streamingText,
  error: active.error,
  toast: active.toast,
  // ... (all other fields unchanged)
  port: sessionId ? (portsRef.current.get(sessionId) ?? null) : null,
};
```

- [ ] **Step 3: Replace `streamingRef.current` reads**

Search the file for `streamingRef.current` and replace each:

| Context | Old | New |
|---------|-----|-----|
| In storage `onChanged` listener (around line 676) | `if (streamingRef.current) return;` | `if (slotsRef.current.get(sessionId)?.streaming) return;` |
| `sendMessage` body (around line 748) | `streamingRef.current = true;` | (removed — sendMessage now patches slot, see Step 4) |
| `sendMessage` early-return guard (around line 713) | `if (streaming) return;` | `if (slotsRef.current.get(sessionIdRef.current ?? "")?.streaming) return;` |
| `resumeTask` (around line 906) | `streamingRef.current = true;` | (removed — see Step 4) |
| `resumeTask` failure rollback (around line 917) | `streamingRef.current = false;` | (removed — see Step 4) |

- [ ] **Step 4: Update `sendMessage` to write the slot directly**

Find `sendMessage` (around line 711). Replace its body's state-mutation block (the lines that set messagesRef, streamingRef, setMessages, setStreaming, setStreamingText, setError, accumulatedRef, streamFinishedRef) with:

```ts
const userMessage: DisplayMessage = { /* unchanged construction above */ };
const updated = [...active.messages, userMessage];
const isFirstMessage = active.messages.length === 0;

// Multi-session (#30) — atomic slot update; replaces messagesRef + streamingRef
// + setMessages + setStreaming + setStreamingText + setError manual sync.
patchSlot(id, {
  messages: updated,
  streaming: true,
  streamFinished: false,
  accumulated: "",
  streamingText: "",
  error: null,
});
```

The persist + chat-start postMessage logic below it stays unchanged.

- [ ] **Step 5: Update `resumeTask` to write the slot**

Replace its streaming-flip block:

```ts
const resumeTask = useCallback(() => {
  const port = portsRef.current.get(sessionIdRef.current ?? "");
  const id = sessionIdRef.current;
  if (!port || !id) return;
  patchSlot(id, {
    streaming: true,
    accumulated: "",
    streamFinished: false,
    error: null,
  });
  try {
    port.postMessage({ type: "resume-task", sessionId: id });
  } catch {
    patchSlot(id, { streaming: false, streamFinished: true });
  }
}, [patchSlot]);
```

- [ ] **Step 6: Update `clearError` / `clearToast` / `setError` callers**

Replace each `setError(null)` / `setError(message.error)` / `setToast({ ... })` / `setToast(null)` call with `patchSlot(activeIdHere, { error: ... })` / `patchSlot(activeIdHere, { toast: ... })` — using `sessionIdRef.current` as the activeIdHere where appropriate. Each occurrence:

| Old | New |
|-----|-----|
| `setError(null)` (in setActive, createAndActivate, sendMessage, abort, etc.) | already replaced via patchSlot in those tasks; verify no stragglers |
| `setError(...)` in storage listener | left over from legacy handler — should already be removed by Task 6 |
| `setToast({ ... })` | not removed by Task 6's #29 streaming-guard removal — replace with `patchSlot(sessionIdRef.current, { toast: { ... } })` |
| `setToast(null)` | replace with `patchSlot(sessionIdRef.current, { toast: null })` |

- [ ] **Step 7: Update `clearMessages`**

Replace its body:

```ts
const clearMessages = useCallback(async () => {
  const id = sessionIdRef.current;
  if (!id) return;
  patchSlot(id, { messages: [], error: null, toast: null });
  await persistMessagesById(id, []);
}, [patchSlot, persistMessagesById]);
```

- [ ] **Step 8: Run all tests + build**

Run:
```bash
pnpm test src/sidepanel/hooks/useSession/
pnpm build
```
Expected: ALL PASS — single-session behavior preserved (every Task 9 change is a behavior-equivalent rewrite, not a behavior change).

- [ ] **Step 9: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts
git commit -m "refactor(panel): migrate runtime reads to slots map (#30)"
```

---

## Task 9b: Delete the legacy single-tenant state

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

After Task 9 every reader/writer is on `slots` / `slotsRef`. The legacy state now exists only as dead declarations.

- [ ] **Step 1: Confirm no remaining usages**

Run:
```bash
grep -n "setStreaming\|setStreamingText\|setError\|setToast\|setMessages\|messagesRef\|streamingRef\|streamFinishedRef\|accumulatedRef\b" src/sidepanel/hooks/useSession/index.ts
```
Expected output: ONLY the legacy declarations themselves — no readers/writers.

If anything else turns up, return to Task 9 and fix it before deleting.

- [ ] **Step 2: Delete legacy declarations**

Remove these blocks from `index.ts`:

```ts
const [streaming, setStreaming] = useState(false);
const [streamingText, setStreamingText] = useState("");
const [error, setError] = useState<string | null>(null);
const [toast, setToast] = useState<{ level: "warn" | "error" | "info"; text: string } | null>(null);
const [messages, setMessages] = useState<DisplayMessage[]>([]);
// ...
const messagesRef = useRef<DisplayMessage[]>([]);
const streamingRef = useRef<boolean>(false);
const accumulatedRef = useRef<string>("");
const streamFinishedRef = useRef<boolean>(true);
// + their sync useEffects (the three blocks at lines 246–256)
```

Also remove the legacy `persistMessages` (sessionIdRef-derived) — every caller now uses `persistMessagesById`.

- [ ] **Step 3: Run tests + build**

```bash
pnpm test src/sidepanel/hooks/useSession/
pnpm build
```
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts
git commit -m "refactor(panel): delete legacy single-tenant state in useSession (#30)"
```

---

## Task 10: Multi-port mount/unmount lifecycle

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts`

- [ ] **Step 1: Add a failing test for unmount cleanup**

Append to `index.test.ts`:

```ts
describe("unmount lifecycle (#30)", () => {
  it("disconnects every port in portsRef on unmount", async () => {
    const { result, unmount } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const portA = lastConnectedPort();
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = lastConnectedPort();
    expect(portA.disconnect).not.toHaveBeenCalled();
    expect(portB.disconnect).not.toHaveBeenCalled();
    unmount();
    expect(portA.disconnect).toHaveBeenCalledTimes(1);
    expect(portB.disconnect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts -t "unmount lifecycle"`
Expected: pre-existing unmount cleanup may already disconnect one port (the active one); the new port (background) won't be touched. Test fails on the second expectation.

- [ ] **Step 3: Update the mount `useEffect` cleanup function**

Find the `useEffect` that bootstraps the first session (around line 554). Replace its cleanup return:

```ts
return () => {
  cancelled = true;
  // #30 — disconnect every port. Each disconnect triggers the SW's
  // port.onDisconnect: transitionPortInFlightSessionsToPaused marks any
  // in-flight session for that port as paused (R10/R14 invariant).
  for (const port of portsRef.current.values()) {
    try { port.disconnect(); } catch {}
  }
  portsRef.current.clear();
};
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts \
        src/sidepanel/hooks/useSession/index.test.ts
git commit -m "feat(panel): unmount disconnects all ports (#30)"
```

---

## Task 11: SW — remove `R13(c) evictOnSetActive` call

**Files:**
- Modify: `src/background/index.ts`
- Modify: `src/background/image-cache.test.ts`

- [ ] **Step 1: Add a failing concurrent-cache test**

Create `src/background/image-cache.concurrent.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  addImage,
  evictSession,
  evictByInFlightSet,
  _getCacheSessionCount,
  _getCacheSizeBytes,
  _resetForTests,
} from "./image-cache";

describe("image-cache — multi-session no cross-eviction (#30)", () => {
  beforeEach(() => _resetForTests());

  it("retains session A's images when session B's cache is added", () => {
    addImage("a", new Uint8Array([1, 2, 3]).buffer);
    addImage("b", new Uint8Array([4, 5, 6]).buffer);
    expect(_getCacheSessionCount()).toBe(2);
    expect(_getCacheSizeBytes("a")).toBe(3);
    expect(_getCacheSizeBytes("b")).toBe(3);
  });

  it("R13(a) evictSession only clears the named session", () => {
    addImage("a", new Uint8Array([1, 2, 3]).buffer);
    addImage("b", new Uint8Array([4, 5, 6]).buffer);
    evictSession("a");
    expect(_getCacheSizeBytes("a")).toBe(0);
    expect(_getCacheSizeBytes("b")).toBe(3);
  });

  it("R13(d) evictByInFlightSet preserves sessions not in the set", () => {
    addImage("a", new Uint8Array([1]).buffer);
    addImage("b", new Uint8Array([2]).buffer);
    addImage("c", new Uint8Array([3]).buffer);
    evictByInFlightSet(["a", "c"]);
    expect(_getCacheSizeBytes("a")).toBe(0);
    expect(_getCacheSizeBytes("b")).toBe(1);
    expect(_getCacheSizeBytes("c")).toBe(0);
  });
});
```

These tests should already pass against `image-cache.ts` (which doesn't itself call evictOnSetActive). The real verification is **the SW-side wire**: a concurrent integration test (Task 14) confirms the SW path no longer calls evictOnSetActive when a new port connects.

- [ ] **Step 2: Verify the unit test passes (image-cache.ts unchanged)**

Run: `pnpm test src/background/image-cache.concurrent.test.ts`
Expected: PASS — image-cache primitives behave correctly.

- [ ] **Step 3: Remove the SW call**

In `src/background/index.ts`, find the line (around 1551):

```ts
evictOnSetActive(portSessionId);
```

Delete it. Replace the surrounding R13(c) comment block with:

```ts
// R13(c) evictOnSetActive removed (#30) — multi-session: a new port no
// longer means the previous active session is exiting. Image-cache 30 MB
// per-session LRU + R13(a) emitDone + R13(b) SW restart + R13(d) port
// disconnect remain in effect. evictOnSetActive function body retained
// in image-cache.ts for any future explicit-clear UI surface.
```

- [ ] **Step 4: Update the existing image-cache.test.ts comment**

Find the existing `(c) evictOnSetActive` test (around line 79). Add a comment above it:

```ts
// Function-body unit test retained — SW path no longer calls this since
// #30 (concurrent sessions). Kept exported for any future user-driven
// explicit-clear surface.
```

- [ ] **Step 5: Verify build + all tests**

```bash
pnpm test src/background/image-cache
pnpm build
```
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/index.ts \
        src/background/image-cache.test.ts \
        src/background/image-cache.concurrent.test.ts
git commit -m "refactor(sw): remove R13(c) evictOnSetActive call site (#30)"
```

---

## Task 12: SW — keep-alive interval scoped to in-flight tasks

**Files:**
- Modify: `src/background/index.ts`

- [ ] **Step 1: Add a failing test**

Create `src/background/keep-alive.concurrent.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// This test exercises the keep-alive helpers in isolation. The full SW
// integration (port.onConnect closure) is verified by Task 14's
// cross-layer test.
describe("SW keep-alive — scoped to in-flight tasks (#30)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ensureKeepAlive starts the interval; maybeStopKeepAlive clears it when no in-flight", async () => {
    // The helpers will be exported from a new module
    // src/background/keep-alive.ts in Step 3. Until then this import will fail.
    const { createKeepAlive } = await import("./keep-alive");
    const tick = vi.fn();
    const inFlight = new Set<string>();
    const ka = createKeepAlive({ tick, inFlight, intervalMs: 1000 });

    // No interval yet
    vi.advanceTimersByTime(2000);
    expect(tick).not.toHaveBeenCalled();

    // Start: interval runs while in-flight
    inFlight.add("s1");
    ka.ensure();
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(2);

    // Drop session, but try to stop while another is in-flight: still runs
    inFlight.add("s2");
    inFlight.delete("s1");
    ka.maybeStop();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(3);

    // Drop last session; maybeStop should now clear
    inFlight.delete("s2");
    ka.maybeStop();
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(3); // unchanged — interval cleared

    // Re-arm via ensure
    inFlight.add("s3");
    ka.ensure();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(4);

    // Cleanup
    ka.stop();
  });

  it("ensure is idempotent — does not stack intervals", () => {
    return import("./keep-alive").then(({ createKeepAlive }) => {
      const tick = vi.fn();
      const inFlight = new Set<string>(["s1"]);
      const ka = createKeepAlive({ tick, inFlight, intervalMs: 1000 });
      ka.ensure();
      ka.ensure();
      ka.ensure();
      vi.advanceTimersByTime(1000);
      expect(tick).toHaveBeenCalledTimes(1);
      ka.stop();
    });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test src/background/keep-alive.concurrent.test.ts`
Expected: FAIL — `Cannot find module './keep-alive'`.

- [ ] **Step 3: Implement the helper module**

Create `src/background/keep-alive.ts`:

```ts
/**
 * Per-port keep-alive controller (#30). MV3 service workers idle out
 * after ~30s of no activity; while a task is in flight we ping
 * `chrome.runtime.getPlatformInfo()` every 25s to keep the SW alive.
 * When no tasks are in flight (all done / aborted), we stop the
 * interval so the SW can idle out naturally.
 *
 * Scope: ONE controller per port (mirrors the existing per-port closure
 * in chrome.runtime.onConnect). The `inFlight` Set is the port's
 * inFlightSessionIds — controller queries it inside maybeStop().
 */
export interface KeepAlive {
  /** Start the interval if not already running. Idempotent. */
  ensure: () => void;
  /** Stop the interval if and only if `inFlight.size === 0`. */
  maybeStop: () => void;
  /** Unconditionally stop. Called on port disconnect. */
  stop: () => void;
}

export function createKeepAlive(deps: {
  tick: () => void;
  inFlight: { size: number };
  intervalMs?: number;
}): KeepAlive {
  const intervalMs = deps.intervalMs ?? 25_000;
  let handle: ReturnType<typeof setInterval> | null = null;
  return {
    ensure() {
      if (handle !== null) return;
      handle = setInterval(deps.tick, intervalMs);
    },
    maybeStop() {
      if (deps.inFlight.size > 0) return;
      if (handle === null) return;
      clearInterval(handle);
      handle = null;
    },
    stop() {
      if (handle === null) return;
      clearInterval(handle);
      handle = null;
    },
  };
}
```

- [ ] **Step 4: Verify the unit tests pass**

Run: `pnpm test src/background/keep-alive.concurrent.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/background/index.ts`**

Find the keep-alive block (around line 1631):
```ts
// Keep-alive: reset Service Worker idle timer while streaming
const keepAliveInterval = setInterval(() => {
  chrome.runtime.getPlatformInfo();
}, 25_000);
```

Replace with:
```ts
// #30 — keep-alive scoped to in-flight tasks. ensure() at chat-start /
// resume-task; maybeStop() after each task terminal state.
const keepAlive = createKeepAlive({
  tick: () => chrome.runtime.getPlatformInfo(),
  inFlight: inFlightSessionIds,
});
```

Add the import at the top of `index.ts`:
```ts
import { createKeepAlive } from "./keep-alive";
```

Find the existing `port.onDisconnect` cleanup (around line 1774):
```ts
clearInterval(keepAliveInterval);
```
Replace with:
```ts
keepAlive.stop();
```

Find the `chat-start` handler (around line 1652):
```ts
} else if (message.type === "chat-start") {
  if (!verifyPortSession(message.sessionId, "chat-start")) return;
  rotateAbortController(abortRotation, drainPendingConfirms);
  inFlightSessionIds.add(message.sessionId);
  handleChatStream(...);
}
```

Add `keepAlive.ensure()` after `inFlightSessionIds.add`:
```ts
} else if (message.type === "chat-start") {
  if (!verifyPortSession(message.sessionId, "chat-start")) return;
  rotateAbortController(abortRotation, drainPendingConfirms);
  inFlightSessionIds.add(message.sessionId);
  keepAlive.ensure();
  handleChatStream(...);
}
```

Mirror in the `resume-task` handler (around line 1715):
```ts
inFlightSessionIds.add(message.sessionId);
keepAlive.ensure();
```

- [ ] **Step 6: Wire `inFlightSessionIds.delete` + `keepAlive.maybeStop` into terminal cleanup**

Find `handleChatStream` (around line 1044). Wrap the body in try/finally so terminal cleanup runs on every exit (success / error / signal-abort):

```ts
async function handleChatStream(
  port: chrome.runtime.Port,
  messages: ChatMessage[],
  sessionId: string,
  abortController: AbortController,
  pendingConfirmations: ...,
  pendingConfirmationsBySession: ...,
  keepAlive: KeepAlive,  // NEW PARAM
) {
  try {
    // ... existing body ...
  } finally {
    inFlightSessionIds.delete(sessionId);
    keepAlive.maybeStop();
  }
}
```

Wait — `inFlightSessionIds` is a closure inside `chrome.runtime.onConnect`, not a global. The cleanest path is to **pass `inFlightSessionIds` and `keepAlive` into `handleChatStream`** as parameters (mirror how `pendingConfirmationsBySession` is already passed):

In `handleChatStream` signature, add `inFlightSessionIds: Set<string>` and `keepAlive: KeepAlive` parameters.

In the SW closure call sites, pass them:
```ts
handleChatStream(
  port,
  message.messages,
  message.sessionId,
  abortRotation.current,
  pendingConfirmations,
  pendingConfirmationsBySession,
  inFlightSessionIds,
  keepAlive,
);
```

Mirror in `handleResumeRequest` (signature + call site).

Add the `KeepAlive` type import at the top of index.ts:
```ts
import { createKeepAlive, type KeepAlive } from "./keep-alive";
```

- [ ] **Step 7: Verify build + all SW tests**

```bash
pnpm test src/background/
pnpm build
```
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add src/background/index.ts src/background/keep-alive.ts \
        src/background/keep-alive.concurrent.test.ts
git commit -m "feat(sw): scope keep-alive interval to in-flight tasks (#30)"
```

---

## Task 13: panel-side concurrent integration tests

**Files:**
- Create: `src/sidepanel/hooks/useSession/concurrent.test.ts`

This file verifies the multi-session behaviors at the hook boundary using the existing happy-dom + RTL fixture pattern from `index.test.ts`. Reuse the existing `lastConnectedPort()` / chrome mock helpers.

- [ ] **Step 1: Write Case 1 — concurrent chat-chunk routing**

Create `src/sidepanel/hooks/useSession/concurrent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSession } from "./index";
// Reuse helpers / chrome mock setup from index.test.ts.
// If they aren't already exported, lift them into a shared
// ./test-utils.ts as a small refactor inside this task.

describe("useSession concurrent (#30) — Case 1: chat-chunk routing", () => {
  it("routes chat-chunk to the addressed session's slot only", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = lastConnectedPort();

    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = lastConnectedPort();

    // Background chunk to A while B is active
    act(() => {
      portA.simulateMessage({ type: "chat-chunk", text: "from-A", sessionId: idA });
    });
    // Active session view is B — should be unchanged
    expect(result.current.streamingText).toBe("");
    // Switch back to A — the chunk should be visible
    await act(async () => {
      await result.current.setActive(idA);
    });
    expect(result.current.streamingText).toBe("from-A");
  });
});
```

- [ ] **Step 2: Verify failure (no-issue if helpers don't exist yet)**

Run: `pnpm test src/sidepanel/hooks/useSession/concurrent.test.ts`
If the test fixture helpers (`lastConnectedPort`, `simulateMessage`) don't exist yet, lift them from `index.test.ts` into a new `src/sidepanel/hooks/useSession/test-utils.ts` BEFORE writing more cases. Document this as a sub-step in the commit.

- [ ] **Step 3: Add Case 2 — agent-done-task arrives while session is backgrounded**

Append:

```ts
describe("useSession concurrent (#30) — Case 2: background done", () => {
  it("agent-done-task on backgrounded A is visible after switching back", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = lastConnectedPort();
    // Start a fake task on A
    act(() => {
      result.current.sendMessage({ content: "hi" });
    });
    // Switch to a new session B
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    expect(result.current.sessionId).toBe(idB);
    // SW emits done for A (background)
    act(() => {
      portA.simulateMessage({
        type: "agent-done-task",
        sessionId: idA,
        success: true,
        summary: "done",
        stepCount: 2,
      });
    });
    expect(result.current.streaming).toBe(false); // B is not streaming
    // Switch back to A — see the summary
    await act(async () => {
      await result.current.setActive(idA);
    });
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last).toMatchObject({ role: "agent-summary", success: true, summary: "done" });
  });
});
```

- [ ] **Step 4: Add Case 3 — confirm waiting in background, switch back, approve**

Append:

```ts
describe("useSession concurrent (#30) — Case 3: confirm in background", () => {
  it("agent-confirm-request appears in slot, persists across switch, is approvable", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = lastConnectedPort();
    // SW emits confirm-request on A while user switches to new B
    act(() => {
      portA.simulateMessage({
        type: "agent-confirm-request",
        sessionId: idA,
        confirmationId: "c1",
        tool: "click",
        args: { selector: "#x" },
        riskReason: "submit-button",
      });
    });
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    // Switch back to A — confirm card is still in messages
    await act(async () => {
      await result.current.setActive(idA);
    });
    const confirm = result.current.messages.find(
      (m: any) => m.role === "agent-confirm" && m.confirmationId === "c1",
    );
    expect(confirm).toBeDefined();
    // Approve — port should receive the response
    act(() => {
      result.current.resolveConfirm("c1", true);
    });
    expect(portA.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent-confirm-response",
        confirmationId: "c1",
        approved: true,
        sessionId: idA,
      }),
    );
  });
});
```

- [ ] **Step 5: Add Case 5 — Stop only aborts active**

(Spec §5.2 Case 4 — N-path keep-alive — is covered by `keep-alive.concurrent.test.ts` in Task 12. Spec §5.2 Case 6 — panel unmount disconnect-all — is covered by Task 10's "unmount lifecycle" test. Task 13 numbers Cases 1, 2, 3, 5 from the spec list to keep the Cross-spec/plan numbering aligned.)

Append:

```ts
describe("useSession concurrent (#30) — Case 5: Stop scoped to active", () => {
  it("abort() posts chat-abort on active port only", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const portA = lastConnectedPort();
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = lastConnectedPort();
    // Both A and B are streaming (set up via sendMessage on each)
    act(() => {
      result.current.sendMessage({ content: "in B" });
    });
    // Stop while B is active
    act(() => {
      result.current.abort();
    });
    expect(portB.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat-abort" }),
    );
    expect(portA.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat-abort" }),
    );
  });
});
```

- [ ] **Step 6: Verify all cases pass**

Run: `pnpm test src/sidepanel/hooks/useSession/concurrent.test.ts`
Expected: PASS — Cases 1, 2, 3, 5 (per spec §5.2 numbering) green.

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/hooks/useSession/concurrent.test.ts \
        src/sidepanel/hooks/useSession/test-utils.ts \
        src/sidepanel/hooks/useSession/index.test.ts
git commit -m "test(panel): concurrent useSession integration spec cases 1/2/3/5 (#30)"
```

---

## Task 14: Cross-layer regression — agent-done-task wire→DisplayMessage transit

**Files:**
- Create: `src/__tests__/cross-layer/concurrent-task-summary.test.ts`

Per memory `feedback_cross_layer_integration_tests`: any panel-state model change MUST have a wire→DisplayMessage transit regression test. This case validates the full SW emit → port → handler → slot → derived `messages` array path under concurrent sessions.

- [ ] **Step 1: Write the cross-layer test**

Create `src/__tests__/cross-layer/concurrent-task-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSession } from "@/sidepanel/hooks/useSession";
import { lastConnectedPort } from "@/sidepanel/hooks/useSession/test-utils";

/**
 * Cross-layer regression (#30 + memory feedback_cross_layer_integration_tests):
 * verify the agent-done-task wire transit lands at the panel's
 * DisplayMessage[] correctly even when the session is backgrounded at
 * the moment the SW emits.
 *
 * Scope: panel-side simulation of the SW emit using the chrome runtime
 * port mock. We do NOT spin a real SW here — that requires a separate
 * fixture. What we DO assert:
 *   1. The wire payload that SW emits (matching loop.ts emitDone shape)
 *      is consumed by the panel handler and lands in the right slot.
 *   2. After session-switch back, useSession().messages exposes the
 *      agent-summary as the tail entry (derivation correct).
 *   3. The slot's streaming/streamFinished flags are correctly cleared
 *      (downstream UI reads these to swap from spinner → summary).
 *
 * Cite: Phase 5 lesson — "high unit-test count != integration correctness".
 */
describe("cross-layer: concurrent agent-done-task transit (#30)", () => {
  it("SW-emitted agent-done-task on a backgrounded session lands in messages on switch-back", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = lastConnectedPort();

    // User starts a task on A (simulate sendMessage flow)
    act(() => {
      result.current.sendMessage({ content: "do thing" });
    });
    // chat-start was posted with sessionId: idA
    expect(portA.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "chat-start", sessionId: idA }),
    );

    // User switches to a freshly created session B
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });

    // SW emits agent-done-task with the EXACT payload shape produced by
    // loop.ts emitDone (verify against current loop.ts call sites):
    //   { type: "agent-done-task", success, summary, stepCount, sessionId }
    act(() => {
      portA.simulateMessage({
        type: "agent-done-task",
        sessionId: idA,
        success: true,
        summary: "task complete",
        stepCount: 5,
      });
    });

    // Active session is B — its messages should not contain the summary
    expect(
      result.current.messages.some((m: any) => m.role === "agent-summary"),
    ).toBe(false);

    // Switch back to A — derive view from slots
    await act(async () => {
      await result.current.setActive(idA);
    });

    // Wire→DisplayMessage transit: agent-done-task emitted by SW
    // arrives as agent-summary DisplayMessage at the tail of messages.
    const tail = result.current.messages[result.current.messages.length - 1];
    expect(tail).toEqual({
      role: "agent-summary",
      success: true,
      summary: "task complete",
      stepCount: 5,
    });
    expect(result.current.streaming).toBe(false);
    // streamFinished is internal to the slot; verify externally via
    // streaming === false (which derives from streamFinished + manual flips).
  });

  it("SW-emitted agent-confirm-request on a backgrounded session is recoverable", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = lastConnectedPort();

    // Background-emit confirm before any switch
    act(() => {
      portA.simulateMessage({
        type: "agent-confirm-request",
        sessionId: idA,
        confirmationId: "cx",
        tool: "click",
        args: { selector: "#submit" },
        riskReason: "submit-button",
      });
    });

    // Switch away
    await act(async () => {
      await result.current.createAndActivate();
    });
    // Switch back
    await act(async () => {
      await result.current.setActive(idA);
    });

    const card = result.current.messages.find(
      (m: any) => m.role === "agent-confirm" && m.confirmationId === "cx",
    );
    expect(card).toBeDefined();
    expect(card).toMatchObject({ tool: "click", riskReason: "submit-button" });
  });
});
```

- [ ] **Step 2: Verify pass**

Run: `pnpm test src/__tests__/cross-layer/concurrent-task-summary.test.ts`
Expected: PASS — both cases green.

- [ ] **Step 3: Verify the full test suite is green**

Run: `pnpm test`
Expected: ALL PASS — no regressions in the existing 700+ tests.

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/cross-layer/concurrent-task-summary.test.ts
git commit -m "test(cross-layer): concurrent agent-done-task wire transit (#30)"
```

---

## Task 15: Update roadmap + close M3-U6 anchors

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `docs/solutions/2026-05-03-multi-session-invariant-trace.md`

- [ ] **Step 1: Update ROADMAP.md §12 #30 row**

In `docs/ROADMAP.md`, find the §12 row for #30 (P0). Replace its "状态 / 下一步" cell with:

```markdown
✅ **SHIPPED 2026-05-08** — panel state migration to per-session `Map<sessionId, T>` + slots/slotsRef hub + createPortHandlers factory + setActive/createAndActivate simplified + #29 streaming guard removed + SW R13(c) evictOnSetActive removed + SW keep-alive scoped to in-flight tasks. ~14 tasks / cross-layer regression for agent-done-task transit / 700+ tests pass / acceptance AC-1..AC-9 met. Closes §3 / §9 / §10 M3-U6+ anchors. Trace doc → `docs/solutions/2026-05-03-multi-session-invariant-trace.md` §M3-U6 (appended)
```

- [ ] **Step 2: Update §3 Checkpoint & Resume superseded note**

In ROADMAP.md §3, append after the existing Status line:

```markdown
> **§M3-U6 close-out (2026-05-08)**: Panel state per-session migration shipped. M3 series fully complete.
```

- [ ] **Step 3: Update §9 advisory ledger**

In ROADMAP.md §9, prepend at the top:

```markdown
> **2026-05-08 update**: M3-U6 panel concurrent state migration shipped (#30). The advisory items below remain optional maintenance and are not blockers for any roadmap item.
```

- [ ] **Step 4: Update §10 v1.5.1 follow-ups**

In ROADMAP.md §10, append a row in the table OR strike out the existing M3-U6+ anchor. (Read the current §10 to find which form is appropriate.)

- [ ] **Step 5: Update §12 推荐推进顺序 #7**

Find item 7 in 推荐推进顺序 and replace with:

```markdown
7. **并发会话支持（§12 #30, P0）** — ✅ **SHIPPED 2026-05-08** as #30: per-session `Map<sessionId, T>` panel state + createPortHandlers factory + SW R13(c) removal + keep-alive scoped to in-flight tasks. Unblocks #34 (P1).
```

- [ ] **Step 6: Append §M3-U6 to invariant trace doc**

In `docs/solutions/2026-05-03-multi-session-invariant-trace.md`, append a new section at the end:

```markdown
## §M3-U6 — Panel concurrent state migration (2026-05-08)

Closes the M3-U6+ anchor referenced throughout this trace. Spec → `docs/specs/2026-05-08-concurrent-sessions-design.md`. PR → (TBD on merge).

**Shipped invariants**:
- Panel `useSession` is split into `useSession/{index, runtime-map, port-handlers}.ts` directory module
- All per-task runtime state (streaming/streamingText/error/toast/messages/accumulated/streamFinished) lives in `Map<sessionId, SessionRuntimeSlot>`; the active-session view is derived via `deriveActiveView(slots, sessionId)`
- `portsRef: Map<sessionId, Port>`; `setActive` / `createAndActivate` no longer disconnect prior ports
- `#29 streamingRef.current` guard removed in `createAndActivate` and `setActive`
- Single-instance `handleMessage` listener routes by `message.sessionId`; per-port `makeDisconnectHandler` flushes partial text scoped to its session
- `setActive` does NOT auto-create a port for paused / archived sessions (Resume flow owns connection)
- panel unmount disconnects every port in `portsRef` — `transitionPortInFlightSessionsToPaused` invariant preserved per port

**SW-side delta**:
- `R13(c) evictOnSetActive(portSessionId)` removed from `chrome.runtime.onConnect` closure (still exported from image-cache.ts)
- `keepAliveInterval` replaced by `createKeepAlive({ tick, inFlight })` controller; ensure() at chat-start / resume-task; maybeStop() at task terminal state via `try/finally` in handleChatStream / handleResumeRequest; stop() at port.onDisconnect

**Acceptance**:
- AC-1..AC-9 from spec all green
- Cross-layer regression `concurrent-task-summary.test.ts` ensures wire→DisplayMessage transit even on backgrounded sessions
- 700+ existing tests preserved (single-session behavior unchanged)
```

Replace the `(TBD on merge)` PR placeholder once a PR number is assigned.

- [ ] **Step 7: Commit**

```bash
git add docs/ROADMAP.md docs/solutions/2026-05-03-multi-session-invariant-trace.md
git commit -m "docs: close M3-U6 anchors and trace concurrent sessions ship (#30)"
```

---

## Task 16: Final validation + acceptance gate

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
```
Expected: ALL PASS — 700+ tests including new concurrent + cross-layer additions.

- [ ] **Step 2: Run build**

```bash
pnpm build
```
Expected: clean build.

- [ ] **Step 3: Walk the acceptance gate**

For each AC in spec §5.4, confirm the corresponding test passed in Step 1:

| AC | Verification location |
|----|----------------------|
| AC-1: A done after switch, summary visible on switch-back | `concurrent.test.ts` Case 2 + `concurrent-task-summary.test.ts` |
| AC-2: A confirm survives switch + remains approvable | `concurrent.test.ts` Case 3 + `concurrent-task-summary.test.ts` |
| AC-3: Stop only aborts active | `concurrent.test.ts` Case 4 |
| AC-4: panel close → all in-flight transition to paused | `index.test.ts` "unmount lifecycle" |
| AC-5: image-cache cross-eviction protection | `image-cache.concurrent.test.ts` |
| AC-6: keep-alive cleared after all tasks done | `keep-alive.concurrent.test.ts` |
| AC-7: verifyPortSession + pendingConfirmationsBySession unchanged | sanity smoke (existing tests preserved) |
| AC-8: existing useSession.test.ts green | Step 1 above |
| AC-9: pnpm build clean | Step 2 above |

- [ ] **Step 4: Manual smoke (browser)**

Per CLAUDE.md ("test the golden path and edge cases for the feature"):

1. `pnpm dev`
2. Load unpacked `dist/` in chrome://extensions
3. Open the side panel
4. Start a long-running task on session A (e.g. a web research skill)
5. Click `+` to create session B mid-stream → expect: B opens, no toast refusal
6. Send a message on B → expect: B's task starts independently
7. Switch back to A via drawer → expect: A's progress UI matches its actual state (streaming spinner, agent-step rows updating)
8. Wait for A to finish → switch back → expect: agent-summary card present
9. Open multiple windows / multiple panels → expect: independent operation, no cross-bleed
10. Close panel mid-task → reopen → expect: in-flight session paused, R10 resume affordance present

Document smoke results in the final commit message.

- [ ] **Step 5: Final commit (release notes draft)**

If a release-notes file is the project convention (per `docs/release-notes/`), draft an entry:

```bash
# (Read existing docs/release-notes/ files first to match the format,
# then create a new file or append to a v0.7.0 / v0.6.x entry as appropriate.)
```

Create `docs/release-notes/<next-version>.md` matching the existing format. Body:

```markdown
## 并发会话支持

- 多个 session 现在真正并发执行：A 在跑任务时点 + 新建 B 不会中断 A
- 切换 session 不再 disconnect 后台 port，A 的 chat-chunk / agent-step / done 在背景继续累积
- 切回 A 时 UI 立即反映其当前状态（streaming / 进度 / done summary）
- Stop 按钮仅 abort 当前 active session 的 task，其他 session 不受影响

## 资源管理优化

- SW image cache 不再因 session 切换而误清——多 session 各自管理 30MB / last-3-turn LRU
- SW keep-alive interval 仅在 task in-flight 时运行；空闲后 SW 自然 idle out

## Issues closed

- #30 (P0): 并发会话支持
```

```bash
git add docs/release-notes/<next-version>.md
git commit -m "docs(release): concurrent sessions changelog (#30)"
```

---

## Self-Review Outcome

**Spec coverage:** ✅
- §1.1 改造覆盖 → Tasks 1–10 + 11–12
- §1.2 不变量保留 → preserved by Tasks 4–9 design + verified by existing tests
- §1.3 决策点对应表 → Tasks 7–8 (port lifecycle) + Tasks 11–12 (SW)
- §2.1 文件树 → Tasks 1–3
- §2.2 runtime-map.ts → Task 1
- §2.3 port-handlers.ts → Tasks 2 + 2a–2g
- §2.4 useSession/index.ts → Tasks 3, 4, 7, 8, 9, 9b, 10
- §2.5 connectPortFor → Task 6
- §3.1 onChanged listener → Task 9 step 3
- §3.2 archived guard → unchanged (Task 6's persistMessagesById preserves the early-return)
- §3.3 unmount cleanup → Task 10
- §3.4 paused/archived no auto-port → Task 7 step 3
- §3.5 Stop scoped to active → Task 9 step 3 + Task 13 case 4
- §3.6 useRecording → unchanged (no task; verified by existing tests)
- §3.7 background confirm notification → Task 13 case 3 (mechanism is the existing storage onChanged path; no new code)
- §3.8 lastAccessedAt drift → no task; accepted
- §4.1 R13(c) removal → Task 11
- §4.2 keep-alive scoping → Task 12
- §4.3 不动的 SW 端 → preserved by absence of edits
- §5.1 existing tests preserved → Tasks 4, 6, 9 each verify
- §5.2 concurrent.test.ts → Task 13 (cases 1–4 — note: spec §5.2 lists 6 cases; the 6th [N-path keep-alive cleared] is covered in Task 12's keep-alive.concurrent.test.ts; the 4th [keep-alive interval clear] is covered there too. Task 13 covers cases 1–4; cases 5+ are in Tasks 10 + 12)
- §5.3 cross-layer test → Task 14
- §5.4 acceptance gate AC-1..AC-9 → Task 16 step 3 walks through each
- §5.5 build-time invariants → Task 16 step 2

**Placeholder scan:** ✅ — every step has actual code or commands. Two TBDs flagged:
- Task 15 step 6 references `(TBD on merge)` PR number — this is intentional; PR# is unknown until PR creation. Replace at merge time.
- Task 16 step 5 references `<next-version>.md` — this is intentional; pick the version number when running this task (per project release cadence).

**Type consistency:** ✅
- `SessionRuntimeSlot` defined Task 1, used identically in Tasks 2, 2a–2g, 4–10
- `KeepAlive` interface defined Task 12 step 3, used in Task 12 step 6 signature changes
- `createPortHandlers` signature stable across Tasks 2, 2a–2g, 6
- `patchSlot` helper signature consistent in Tasks 4 + every subsequent task that calls it

---

**Plan complete.** Estimated 16 tasks, ~80 steps, 4 commits per task on average. Single PR scope (no multi-PR dependency chain). Ready for executing-plans or subagent-driven-development handoff.
