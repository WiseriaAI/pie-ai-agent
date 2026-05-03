import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/model-router";
import type { DisplayMessage, PortMessageToPanel } from "@/types";
import {
  createSession,
  getSessionMeta,
  listSessionIndex,
  setSessionMeta,
  updateLastAccessed,
} from "@/lib/sessions/storage";
import { hardDeleteSession } from "@/lib/sessions/lifecycle";
import type { SessionStatus } from "@/lib/sessions/types";
import { deriveTitleFromMessages } from "@/lib/sessions/title";

/**
 * useSession — single-source-of-truth for the active session's messages,
 * port connection, and streaming state. Lives at App level so the port
 * and onMessage listener survive across Chat ↔ Settings sub-view swaps;
 * if Chat owned them, switching to Settings would unmount Chat, detach
 * the listener, and silently drop SW-pushed chunks.
 *
 * **M1 single-session mode** — the hook auto-creates one session if the
 * index is empty and otherwise picks the most-recently-accessed entry.
 * M2-U1 will introduce an explicit `activeSessionId` parameter and
 * multi-session UI; until then `sessionId` is implicit.
 *
 * **M1-U4 — mount-immediate connection.** The port is opened on hook
 * mount, not on first sendMessage. Reasons:
 *   - R4 informed-approval: the SW may have a pending agent-confirm
 *     request that the user closed the panel during. Opening the port
 *     immediately + sending `panel-mounted` lets the SW re-emit it so
 *     the panel re-renders the card without the user having to type.
 *   - the listener is attached once at mount and survives every
 *     subsequent stream (no re-attach per sendMessage), eliminating an
 *     entire class of "listener attached after first chunk" race.
 *
 * Persistence boundaries (avoid mid-stream storage churn):
 *   - chat-done       → assistant message + persist
 *   - chat-error      → record error + persist
 *   - agent-done-task → final summary + persist
 *   - onDisconnect    → flush partial text + persist (SW death recovery)
 *   - clearMessages() → empty array + persist
 *
 * NOT persisted:
 *   - chat-chunk      → React state only
 *   - agent-step      → React state only (M1-U3 hooks the SW-side
 *                       snapshot for agent IR; this is the panel-side
 *                       DisplayMessage stream)
 *   - agent-confirm   → React state only (M1-U4 introduces persisted
 *                       pendingConfirm via SessionAgentState — but
 *                       the storage write happens on the SW side)
 */

// deriveTitleFromMessages is imported from @/lib/sessions/title (lifted in M2-U3
// so the SW side can share the same sentinel string for the LLM title race guard).
// The DisplayMessage type satisfies TitleableMessage (has role + content fields).

/**
 * Schemes the agent loop refuses to operate on (mirrors `isRestrictedUrl`
 * in lib/agent/loop.ts). Kept inline here to avoid a panel→agent-runtime
 * import; if these two lists ever diverge the loop will hard-stop the
 * task on iteration 1 with "restricted URL" — but the panel UI would
 * have shown the session as pinnable, which is confusing. Easier to
 * filter at capture time so a restricted-URL session never gets a pin.
 */
const RESTRICTED_PIN_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "file://",
  "data:",
  "javascript:",
  "blob:",
];

/**
 * M3-U2 — capture the user's currently-active tab + its origin so a new
 * session can anchor to it at creation time. Returns null when the
 * active tab can't be resolved (no window focused, restricted URL, etc.) —
 * the loop's first-iteration origin check would handle a slipped pin
 * defensively, but filtering here keeps the panel UX honest: a session
 * that displays as pinned should actually be runnable.
 *
 * Filters two layers:
 *   1. URL prefix list (chrome://, file://, blob:, etc.) — same as the
 *      loop's isRestrictedUrl. blob:https://example.com/abc parses to a
 *      non-"null" origin, so the prefix check (not origin equality) is
 *      what stops the pin from sneaking through.
 *   2. URL.origin === "null" — opaque-origin schemes the URL spec gives up on.
 */
async function captureActivePinned(): Promise<
  { pinnedTabId: number; pinnedOrigin: string } | null
> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;
    // Chrome can return tab.id === -1 for session-restore / detached tabs.
    // The truthy check above lets that slip through (-1 is truthy). If we
    // persisted it, a downstream chrome.tabs.get(-1) would synchronously
    // throw "Value must be at least 0" and crash the agent loop. Filter
    // explicitly: only pin to a real, addressable tab.
    if (!Number.isInteger(tab.id) || tab.id < 0) return null;
    if (RESTRICTED_PIN_PREFIXES.some((p) => tab.url!.startsWith(p))) return null;
    const origin = new URL(tab.url).origin;
    if (!origin || origin === "null") return null;
    return { pinnedTabId: tab.id, pinnedOrigin: origin };
  } catch {
    return null;
  }
}

interface SendMessageInput {
  /** What the user typed — rendered in the chat. */
  content: string;
  /** Slash-command expansion sent to the LLM in place of `content`. The
   *  user-facing message keeps the slash form. */
  expandedForLLM?: string;
}

export interface UseSession {
  sessionId: string | null;
  /** False until the initial storage read finishes. Consumers should
   *  disable input until this flips true to avoid the user racing the
   *  bootstrap and overwriting persisted history with an empty array. */
  ready: boolean;
  /** M1-U5 — current session status. App uses `paused` to surface the
   *  'Resume task' affordance. Updated via storage onChanged so a SW
   *  cold-start mark transitions the UI without panel reload. */
  status: SessionStatus | null;
  /** M3-U2 (post-acceptance) — persisted pinned-tab origin from the
   *  active session's meta, or null when the session has no pin yet
   *  (brand-new empty session). Chat reads this to decide whether to
   *  display a frozen pin (messages.length > 0 → locked) or a live
   *  preview of the user's currently-active tab (empty session → free).
   *  Updated on bootstrap, setActive, and chrome.storage onChanged for
   *  the active session's meta key. */
  pinnedOrigin: string | null;
  messages: DisplayMessage[];
  streaming: boolean;
  streamingText: string;
  error: string | null;
  /** M2-U2 — transient toast from the SW (e.g. SEC-PLAN-009 flood warn).
   *  Rendered by Chat as a dismissable banner. Not persisted. */
  toast: { level: "warn" | "error" | "info"; text: string } | null;
  sendMessage: (input: SendMessageInput) => void;
  /** Sends a chat-abort message to the SW. Caller is responsible for
   *  guarding against rapid-fire aborts. */
  abort: () => void;
  /** Resolves a pending agent-confirm card. Posts the response to the
   *  SW and marks the corresponding message as resolved in React
   *  state. */
  resolveConfirm: (confirmationId: string, approved: boolean) => void;
  /** M1-U5 — user clicks 'Resume task' on a paused session. SW
   *  decides whether to drift-card or restart the loop. */
  resumeTask: () => void;
  /** M1-U5 — user clicks 'Discard task' on the R11 drift card. */
  discardTask: (confirmationId: string) => void;
  /** Clears the message history both in React state and in storage. */
  clearMessages: () => Promise<void>;
  /** Allows Chat to dismiss the error banner without re-sending. */
  clearError: () => void;
  /** Dismiss the SEC-PLAN-009 toast. */
  clearToast: () => void;
  /**
   * M2-U2 — switch the active session. Loads the session's persisted
   * messages, bumps lastAccessedAt, and sends a panel-mounted handshake
   * on the existing port. Refuses if `streaming === true` (no abort
   * mid-stream; user must Stop first). Returns the new sessionId or null
   * if the switch was refused.
   */
  setActive: (id: string) => Promise<string | null>;
  /**
   * M2-U2 — create a new session and make it active. Returns the new
   * session's id, or null if refused because streaming is in progress
   * (P0-1 guard — mirror of setActive).
   */
  createAndActivate: () => Promise<string | null>;
}

