import type { DisplayMessage, Quote } from "@/types";
import type { AgentMessage } from "@/lib/model-router";
import type { Attachment } from "@/lib/images";

/**
 * Session lifecycle status (M1-U1 ships the full enum even though M1 only
 * uses `active` and `failed` actively — `paused` is wired by M1-U5 and
 * `archived` by M2-U4. Shipping the full enum up front avoids type
 * migrations later.)
 *
 * State machine (per plan):
 *   active → failed              (task error / cross-origin abort)
 *   active → paused              (SW restart, no pending confirm — M1-U5)
 *   paused → active              (user clicks 'Resume task', drift OK)
 *   paused → failed              (user clicks 'Discard' on R11 drift card)
 *   {active|failed|paused} → archived  (LRU eviction or soft delete — M2-U4)
 *   archived → active            (user manually unarchives, ≤30d window)
 *
 * `done` is intentionally omitted — task completion does not change the
 * session-level status; sessions retain a "done" task as part of their
 * agent-message history while staying `active`.
 */
export type SessionStatus = "active" | "paused" | "failed" | "archived";

/**
 * Pending confirm record persisted to `session_${id}_agent.pendingConfirm`
 * while the SW is alive. Two carve-out invariants apply:
 *
 *   1. **SW-alive only** — the resolver lives in SW memory; on SW restart
 *      this record is meaningless. M1-U5's `R10(session-resume)` cold-start
 *      gate scans and clears all `pendingConfirm` fields *before* any other
 *      recovery work, then marks the session as `failed`. So this field
 *      should never be observed across SW lifetimes.
 *
 *   2. **Raw payload at-rest** — the confirm card needs un-redacted args to
 *      let the user make an informed decision (Phase 2.5 binary-channel
 *      invariant: confirm shows raw, panel-step display redacts). The raw
 *      lives in storage for the duration of the pending confirm so that
 *      panel re-mount can re-render the card; on resolve (approve/reject)
 *      the SW immediately scrubs this field.
 *
 * `kind` is the discriminator for the M1-U4 `SessionConfirmRequestMessage`
 * variant family. M1-U1 only declares the placeholder shape — `payload` is
 * `unknown` until M1-U4 fills in concrete shapes per kind.
 */
export interface PendingConfirmRecord {
  confirmationId: string;
  kind: "agent-tool" | "pinned-tab-drift" | "paused-resume" | "agent-origin-change";
  payload: unknown;
}

/**
 * Display-side metadata for one session, plus the panel-rendered chat
 * history. Persisted at `session_${id}_meta`. Split from
 * `SessionAgentState` (D2) so that:
 *   - panel can read meta without pulling the (potentially large)
 *     agent-message history into the side panel bundle's hot path
 *   - SW agent loop can write `session_${id}_agent` per step without
 *     racing the panel's meta writes
 *
 * `messages` is the full DisplayMessage history shown to the user. The SW
 * appends to this on `chat-done` boundaries (not mid-stream — see plan
 * M1-U2 "Approach"). Streaming text stays in component-local React state
 * and is allowed to be lost on sub-view switch.
 */
