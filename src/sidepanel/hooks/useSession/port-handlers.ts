import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DisplayMessage, PortMessageToPanel, PortMessageToWorker, QuoteAddedMessage } from "@/types";
import { withSlot, type SessionRuntimeSlot } from "./runtime-map";
import { resolveDownload } from "./download-pending";

export interface CreatePortHandlersDeps {
  slotsRef: MutableRefObject<Map<string, SessionRuntimeSlot>>;
  setSlots: Dispatch<SetStateAction<Map<string, SessionRuntimeSlot>>>;
  persistMessages: (sessionId: string, messages: DisplayMessage[]) => Promise<void>;
  /** Issue #34 — ref to postWithReconnect; populated after hook wires up the
   *  port machinery (avoids circular useMemo dep). Used by
   *  chat-instruction-rejected to fall back to chat-start. */
  postMessageRef?: MutableRefObject<((sessionId: string, payload: PortMessageToWorker) => boolean) | null>;
  /** #30 migration bridge — sync legacy single-tenant state while callers
   *  still read from it. Removed in Task 9b. */
  legacy?: {
    sessionIdRef: MutableRefObject<string | null>;
    setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
    messagesRef: MutableRefObject<DisplayMessage[]>;
    setStreaming: Dispatch<SetStateAction<boolean>>;
    streamingRef: MutableRefObject<boolean>;
    setStreamingText: Dispatch<SetStateAction<string>>;
    setError: Dispatch<SetStateAction<string | null>>;
    setToast: Dispatch<SetStateAction<{ level: "warn" | "error" | "info"; text: string } | null>>;
    accumulatedRef: MutableRefObject<string>;
    streamFinishedRef: MutableRefObject<boolean>;
  };
}

export interface PortHandlers {
  /** Single instance, attached to every port. Routes by `message.sessionId`. */
  handleMessage: (msg: PortMessageToPanel) => void;
  /** Per-port closure capturing sessionId. Created fresh in connectPortFor. */
  makeDisconnectHandler: (sessionId: string) => () => void;
}

