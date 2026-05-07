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

    // Subsequent branches added in Tasks 2c–2g.
  };

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

  return { handleMessage, makeDisconnectHandler };
}