export interface SessionMeta {
  /** crypto.randomUUID() — no `default` magic value, no prefix (PRD-3 fix). */
  id: string;
  /** Set once at createSession time; never mutated. */
  createdAt: number;
  /**
   * Updated on three triggers (M2-U1 wires all three):
   *   - user activates this session in the drawer
   *   - SW receives a new chat-start for this session
   *   - agent loop completes a step and writes a snapshot
   */
  lastAccessedAt: number;
  status: SessionStatus;
  /** LLM-generated short title (M2-U3). Falls back to first-message prefix
   *  when LLM call fails or is in flight. */
  title?: string;
  /**
   * v1.5 multi-pin (Path A) — array of pinned tabs owned by this session.
   *
   * Lifecycle invariants:
   *   - pinMode='auto'  → empty / undefined
   *   - pinMode='task'  → pinnedTabs[0] = chat-start capture; pinnedTabs[1..N]
   *                       = open_url-created tabs in chronological order
   *   - pinMode='user'  → ≥1 entries; user-toggled via PinnedTabDropdown.
   *
   * Replaces pre-v1.5 single-pin fields (removed in Task 10).
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  /**
   * M5 — Pin mode state machine. Optional for backwards compatibility with
   * pre-M5 sessions; `getEffectivePinMode` in `pin-state.ts` infers the
   * mode when this is undefined.
   *
   *  - `auto`: pin is not persisted; UI live-previews the active tab. R7
   *    cross-session registry skips this session (other sessions can freely
   *    operate on its prior tab). Default for new + post-task sessions.
   *  - `task`: pin frozen to the tab/origin captured at chat-start. SW
   *    transitions auto→task during chat-start; emitDone transitions
   *    task→auto and clears pinnedTabs[]. R7 registry includes this.
   *  - `user`: user explicitly picked a tab via the PinnedTabDropdown.
   *    Survives task end. R7 registry includes this. Drift check skipped
   *    (user intent is fixed; if origin changes, that's the user's call).
   */
  pinMode?: "auto" | "task" | "user";
  /** Set when the session is moved to archived storage. M2-U4 also reads
   *  this to drive the 30-day hard-delete sweep. Absence = not archived. */
  archivedAt?: number;
  /** Panel-rendered chat history. The SW writes the full array on
   *  chat-done boundaries (M1-U2); panel reads it on mount and re-renders
   *  on storage onChanged. */
  messages: DisplayMessage[];
  /**
   * Per-session instance override (Q6 = Y). Set at session creation by
   * reading active_instance_id; can be changed by the user via the
   * InstanceSelector chip in the composer until the first task starts.
   * Once a task starts, the resolved ModelConfig is snapshotted into the
   * checkpoint (C1 invariant) and instance changes mid-task are ignored.
   *
   * Pre-migration sessions (before V2) lack this field; lazy backfill
   * happens in getSessionMeta when migration_v2_mapping is present.
   */
  instanceId?: string;
  /**
   * 本会话选中的 model（与 instanceId 配对）。Composer 选模型时写入。
   * 缺省（老 session / 仅 instanceId）→ 由 model-selection-resolver 按
   * provider 第一个 registry model 兜底（D3）。task start 时 (instanceId,
   * model) snapshot 进 checkpoint（C1 不变量）。
   */
  model?: string;
  /**
   * Schedule-originated sessions carry these three fields so that run
   * history links back to the owning ScheduleRecord / ScheduleRunRecord.
   *
   * `origin: "schedule"` is the discriminator; the other two carry the
   * IDs needed for cross-referencing. All three are absent on ordinary
   * user-initiated sessions (backward compatible: undefined = normal).
   */
  origin?: "schedule";
  /** scheduleId of the owning ScheduleRecord (sched_<uuid>). */
  scheduleId?: string;
  /** recordId of the ScheduleRunRecord that spawned this session (run_<uuid>). */
  recordId?: string;
}

/**
 * Per-session **in-flight** agent runtime state, persisted at
 * `session_${id}_agent`. This is the LLM-facing IR — the panel does not
 * import this type to render chat (that's `SessionMeta.messages`), it
 * only reads it when the user clicks 'Resume task' on a paused session
 * (M1-U5).
 *
 * **Lifecycle (M1-U3 v2)**: this carries the **current in-flight task**'s
 * IR, NOT a cross-task accumulation. Each new `runAgentLoop` invocation
 * starts a fresh `[system, user(task)]` history; persisted snapshots
 * track that single task only. On task done (success / fail / abort /
 * max-steps), the loop writes a "tombstone" snapshot
 * (`agentMessages=[], stepIndex=0`) so a subsequent SW restart can't
 * mistake leftover state for an in-flight task — see
 * `buildSessionAgentTombstone` in `loop.ts`.
 *
 * Cross-task **display** history (what the user sees in the chat
 * scrollback) lives separately in `SessionMeta.messages`.
 *
 * `agentMessages` retains raw tool args; redaction is a panel-display
 * concern only (R28 v2 reinterpretation, see plan D7 / M1-U3). Resume
 * needs the raw values to give the LLM enough context to plan the next
 * step.
 */
