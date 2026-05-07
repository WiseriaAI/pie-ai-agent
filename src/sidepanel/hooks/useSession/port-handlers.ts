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

    // Subsequent branches added in Tasks 2c–2g.
  };

  const makeDisconnectHandler = (_sessionId: string) => {
    return () => {
      // Implemented in Task 2h.
    };
  };

  return { handleMessage, makeDisconnectHandler };
}