export function createPortHandlers(deps: CreatePortHandlersDeps): PortHandlers {
  const { slotsRef, setSlots, persistMessages, postMessageRef, legacy } = deps;

  /** Sync write to slotsRef (Bug-fix-A truth source) + setSlots for React commit. */
  function patchSlot(
    id: string,
    patch:
      | Partial<SessionRuntimeSlot>
      | ((s: SessionRuntimeSlot) => Partial<SessionRuntimeSlot>),
  ) {
    slotsRef.current = withSlot(slotsRef.current, id, patch);
    setSlots(slotsRef.current);

    // #30 migration bridge — sync legacy single-tenant state while callers
    // still read from it (removed in Task 9b).
    if (legacy && id === legacy.sessionIdRef.current) {
      const slot = slotsRef.current.get(id);
      if (slot) {
        legacy.streamingRef.current = slot.streaming;
        legacy.setStreaming(slot.streaming);
        legacy.setStreamingText(slot.streamingText);
        legacy.setError(slot.error);
        legacy.setToast(slot.toast);
        legacy.accumulatedRef.current = slot.accumulated;
        legacy.streamFinishedRef.current = slot.streamFinished;
        // messages: only set if they differ (avoids unnecessary re-renders)
        if (legacy.messagesRef.current !== slot.messages) {
          legacy.messagesRef.current = slot.messages;
          legacy.setMessages(slot.messages);
        }
      }
    }
  }

  const buildAssistant = (
    base: DisplayMessage[],
    accumulated: string,
    thinking: string,
  ): { next: DisplayMessage[]; flushed: boolean } => {
    if (!accumulated.trim() && !thinking.trim()) return { next: base, flushed: false };
    const m: DisplayMessage = {
      role: "assistant",
      content: accumulated,
      ...(thinking.trim() ? { thinking } : {}),
    };
    return { next: [...base, m], flushed: true };
  };

  const handleMessage = (msg: PortMessageToPanel) => {
    // needs-file-access has no sessionId; it is handled by useFileAccessPrompt separately.
    if (msg.type === "needs-file-access") return;

    const id = msg.sessionId;

    if (msg.type === "chat-chunk") {
      patchSlot(id, (prev) => {
        const accumulated = prev.accumulated + msg.text;
        return { accumulated, streamingText: accumulated };
      });
      return;
    }
    if (msg.type === "thinking-chunk") {
      patchSlot(id, (prev) => ({ streamingThinking: prev.streamingThinking + msg.text }));
      return;
    }
    if (msg.type === "chat-done") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const baseMessages = prev?.messages ?? [];
      const { next } = buildAssistant(baseMessages, accumulated, thinking);
      patchSlot(id, {
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }

    if (msg.type === "chat-error") {
      const prev = slotsRef.current.get(id);
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const baseMessages = prev?.messages ?? [];
      const { next } = buildAssistant(baseMessages, accumulated, thinking);
      patchSlot(id, {
        error: msg.error,
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }

    if (msg.type === "agent-step") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";

      // 1. Flush pending accumulated text / thinking first (legacy behavior
      //    preserved from useSession.ts:349-365).
      const { next: flushedMsgs, flushed } = buildAssistant(baseMessages, accumulated, thinking);
      let nextMessages: DisplayMessage[] = flushedMsgs;

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
        ...(flushed ? { accumulated: "", streamingText: "", streamingThinking: "" } : {}),
      });
      return;
    }

    if (msg.type === "agent-done-task") {
      const prev = slotsRef.current.get(id);
      const baseMessages = prev?.messages ?? [];
      // Mid-stream abort lands here (not chat-done): the loop is cut off while
      // assistant text/thinking is still streaming. Flush that in-flight turn
      // into a real message first — same as chat-done / agent-step / disconnect —
      // otherwise the reset below discards what the user just saw on screen.
      const accumulated = prev?.accumulated ?? "";
      const thinking = prev?.streamingThinking ?? "";
      const { next: flushedMsgs } = buildAssistant(baseMessages, accumulated, thinking);
      const next: DisplayMessage[] = [
        ...flushedMsgs,
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
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(id, next);
      return;
    }

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

    if (msg.type === "quote-added") {
      patchSlot(id, (prev) => ({ quotes: [...prev.quotes, (msg as QuoteAddedMessage).quote] }));
      return;
    }

    if (msg.type === "agent-usage") {
      patchSlot(id, {
        usage: {
          lastInputTokens: msg.lastInputTokens,
          lastOutputTokens: msg.lastOutputTokens,
          totalInputTokens: msg.totalInputTokens,
          totalOutputTokens: msg.totalOutputTokens,
        },
      });
      return;
    }

    // Issue #34 — SW → panel: update pending instruction state for this session.
    if (msg.type === "chat-instruction-state") {
      const map = new Map<string, { createdAt: number }>();
      for (const p of msg.pending) {
        map.set(p.chatMessageId, { createdAt: p.createdAt });
      }
      patchSlot(msg.sessionId, { pendingByChatMessageId: map });
      return;
    }

    // Issue #34 — SW → panel: instruction-add arrived after loop ended; fall
    // back to a normal chat-start so the user's message is still processed.
    if (msg.type === "chat-instruction-rejected") {
      const slot = slotsRef.current.get(msg.sessionId);
      if (!slot) return;
      const flat = (slot.messages ?? []).filter(
        (m): m is
          | { role: "user"; content: string; expandedForLLM?: string; id?: string }
          | { role: "assistant"; content: string } =>
          m.role === "user" || m.role === "assistant",
      );
      const chatMessages = flat.map((m) => ({
        role: m.role,
        content:
          m.role === "user" && "expandedForLLM" in m && m.expandedForLLM
            ? m.expandedForLLM
            : m.content,
      }));
      patchSlot(msg.sessionId, {
        streaming: true,
        streamFinished: false,
        accumulated: "",
        streamingText: "",
        error: null,
      });
      postMessageRef?.current?.(msg.sessionId, {
        type: "chat-start",
        messages: chatMessages,
        sessionId: msg.sessionId,
      });
      return;
    }

    if (msg.type === "file-output") {
      const prev = slotsRef.current.get(msg.sessionId);
      const baseMessages = prev?.messages ?? [];
      // de-dup by artifactId (a re-emit shouldn't double-card)
      if (baseMessages.some((m) => m.role === "file-output" && m.artifactId === msg.artifactId)) return;
      const entry: DisplayMessage = {
        role: "file-output",
        artifactId: msg.artifactId,
        filename: msg.filename,
        mime: msg.mime,
        size: msg.size,
      };
      patchSlot(msg.sessionId, { messages: [...baseMessages, entry] });
      return;
    }

    if (msg.type === "file-output-result") {
      resolveDownload(msg.artifactId, { status: msg.status });
      return;
    }

    // Subsequent branches added in Tasks 2c–2g.
  };

  const makeDisconnectHandler = (sessionId: string) => {
    return () => {
      const slot = slotsRef.current.get(sessionId);
      if (!slot || slot.streamFinished) return;
      const { next } = buildAssistant(slot.messages, slot.accumulated, slot.streamingThinking);
      patchSlot(sessionId, {
        messages: next,
        accumulated: "",
        streamingThinking: "",
        streamingText: "",
        streaming: false,
        streamFinished: true,
      });
      void persistMessages(sessionId, next);
    };
  };

  return { handleMessage, makeDisconnectHandler };
}