export interface SessionAgentState {
  /** LLM-side conversation for the **current in-flight task**, including
   *  tool_use / tool_result blocks. Empty when no task is in flight
   *  (tombstone state). NOT a cross-task accumulation — see JSDoc. */
  agentMessages: AgentMessage[];
  /**
   * Issue #34 — per-session FIFO queue of mid-task instructions submitted
   * during streaming. Drained atomically at the top of each ReAct iteration
   * (and at chat-start handler entry, to consume any pending left over from
   * a prior abort). SW is the sole writer.
   */
  pendingInstructions: PendingInstruction[];
  /** Monotonic counter — number of completed agent steps in the current
   *  in-flight task. 0 = no in-flight task (tombstone). M1-U5 cold-start
   *  uses `stepIndex > 0` to detect in-flight tasks that need to be
   *  transitioned to `paused` after SW restart. */
  stepIndex: number;
  /**
   * R14 — set true the first time an image ContentBlock is added to
   * `agentMessages`. Persisted across SW restart so `detectAndMarkPaused`
   * can transition image-bearing in-flight sessions to `failed` (image
   * bytes not in storage; resume would feed an LLM context with cache-miss
   * text markers, breaking the "look at the image" task semantics).
   *
   * Lifecycle (Phase 5):
   *   - Task 1 (this PR): field exists, defaults to false everywhere
   *   - Task 11 (later): loop.ts sets to true when (a) ChatStartMessage carries
   *     image attachments OR (b) a screenshot tool result is appended; Task 11
   *     also threads the prior flag through buildSessionAgentSnapshot
   *     (loop.ts:601) so the value survives step-boundary writes
   *   - R14: detectAndMarkPaused reads this flag at SW startup; in-flight
   *     sessions with hasImageContent=true transition to `failed` (not
   *     `paused`), because storage carries no image bytes and resume would
   *     feed an LLM context with cache-miss text markers
   *
   * Idempotent — once true within a session's lifetime, stays true.
   */
  hasImageContent: boolean;
  /** Set while a confirm is awaiting user response. Cleared synchronously
   *  on resolve. M1-U5 cold-start sweep unconditionally clears this on
   *  SW startup before any other recovery work. */
  pendingConfirm?: PendingConfirmRecord | null;
  /**
   * v1.5 — task-scoped pointer to the currently-focused tab among
   * `SessionMeta.pinnedTabs[]`. Snapshot is taken on this tab each
   * iteration. Mutated by `focus_tab` tool; reset to pinnedTabs[0].tabId
   * at chat-start; cleared at task end (via tombstone).
   */
  currentFocusTabId?: number;
  /**
   * Progressive tool disclosure — the monotonic set of active DisclosureGroups
   * for the in-flight task (always includes "core"). Seeded at task start from
   * env signals + the progressiveToolDisclosure flag; grown by env detection
   * and load_tools. Persisted so a SW-restart resume restores lazily-loaded
   * groups (env groups re-light from signals regardless). Written via the
   * spread-existing-first merge path (like currentFocusTabId), not the bare
   * snapshot.
   */
  activeToolGroups?: string[];
  /**
   * U3 (Half B SW-side synth) — synthesized assistant turn from the last
   * completed agent task. Moved from `SessionMeta` to `SessionAgentState`
   * (AD1 fix) so both writers to this key are SW-only: `emitDone` sets it
   * (folded into the tombstone write) and `handleChatStream` reads + clears
   * it at chat-start. This eliminates the lost-update race with the panel's
   * `persistMessages` which also writes `session_${id}_meta`.
   *
   * SW-only path; one-time consumption (set at emitDone, cleared at next
   * chat-start). Already wrapped in
   * `<untrusted_prior_task_summary>…</untrusted_prior_task_summary>`.
   * Not present (undefined) when no agent task has completed since the
   * last chat-start, or when the prior round was a pure-text reply.
   */
  lastTaskSynth?: string;
  /**
   * Issue #59 — per-session token usage. SW single-writer (loop.ts done
   * branch RMW). Tombstone carries over via `buildSessionAgentTombstone`,
   * so totals survive across tasks. Absent on old sessions / sessions
   * whose first LLM call hasn't returned yet — panel treats absence as
   * "don't render ring".
   */
  contextUsage?: {
    /** Cross-task cumulative input tokens across all LLM calls in this session. */
    totalInputTokens: number;
    /** Cross-task cumulative output tokens. */
    totalOutputTokens: number;
    /** Most recent step's real input usage. Numerator for ring percentage. */
    lastInputTokens: number;
    /** Most recent step's real output usage. Shown in popover total row. */
    lastOutputTokens: number;
  };
}

