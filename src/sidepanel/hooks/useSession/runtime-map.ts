import type { DisplayMessage, Quote } from "@/types";
import type { SessionAgentState } from "@/lib/sessions/types";

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
  /** Issue #38 v1 — per-session page content references (not persisted). */
  quotes: Quote[];
  /** Issue #59 — most recent contextUsage snapshot, sourced from
   *  agent-usage wire events (mid-task) or getSessionAgent on session
   *  switch (mount/setActive). undefined when no LLM call has returned
   *  yet for this session — the composer hides the ring in that state. */
  usage?: SessionAgentState["contextUsage"];
  /** Issue #34 — broadcast snapshot of SW pendingInstructions for this session.
   *  Keyed by chatMessageId for O(1) lookup in chat-bubble render. */
  pendingByChatMessageId: Map<string, { createdAt: number }>;
};

export const EMPTY_SLOT: SessionRuntimeSlot = {
  streaming: false,
  streamingText: "",
  error: null,
  toast: null,
  messages: [],
  accumulated: "",
  streamFinished: true,
  quotes: [],
  pendingByChatMessageId: new Map(),
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
