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
 * Persistence boundaries (only at "done" boundaries to avoid mid-stream
 * storage churn — plan M1-U2 Approach):
 *   - chat-done           → assistant message + persist
 *   - chat-error          → assistant message (if any partial) + error
 *                            recorded; messages persisted so user sees
 *                            error context after switching back
 *   - agent-done-task     → final summary appended + persist
 *   - clearMessages()     → empty array persisted
 *
 * Mid-stream events (chat-chunk / agent-step / agent-confirm-request)
 * update React state but do NOT write storage.
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
  /** Resolves a pending agent-confirm card: posts the response to the
   *  SW and marks the corresponding message as resolved in React state.
   *  Does NOT persist storage — the resolution will land in the next
   *  done-boundary write. (Storage holds the LATEST message array; if
   *  user closes the panel between approve and chat-done, the resolved
   *  flag is non-load-bearing — agent loop already moved on.) */
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

  const portRef = useRef<chrome.runtime.Port | null>(null);
  // sessionIdRef shadows the state so port-listener closures (created
  // inside sendMessage) always see the current value without re-binding
  // every render.
  const sessionIdRef = useRef<string | null>(null);
  // Mirror messages so the persist helper can read latest without going
  // through setMessages updater (we need to await setSessionMeta).
  const messagesRef = useRef<DisplayMessage[]>([]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ── Mount: bootstrap active session ────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await listSessionIndex();
        if (cancelled) return;

        if (list.length === 0) {
          const meta = await createSession();
          if (cancelled) return;
          setSessionId(meta.id);
          setMessages([]);
        } else {
          const top = list[0]!;
          const meta = await getSessionMeta(top.id);
          if (cancelled) return;
          setSessionId(top.id);
          setMessages(meta?.messages ?? []);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      // Disconnect any open port so the SW abortController fires
      // immediately rather than waiting for keep-alive timeout.
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

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

  // ── sendMessage ────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (input: SendMessageInput) => {
      if (streaming) return;
      const id = sessionIdRef.current;
      // Bootstrap not finished yet — caller should be gating on `ready`,
      // but defend against the race regardless. Without an id, the SW
      // can't snapshot to the right key.
      if (!id) return;
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

      const port = chrome.runtime.connect({ name: "chat-stream" });
      portRef.current = port;

      let accumulated = "";
      let finished = false;

      port.onMessage.addListener((message: PortMessageToPanel) => {
        if (message.type === "chat-chunk") {
          accumulated += message.text;
          setStreamingText(accumulated);
        } else if (message.type === "chat-done") {
          finished = true;
          let next = messagesRef.current;
          if (accumulated.trim()) {
            next = [...next, { role: "assistant", content: accumulated }];
            setMessages(next);
          }
          setStreamingText("");
          setStreaming(false);
          portRef.current = null;
          void persistMessages(next);
        } else if (message.type === "chat-error") {
          finished = true;
          setError(message.error);
          let next = messagesRef.current;
          if (accumulated.trim()) {
            next = [...next, { role: "assistant", content: accumulated }];
            setMessages(next);
          }
          setStreamingText("");
          setStreaming(false);
          portRef.current = null;
          // Persist even on error so user sees prior context after
          // switching sub-views and coming back.
          void persistMessages(next);
        } else if (message.type === "agent-step") {
          // Flush any accumulated text into a plain assistant message
          // first so step bubbles render after the explanatory prose.
          if (accumulated.trim()) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: accumulated },
            ]);
            accumulated = "";
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
            // tool) is already present at the tail — avoids
            // duplicate rows when SW emits status=pending then status=ok.
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
          const {
            confirmationId,
            tool,
            args,
            resolvedElement,
            riskReason,
            metaSkillPreview,
          } = message;
          setMessages((prev) => [
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
          ]);
        } else if (message.type === "agent-done-task") {
          finished = true;
          const { success, summary, stepCount } = message;
          const next: DisplayMessage[] = [
            ...messagesRef.current,
            { role: "agent-summary", success, summary, stepCount },
          ];
          setMessages(next);
          setStreamingText("");
          setStreaming(false);
          portRef.current = null;
          void persistMessages(next);
        }
      });

      port.onDisconnect.addListener(() => {
        if (finished) return;
        // Unexpected disconnect — flush partial text and persist so the
        // user can see what they got before the SW bailed.
        let next = messagesRef.current;
        if (accumulated.trim()) {
          next = [...next, { role: "assistant", content: accumulated }];
          setMessages(next);
        }
        setStreamingText("");
        setStreaming(false);
        portRef.current = null;
        void persistMessages(next);
      });

      port.postMessage({
        type: "chat-start",
        messages: chatMessages,
        sessionId: id,
      });
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