export function useSession(): UseSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [pinnedOrigin, setPinnedOriginState] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ level: "warn" | "error" | "info"; text: string } | null>(null);
  const [ready, setReady] = useState(false);

  // Persistent port across the whole hook lifetime (mount → unmount).
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // Mirrors of state for use inside the persistent port listener
  // (which is attached once at mount and can't depend on stale state
  // closure).
  const sessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  // Bug-fix-A — mirror of streaming state. MUST be written SYNCHRONOUSLY
  // (alongside every setStreaming call) rather than via a useEffect
  // committed-state hook, because the storage onChanged listener can fire
  // **before the next React commit** when the SW writes meta in response
  // to chat-start (handleChatStream's fire-and-forget updateLastAccessed
  // round-trips a stale meta with the prior persisted messages — if the
  // listener observes streamingRef=false in this window, it would adopt
  // newMeta.messages and overwrite the just-pushed user message).
  // The useEffect below is kept as a backstop only; the source of truth
  // for streamingRef is the manual sync in every setStreaming caller.
  const streamingRef = useRef<boolean>(false);
  // Per-stream scratch — reset by sendMessage, mutated by the
  // persistent listener.
  const accumulatedRef = useRef<string>("");
  const streamFinishedRef = useRef<boolean>(true);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    // Backstop only — production callers sync streamingRef synchronously
    // before each setStreaming call (see Bug-fix-A above).
    streamingRef.current = streaming;
  }, [streaming]);

  // ── Persist helper ─────────────────────────────────────────────────
  // Writes the in-memory messages array to session_${id}_meta. Only
  // called at done boundaries (chat-done / chat-error / agent-done-task)
  // to avoid storage churn during streaming.
  //
  // Bug-fix-C — also fills SessionMeta.title with the first user message's
  // prefix when no title exists yet. This is the documented fallback path
  // for SessionMeta.title (see types.ts JSDoc). The full M2-U3 LLM-generated
  // title will overwrite this once implemented; until then this gives the
  // top bar + drawer something better than "New Session" / "Untitled".
  // setSessionMeta atomically updates the index when title changes (D9),
  // so App.tsx's listSessionIndex() observer fires on the same write.
  const persistMessages = useCallback(
    async (next: DisplayMessage[]) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const current = await getSessionMeta(id);
      if (!current) return;
      // Defense-in-depth: if the session was archived between the panel's
      // last in-memory snapshot and now (LRU eviction during a streaming
      // task), do NOT resurrect the meta key — it would leave the session
      // in BOTH the active meta bucket and the archived bucket, confusing
      // every downstream reader (SessionDrawer, listSessionIndex, the next
      // archive call's idempotency check).
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

  // ── Persistent port listener ───────────────────────────────────────
  // Attached once at mount; handles every SW push for the lifetime of
  // the hook. Per-stream variables (`accumulated`, `streamFinished`)
  // live in refs so this single listener instance can be reused across
  // many sendMessage calls.
  const handlePortMessage = useCallback(
    (message: PortMessageToPanel) => {
      // M2-U2 P1-11 — session routing filter. Every SW→panel message now
      // carries sessionId. Drop messages that belong to a session the user
      // has navigated away from (e.g. user opened a new session mid-stream).
      // This guard must appear BEFORE any state mutation so a wrong-session
      // agent-confirm-request can never render into the current session's UI.
      if (message.sessionId !== sessionIdRef.current) {
        return;
      }
      if (message.type === "chat-chunk") {
        accumulatedRef.current += message.text;
        setStreamingText(accumulatedRef.current);
      } else if (message.type === "chat-done") {
        streamFinishedRef.current = true;
        let next = messagesRef.current;
        if (accumulatedRef.current.trim()) {
          next = [
            ...next,
            { role: "assistant", content: accumulatedRef.current },
          ];
          setMessages(next);
          messagesRef.current = next;
        }
        accumulatedRef.current = "";
        setStreamingText("");
        streamingRef.current = false;
        setStreaming(false);
        void persistMessages(next);
      } else if (message.type === "chat-error") {
        streamFinishedRef.current = true;
        setError(message.error);
        let next = messagesRef.current;
        if (accumulatedRef.current.trim()) {
          next = [
            ...next,
            { role: "assistant", content: accumulatedRef.current },
          ];
          setMessages(next);
          messagesRef.current = next;
        }
        accumulatedRef.current = "";
        setStreamingText("");
        streamingRef.current = false;
        setStreaming(false);
        void persistMessages(next);
      } else if (message.type === "agent-step") {
        if (accumulatedRef.current.trim()) {
          const flushed = accumulatedRef.current;
          setMessages((prev) => {
            const next = [
              ...prev,
              { role: "assistant" as const, content: flushed },
            ];
            // Bug-fix-A — keep messagesRef in lock-step with the React
            // commit so the second setMessages updater below + any concurrent
            // metaKey listener invocation both see the flushed assistant
            // text instead of a stale (pre-flush) snapshot.
            messagesRef.current = next;
            return next;
          });
          accumulatedRef.current = "";
          setStreamingText("");
        }
        const {
          stepIndex,
          tool,
          args,
          resolvedElement,
          status,
          observation,
        } = message;
        setMessages((prev) => {
          // Update existing step bubble in place if same (stepIndex,
          // tool) is already at the tail — avoids duplicate rows
          // when SW emits status=pending then status=ok.
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i]!;
            if (m.role !== "agent-step" && m.role !== "agent-confirm")
              break;
            if (
              m.role === "agent-step" &&
              m.stepIndex === stepIndex &&
              m.tool === tool
            ) {
              const next = [...prev];
              next[i] = {
                role: "agent-step",
                stepIndex,
                tool,
                args,
                resolvedElement,
                status,
                observation,
              };
              return next;
            }
          }
          return [
            ...prev,
            {
              role: "agent-step",
              stepIndex,
              tool,
              args,
              resolvedElement,
              status,
              observation,
            },
          ];
        });
      } else if (message.type === "agent-confirm-request") {
        // M1-U4 — covers both first-time emit AND R4 re-emit on
        // panel-mounted. The listener doesn't care which path triggered
        // it; the discriminator is the message type alone.
        const {
          confirmationId,
          tool,
          args,
          resolvedElement,
          riskReason,
          metaSkillPreview,
        } = message;
        setMessages((prev) => {
          // Idempotent — if the same confirmationId is already in
          // messages (panel was mid-render when SW re-pushed), skip.
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i]!;
            if (m.role === "agent-confirm" && m.confirmationId === confirmationId) {
              return prev;
            }
          }
          return [
            ...prev,
            {
              role: "agent-confirm",
              confirmationId,
              tool,
              args,
              resolvedElement,
              riskReason,
              metaSkillPreview,
              resolved: undefined,
            },
          ];
        });
      } else if (message.type === "agent-done-task") {
        streamFinishedRef.current = true;
        const { success, summary, stepCount } = message;
        const next: DisplayMessage[] = [
          ...messagesRef.current,
          { role: "agent-summary", success, summary, stepCount },
        ];
        setMessages(next);
        messagesRef.current = next;
        accumulatedRef.current = "";
        setStreamingText("");
        streamingRef.current = false;
        setStreaming(false);
        void persistMessages(next);
      } else if (message.type === "session-confirm-request") {
        // M1-U5 — drift card / paused-resume card. Idempotent by
        // confirmationId so SW re-emit (panel-mounted) doesn't stack
        // duplicate rows.
        const { confirmationId, kind, payload } = message;
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i]!;
            if (
              m.role === "session-confirm" &&
              m.confirmationId === confirmationId
            ) {
              return prev;
            }
          }
          return [
            ...prev,
            {
              role: "session-confirm",
              confirmationId,
              kind,
              payload,
              resolved: undefined,
            },
          ];
        });
      } else if (message.type === "session-toast") {
        // SEC-PLAN-009 — transient warning from SW (flood-limit, etc.)
        // Rendered as a dismissable banner by Chat.
        setToast({ level: message.level, text: message.text });
      }
    },
    [persistMessages],
  );

  const handlePortDisconnect = useCallback(() => {
    if (streamFinishedRef.current) return;
    // Unexpected disconnect during a stream — flush partial text and
    // persist so the user sees what they got before the SW bailed.
    let next = messagesRef.current;
    if (accumulatedRef.current.trim()) {
      next = [
        ...next,
        { role: "assistant", content: accumulatedRef.current },
      ];
      setMessages(next);
      messagesRef.current = next;
    }
    accumulatedRef.current = "";
    setStreamingText("");
    streamingRef.current = false;
    setStreaming(false);
    streamFinishedRef.current = true;
    portRef.current = null;
    void persistMessages(next);
  }, [persistMessages]);

  // ── Mount: bootstrap active session + open per-session port ─────────
  // M3-U1 — port name is `chat-stream-${sessionId}`. The SW parses the
  // sessionId out of the name to anchor per-port state (abortController,
  // pendingConfirmations, inFlightSessionIds). Switching active sessions
  // disconnects the old port and connects a fresh one for the new id;
  // single-panel concurrent task switch remains gated by the streaming
  // guard (deferred to a future M3 unit). Cross-panel concurrency (two
  // sidepanels in two windows) IS supported by the SW because each panel
  // gets its own port pinned to its own sessionId.
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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Sweep stale empty active sessions left over from previous panel
        // mounts. We always create a fresh empty session below; the previous
        // mount's empty session would otherwise pile up forever in storage.
        // Heuristic guards:
        //   - status === "active" (paused/failed/archived must be preserved
        //     so the user can find their work in the drawer)
        //   - messageCount === 0 (per the M2 lock-on-send rule, only sessions
        //     with no DisplayMessages are candidates for cleanup)
        //   - lastAccessedAt < now - 60s (protect sibling-window panels that
        //     just created a fresh empty session and haven't sent a message
        //     yet — their entry is < 60s old, leave it alone)
        //   - lastAccessedAt > REAL_CLOCK_MIN (defends against tests that
        //     use fake clocks like `now: 1000` to set up scenarios — those
        //     timestamps fall outside any plausible real-clock range and
        //     should not be GC targets)
        const STALE_EMPTY_MS = 60_000;
        const REAL_CLOCK_MIN_MS = 1_000_000_000_000; // 2001-09-09
        const now = Date.now();
        const list = await listSessionIndex();
        if (cancelled) return;
        for (const entry of list) {
          if (entry.status !== "active") continue;
          if ((entry.messageCount ?? 1) > 0) continue;
          if (entry.lastAccessedAt < REAL_CLOCK_MIN_MS) continue;
          if (now - entry.lastAccessedAt < STALE_EMPTY_MS) continue;
          await hardDeleteSession(entry.id);
          if (cancelled) return;
        }

        // Always start a fresh, empty, unpinned session. The user's first
        // sendMessage captures the pin and bumps messageCount, which makes
        // the session visible in the drawer. Previous behavior reloaded
        // list[0]; the user requested every panel open start clean.
        const meta = await createSession();
        if (cancelled) return;
        setSessionId(meta.id);
        setStatus(meta.status);
        setPinnedOriginState(null);
        setMessages([]);
        portRef.current = connectPortFor(meta.id);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      // Disconnect on unmount so the SW abortController fires
      // immediately rather than waiting for keep-alive timeout.
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [connectPortFor]);

  // M1-U5 — track status changes from SW writes (cold-start
  // detectAndMarkPaused, post-resume markActive). Without this, the
  // panel would never see the SW transition from `active` to `paused`
  // after a SW death + wake-up that the user didn't trigger via
  // closing/reopening the panel. Only watches the per-session meta key
  // so traffic is minimal.
  useEffect(() => {
    if (!sessionId) return;
    const metaKey = `session_${sessionId}_meta`;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      const change = changes[metaKey];
      if (!change) return;
      const newMeta = change.newValue as
        | {
            messages?: DisplayMessage[];
            status?: SessionStatus;
            pinnedOrigin?: string;
          }
        | undefined;
      // Status update is always adopted — the SW transitions (paused→active,
      // active→failed) must land even mid-stream (e.g. SW cold-start marking
      // a task paused while the panel thinks it's still running).
      if (newMeta?.status !== undefined) setStatus(newMeta.status);
      // Pin update is always adopted — the SW or a sibling panel may have
      // landed a fresh pin between this panel's reads, and the Chat view's
      // PINNED indicator should reflect the persisted truth.
      if (newMeta?.pinnedOrigin !== undefined) {
        setPinnedOriginState(newMeta.pinnedOrigin || null);
      }
      if (newMeta?.messages !== undefined) {
        // P1-6 + Bug-fix-A — prevent self-write echo AND stale SW write-back
        // overwriting authoritative panel state.
        //
        // 1. During streaming: NEVER adopt the SW's messages. makeStepSnapshotHandler
        //    bumps updateLastAccessed every 5 steps which writes meta with the last
        //    persisted messages → onChanged fires. handleChatStream also
        //    fire-and-forgets updateLastAccessed at chat-start, which writes
        //    meta back with the messages snapshot taken BEFORE the panel had
        //    a chance to persist the user's just-sent message — that one would
        //    silently overwrite the user message if we adopted it.
        //
        // 2. Not streaming: skip self-echo (content equality) AND stale-prefix
        //    write-back (remote.length < local.length AND remote is a strict
        //    prefix of local). Both are signs the SW round-tripped a stale meta
        //    after the panel's authoritative state moved forward.
        if (streamingRef.current) {
          return;
        }
        const local = messagesRef.current;
        const remote = newMeta.messages;
        if (remote.length === local.length) {
          if (JSON.stringify(remote) === JSON.stringify(local)) {
            return; // self-write echo — no-op
          }
        } else if (remote.length < local.length) {
          // Strict-prefix check: SW wrote a stale-shorter messages array.
          // Compare element-by-element; if every remote[i] equals local[i],
          // the SW write is a stale snapshot → ignore.
          let isPrefix = true;
          for (let i = 0; i < remote.length; i++) {
            if (JSON.stringify(remote[i]) !== JSON.stringify(local[i])) {
              isPrefix = false;
              break;
            }
          }
          if (isPrefix) return;
        }
        setMessages(remote);
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, [sessionId]);

  // ── sendMessage ────────────────────────────────────────────────────
  // M1-U4 — does NOT open a port; reuses the persistent one opened at
  // mount. If the port has died (disconnect during a prior stream),
  // sendMessage refuses rather than silently re-opening; the user can
  // close + reopen the panel to recover. This keeps lifecycle simple
  // and matches plan M1-U5's "SW death is observable" expectation.
  const sendMessage = useCallback(
    (input: SendMessageInput) => {
      if (streaming) return;
      const id = sessionIdRef.current;
      if (!id) return;
      const port = portRef.current;
      if (!port) return;
      const userMessage: DisplayMessage = {
        role: "user",
        content: input.content,
        ...(input.expandedForLLM !== undefined
          ? { expandedForLLM: input.expandedForLLM }
          : {}),
      };
      const updated = [...messagesRef.current, userMessage];
      // M3-U2 (post-acceptance) — empty→non-empty is the moment we lock
      // the pin. Capture HERE rather than at session create / activation
      // so the user's actual at-send tab wins over their at-create tab.
      // Empty session: panel UI shows live-current-tab preview;
      // first sendMessage: capture + persist; from then on locked.
      const isFirstMessage = messagesRef.current.length === 0;
      // Bug-fix-A — sync messagesRef + streamingRef BEFORE port.postMessage
      // so the SW's chat-start-triggered updateLastAccessed (which writes
      // a stale meta back to storage and re-fires the metaKey listener)
      // observes streamingRef=true and bails out via the streaming guard
      // instead of overwriting the just-pushed user message. The messagesRef
      // update also makes the prefix-equality echo guard (in the metaKey
      // listener below) recognise the SW write as a strict prefix of the
      // panel's authoritative state.
      messagesRef.current = updated;
      streamingRef.current = true;
      setMessages(updated);
      setStreaming(true);
      setStreamingText("");
      setError(null);
      // Reset per-stream scratch.
      accumulatedRef.current = "";
      streamFinishedRef.current = false;

      // Build the LLM-facing chat history (text-only, slash-expanded).
      const chatMessages: ChatMessage[] = updated
        .filter(
          (
            m,
          ): m is
            | { role: "user"; content: string; expandedForLLM?: string }
            | { role: "assistant"; content: string } =>
            m.role === "user" || m.role === "assistant",
        )
        .map((m) =>
          m.role === "user" && m.expandedForLLM
            ? { role: "user" as const, content: m.expandedForLLM }
            : { role: m.role, content: m.content },
        );

      // Bug-fix-C — persist immediately so the session_index entry picks
      // up the first-user-message title fallback (via persistMessages →
      // deriveTitleFromMessages → setSessionMeta atomic index update).
      // Without this, the top bar + drawer would keep saying "New
      // Session" until the model's reply lands at chat-done. Persisting
      // also defends against Bug 1: it makes the panel's authoritative
      // messages the on-disk version before any SW updateLastAccessed
      // round-trip can write back a stale shorter snapshot.
      // Fire-and-forget; failures are non-fatal.
      void persistMessages(updated);

      port.postMessage({
        type: "chat-start",
        messages: chatMessages,
        sessionId: id,
      });

      // M3-U2 (post-acceptance) — pin capture is a separate
      // fire-and-forget that ONLY patches pinnedTabId / pinnedOrigin
      // (never `messages`). Critical: the chat-done handler also calls
      // persistMessages(next-with-assistant). If the pin patch wrote
      // `messages: updated` (the [user]-only snapshot) it could
      // overwrite chat-done's [user, assistant] write under microtask
      // ordering. Patching pin separately keeps the message persistence
      // path untouched.
      //
      // First-task ordering note: SW's handleChatStream may read meta
      // BEFORE the pin patch lands → ctx.pinned is undefined → the
      // loop falls back to chrome.tabs.query active-tab. That fallback
      // returns the same tab the user just sent from (no tab switch in
      // the microsecond gap), so the first task pins to the right tab
      // via fallback. Subsequent chat-starts read the patched pin via
      // ctx directly.
      if (isFirstMessage) {
        void (async () => {
          try {
            const meta = await getSessionMeta(id);
            if (!meta || meta.status === "archived") return;
            if (meta.pinnedTabId !== undefined && meta.pinnedOrigin) return;
            const pin = await captureActivePinned();
            if (!pin) return;
            // Re-read in case something else patched in the meantime.
            const fresh = await getSessionMeta(id);
            if (!fresh || fresh.status === "archived") return;
            if (fresh.pinnedTabId !== undefined && fresh.pinnedOrigin) return;
            await setSessionMeta({
              ...fresh,
              pinnedTabId: pin.pinnedTabId,
              pinnedOrigin: pin.pinnedOrigin,
              lastAccessedAt: Date.now(),
            });
            setPinnedOriginState(pin.pinnedOrigin);
          } catch (e) {
            console.warn("[useSession] pin patch on first send failed:", e);
          }
        })();
      }
    },
    [streaming, persistMessages],
  );

  const abort = useCallback(() => {
    const port = portRef.current;
    if (!port) return;
    try {
      port.postMessage({ type: "chat-abort" });
    } catch {
      // port may already be closing — non-fatal
    }
  }, []);

  const resolveConfirm = useCallback(
    (confirmationId: string, approved: boolean) => {
      const port = portRef.current;
      if (!port) return;
      // P1-4 — carry sessionId so SW can verify the response belongs to
      // the same session that owns the confirmationId.
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        port.postMessage({
          type: "agent-confirm-response",
          confirmationId,
          approved,
          sessionId: id,
        });
      } catch {
        // port may already be closing — non-fatal
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "agent-confirm" && m.confirmationId === confirmationId
            ? { ...m, resolved: approved ? "approved" : "rejected" }
            : m,
        ),
      );
    },
    [],
  );

  const resumeTask = useCallback(() => {
    const port = portRef.current;
    const id = sessionIdRef.current;
    if (!port || !id) return;
    // P0-2 — set streaming=true BEFORE posting so the setActive guard
    // blocks any concurrent session switch while the resumed loop is running.
    // The existing chat-done / chat-error / agent-done-task done-boundary
    // paths will correctly flip streaming back to false when the loop ends.
    // Bug-fix-A — sync streamingRef synchronously (same reasoning as
    // sendMessage above).
    streamingRef.current = true;
    setStreaming(true);
    accumulatedRef.current = "";
    streamFinishedRef.current = false;
    try {
      port.postMessage({ type: "resume-task", sessionId: id });
    } catch {
      // port may be in the process of closing — non-fatal
      // If post fails, revert streaming flag so the UI doesn't get stuck
      streamingRef.current = false;
      setStreaming(false);
      streamFinishedRef.current = true;
    }
  }, []);

  const discardTask = useCallback((confirmationId: string) => {
    const port = portRef.current;
    const id = sessionIdRef.current;
    if (!port || !id) return;
    try {
      port.postMessage({
        type: "discard-task",
        sessionId: id,
        confirmationId,
      });
    } catch {
      // port may be in the process of closing — non-fatal
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.role === "session-confirm" && m.confirmationId === confirmationId
          ? { ...m, resolved: "discarded" as const }
          : m,
      ),
    );
  }, []);

  const clearMessages = useCallback(async () => {
    setMessages([]);
    setError(null);
    const id = sessionIdRef.current;
    if (!id) return;
    const current = await getSessionMeta(id);
    if (!current) return;
    await setSessionMeta({
      ...current,
      messages: [],
      lastAccessedAt: Date.now(),
    });
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const clearToast = useCallback(() => setToast(null), []);

  /**
   * M2-U2 — switch active session. Refuses when streaming is true
   * (no per-session port yet; M3 will allow this).
   *
   * On switch:
   *   1. Loads persisted messages for the new session from storage.
   *   2. Bumps lastAccessedAt so LRU order reflects user interaction.
   *   3. Sends panel-mounted on the existing port so the SW re-emits
   *      any live pendingConfirm for the new session (R4 re-emit path).
   */
  const setActive = useCallback(async (id: string): Promise<string | null> => {
    // Guard: don't switch mid-stream. M3-U1 ships per-session port wire
    // identity but keeps the panel-level streaming guard — concurrent
    // same-panel tasks need streaming-state-per-session plumbing across
    // accumulatedRef / messagesRef and is deferred to a future M3 unit.
    if (streaming) return null;

    const meta = await getSessionMeta(id);
    if (!meta) return null;

    // No-op if already on this session.
    if (sessionIdRef.current === id) return id;

    // M3-U2 (post-acceptance) — legacy-session pin migration only fires
    // for sessions that ALREADY have content (messages.length > 0). For
    // empty sessions the pin will be captured at the first sendMessage
    // (lock-on-send rule); pre-capturing here would steal that decision
    // from the user's actual at-send tab focus.
    //
    // Legacy = M1/M2 sessions whose meta was written before pin support
    // existed but which already accumulated messages. Backfilling at
    // activation lets resume / next-send anchor cleanly.
    let metaForActivate = meta;
    let didMigrate = false;
    const sessionHasContent = (meta.messages?.length ?? 0) > 0;
    if (
      sessionHasContent &&
      (meta.pinnedTabId === undefined || !meta.pinnedOrigin)
    ) {
      const pinned = await captureActivePinned();
      if (pinned) {
        const patched = {
          ...meta,
          pinnedTabId: pinned.pinnedTabId,
          pinnedOrigin: pinned.pinnedOrigin,
          lastAccessedAt: Date.now(),
        };
        await setSessionMeta(patched);
        metaForActivate = patched;
        didMigrate = true;
      }
    }

    // Bump lastAccessedAt in storage (M2-U1 three-trigger wiring).
    // Skip when the legacy-pin migration above already wrote a fresh
    // lastAccessedAt — otherwise this would issue a redundant second
    // setSessionMeta with another fresh timestamp.
    if (!didMigrate) {
      await updateLastAccessed(id);
    }

    // M3-U1 — swap to the new session's port. Disconnect old (its
    // SW-side abortController fires; in-flight task on that session is
    // killed cleanly because we already streaming-guarded above) and
    // connect a fresh port whose name carries the new sessionId.
    portRef.current?.disconnect();
    portRef.current = null;

    // Update ref immediately so callers that synchronously follow setActive
    // (e.g. resumeTask in handleResumeSession) see the new id without
    // waiting for the React state re-render cycle.
    sessionIdRef.current = id;

    // Load the session's messages into React state
    setSessionId(id);
    setStatus(metaForActivate.status);
    setPinnedOriginState(metaForActivate.pinnedOrigin ?? null);
    setMessages(metaForActivate.messages ?? []);
    setError(null);
    setToast(null);

    // Open the new session's port (sends panel-mounted as part of connect).
    portRef.current = connectPortFor(id);

    return id;
  }, [streaming, connectPortFor]);

  /**
   * M2-U2 — create a new session and make it active. Returns the new
   * session's id, or null if refused (streaming in progress). Does not
   * open a new port (M3-U1 concern); reuses the existing port with a
   * new panel-mounted announce.
   *
   * P0-1 guard: refuses when streaming=true (mirror of setActive guard).
   * Without this, messages from a still-running agent loop would route
   * into the new session's UI (K-1 informed-approval bypass).
   */
  const createAndActivate = useCallback(async (): Promise<string | null> => {
    // P0-1 — refuse when a stream is in flight (no per-session port yet;
    // M3-U1 will allow concurrent sessions with per-session ports).
    if (streaming) {
      setToast({ level: "warn", text: "Stop the current task before starting a new session." });
      return null;
    }
    // Defense-in-depth: reset per-stream scratch state. If a prior stream
    // ended abnormally without flipping these, we start clean.
    accumulatedRef.current = "";
    streamFinishedRef.current = true;

    // M3-U2 (post-acceptance) — new session starts WITHOUT a pin. The
    // user can still tab-switch freely while the session is empty;
    // PINNED is locked at the moment of first sendMessage instead. This
    // matches the user-facing rule "empty session can change pin, non-
    // empty session is locked".
    const meta = await createSession();
    // M3-U1 — swap to the new session's port (the new session's id is
    // freshly minted, so the prior port belongs to a different session
    // and must be disconnected to release its SW-side resources).
    portRef.current?.disconnect();
    portRef.current = null;

    // Update ref immediately (same reasoning as setActive)
    sessionIdRef.current = meta.id;
    setSessionId(meta.id);
    setStatus(meta.status);
    setPinnedOriginState(null); // brand new session — no pin yet
    setMessages([]);
    setError(null);
    setToast(null);

    portRef.current = connectPortFor(meta.id);

    return meta.id;
  }, [connectPortFor]);

  return {
    sessionId,
    ready,
    status,
    pinnedOrigin,
    messages,
    streaming,
    streamingText,
    error,
    toast,
    sendMessage,
    abort,
    resolveConfirm,
    resumeTask,
    discardTask,
    clearMessages,
    clearError,
    clearToast,
    setActive,
    createAndActivate,
  };
}
