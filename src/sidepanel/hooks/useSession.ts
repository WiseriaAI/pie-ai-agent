import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/model-router";
import type { DisplayMessage, PortMessageToPanel } from "@/types";
import {
  createSession,
  getSessionMeta,
  listSessionIndex,
  setSessionMeta,
} from "@/lib/sessions/storage";

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
  messages: DisplayMessage[];
  streaming: boolean;
  streamingText: string;
  error: string | null;
  sendMessage: (input: SendMessageInput) => void;
  /** Sends a chat-abort message to the SW. Caller is responsible for
   *  guarding against rapid-fire aborts. */
  abort: () => void;
  /** Resolves a pending agent-confirm card. Posts the response to the
   *  SW and marks the corresponding message as resolved in React
   *  state. */
  resolveConfirm: (confirmationId: string, approved: boolean) => void;
  /** Clears the message history both in React state and in storage. */
  clearMessages: () => Promise<void>;
  /** Allows Chat to dismiss the error banner without re-sending. */
  clearError: () => void;
}

export function useSession(): UseSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      }
      // M1-U4 — `session-confirm-request` protocol slot exists but
      // M1-U5 will add the SessionConfirmCard rendering path. M1-U4
      // ignores it (no kind has an emitter yet).
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
        if (list.length === 0) {
          const meta = await createSession();
          if (cancelled) return;
          id = meta.id;
        } else {
          const top = list[0]!;
          const meta = await getSessionMeta(top.id);
          if (cancelled) return;
          id = top.id;
          initialMessages = meta?.messages ?? [];
        }
        setSessionId(id);
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
      try {
        port.postMessage({
          type: "agent-confirm-response",
          confirmationId,
          approved,
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

  return {
    sessionId,
    ready,
    messages,
    streaming,
    streamingText,
    error,
    sendMessage,
    abort,
    resolveConfirm,
    clearMessages,
    clearError,
  };
}
