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
import type { SessionStatus } from "@/lib/sessions/types";

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
   * session's id.
   */
  createAndActivate: () => Promise<string>;
}

export function useSession(): UseSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
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

  // ── Persist helper ─────────────────────────────────────────────────
  // Writes the in-memory messages array to session_${id}_meta. Only
  // called at done boundaries (chat-done / chat-error / agent-done-task)
  // to avoid storage churn during streaming.
  const persistMessages = useCallback(
    async (next: DisplayMessage[]) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const current = await getSessionMeta(id);
      if (!current) return;
      await setSessionMeta({
        ...current,
        messages: next,
        lastAccessedAt: Date.now(),
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
        }
        accumulatedRef.current = "";
        setStreamingText("");
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
        }
        accumulatedRef.current = "";
        setStreamingText("");
        setStreaming(false);
        void persistMessages(next);
      } else if (message.type === "agent-step") {
        if (accumulatedRef.current.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: accumulatedRef.current },
          ]);
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
        accumulatedRef.current = "";
        setStreamingText("");
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
    }
    accumulatedRef.current = "";
    setStreamingText("");
    setStreaming(false);
    streamFinishedRef.current = true;
    portRef.current = null;
    void persistMessages(next);
  }, [persistMessages]);

  // ── Mount: bootstrap active session + open persistent port ─────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await listSessionIndex();
        if (cancelled) return;

        let id: string;
        let initialMessages: DisplayMessage[] = [];
        let initialStatus: SessionStatus = "active";
        if (list.length === 0) {
          const meta = await createSession();
          if (cancelled) return;
          id = meta.id;
          initialStatus = meta.status;
        } else {
          const top = list[0]!;
          const meta = await getSessionMeta(top.id);
          if (cancelled) return;
          id = top.id;
          initialMessages = meta?.messages ?? [];
          initialStatus = meta?.status ?? "active";
        }
        setSessionId(id);
        setStatus(initialStatus);
        setMessages(initialMessages);

        // M1-U4 — open the port and announce ourselves so the SW can
        // re-emit any live agent-confirm-request for this session
        // (R4). The same port handles all subsequent streams; the
        // listener stays attached for the hook's lifetime.
        const port = chrome.runtime.connect({ name: "chat-stream" });
        portRef.current = port;
        port.onMessage.addListener(handlePortMessage);
        port.onDisconnect.addListener(handlePortDisconnect);
        port.postMessage({ type: "panel-mounted", sessionId: id });
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
  }, [handlePortMessage, handlePortDisconnect]);

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
          }
        | undefined;
      if (newMeta?.status !== undefined) setStatus(newMeta.status);
      if (newMeta?.messages !== undefined) {
        // Only adopt the SW's view if it differs by reference — avoids
        // round-tripping our own writes back into local state.
        if (newMeta.messages !== messagesRef.current) {
          setMessages(newMeta.messages);
        }
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

      port.postMessage({
        type: "chat-start",
        messages: chatMessages,
        sessionId: id,
      });
    },
    [streaming],
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
    try {
      port.postMessage({ type: "resume-task", sessionId: id });
    } catch {
      // port may be in the process of closing — non-fatal
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
    // Guard: don't switch mid-stream (M3-U1 will allow this with per-session ports)
    if (streaming) return null;

    const meta = await getSessionMeta(id);
    if (!meta) return null;

    // Bump lastAccessedAt in storage (M2-U1 three-trigger wiring)
    await updateLastAccessed(id);

    // Update ref immediately so callers that synchronously follow setActive
    // (e.g. resumeTask in handleResumeSession) see the new id without
    // waiting for the React state re-render cycle.
    sessionIdRef.current = id;

    // Load the session's messages into React state
    setSessionId(id);
    setStatus(meta.status);
    setMessages(meta.messages ?? []);
    setError(null);
    setToast(null);

    // Announce to the SW so it can re-emit any live confirm-request (R4)
    const port = portRef.current;
    if (port) {
      try {
        port.postMessage({ type: "panel-mounted", sessionId: id });
      } catch {
        // port may be closing — non-fatal, the listener will handle reconnect
      }
    }

    return id;
  }, [streaming]);

  /**
   * M2-U2 — create a new session and make it active. Returns the new
   * session's id. Does not open a new port (M3-U1 concern); reuses the
   * existing port with a new panel-mounted announce.
   */
  const createAndActivate = useCallback(async (): Promise<string> => {
    const meta = await createSession();
    // Update ref immediately (same reasoning as setActive)
    sessionIdRef.current = meta.id;
    setSessionId(meta.id);
    setStatus(meta.status);
    setMessages([]);
    setError(null);
    setToast(null);

    const port = portRef.current;
    if (port) {
      try {
        port.postMessage({ type: "panel-mounted", sessionId: meta.id });
      } catch {
        // non-fatal
      }
    }

    return meta.id;
  }, []);

  return {
    sessionId,
    ready,
    status,
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