/**
 * Issue #34 — single entry in the per-session mid-task instruction queue.
 * Panel-generated `chatMessageId` (ulid) is the link key to `DisplayMessage.id`.
 * SW stores the full payload (not just an index) because drain happens entirely
 * inside SW (loop top) and cannot depend on panel echo.
 */
export interface PendingInstruction {
  /** ulid generated by panel; matches DisplayMessage.id. */
  chatMessageId: string;
  /** Raw user text. */
  content: string;
  /** Slash-expanded LLM-facing text (if panel expanded skills syntax). Prefer this
   *  over `content` when building the drained user message. */
  expandedForLLM?: string;
  /** Image attachments staged at send time (rare during streaming since ToolsMenu
   *  is hidden, but supported for symmetry with sendMessage). */
  attachments?: Attachment[];
  /** Quote chips. */
  quotes?: Quote[];
  /** Unix ms — used only for ordering in drain merge. */
  createdAt: number;
}

/**
 * Lightweight summary of a session, persisted in the single
 * `session_index` key. Avoids `chrome.storage.local.get(null)` full-scan
 * for the drawer (D1).
 *
 * Sort order: returned by `listSessionIndex` is `lastAccessedAt` desc.
 *
 * `pinnedOrigin` is intentionally NOT here — write traffic on
 * lastAccessedAt is high enough that we don't want to also write the
 * origin string on every access; consumers that need pinnedOrigin
 * (close_tabs cross-session check via plan D9) read from the per-session
 * meta. `pinnedTabIds[]` carries the cross-session R7 lock set.
 */
export interface SessionIndexEntry {
  id: string;
  lastAccessedAt: number;
  status: SessionStatus;
  title?: string;
  /**
   * v1.5 multi-pin — flat list of pinned tab ids for cross-session R7 lock
   * lookup.
   */
  pinnedTabIds?: number[];
  /**
   * Number of DisplayMessages persisted to the session. Used by the
   * sidepanel to hide empty active sessions from the SessionDrawer
   * (a freshly-created session that the user hasn't sent a message to
   * shouldn't clutter the list). Optional for backwards compatibility
   * with index entries written before this field existed — readers
   * should treat `undefined` as "unknown, assume non-empty for safety"
   * so we never accidentally hide a real session.
   */
  messageCount?: number;
  /**
   * Mirrors `SessionMeta.origin`. Schedule-originated sessions (`"schedule"`)
   * are managed from the Schedules page (opened via a run-history row) and are
   * deliberately hidden from the SessionDrawer, so the drawer filter needs the
   * discriminator at the index level without loading every meta. Absent for
   * ordinary user sessions.
   */
  origin?: "schedule";
}
