import { useCallback, useEffect, useRef, useState } from "react";
import { swPort } from "@/lib/sw-connection/manager";
import type { RecordedAction } from "@/lib/recording/types";
import type { PortMessageToPanel } from "@/types";

interface UseRecordingArgs {
  sessionId: string | null;
  /** Reframe (2026-05-05)：onFinished receives the serialized trace + step
   *  count. Caller (App.tsx) sets pendingRecording state → Chat input shows
   *  chip → Send time prefixes /create_skill_from_recording. */
  onFinished?: (serializedTrace: string, stepCount: number) => void;
}

interface UseRecording {
  active: boolean;
  actions: RecordedAction[];
  /** Set when recording-aborted broadcast received. Cleared at next start. */
  lastAbortReason:
    | "sw-restart"
    | "session-switched"
    | "panel-disconnect"
    | "tab-closed"
    | "csp-blocked"
    | "user-discard"
    | null;
  startRecording: () => void;
  /** Reframe (2026-05-05)：no longer takes name/desc/etc. SW serializes the
   *  trace and broadcasts it back via onFinished. */
  finishRecording: () => void;
  discardRecording: () => void;
}

export function useRecording({ sessionId, onFinished }: UseRecordingArgs): UseRecording {
  const [active, setActive] = useState(false);
  const [actions, setActions] = useState<RecordedAction[]>([]);
  const [lastAbortReason, setLastAbortReason] = useState<UseRecording["lastAbortReason"]>(null);

  const sessionRef = useRef(sessionId);
  const activeRef = useRef(false);

  // Auto-discard when session switches mid-recording. Sent via swPort.send to
  // the PREVIOUS session so a SW idle-out doesn't silently swallow the discard.
  useEffect(() => {
    const prev = sessionRef.current;
    if (prev && sessionId !== prev && activeRef.current) {
      swPort.send(prev, { type: "recording-discard", sessionId: prev });
      setActive(false);
      activeRef.current = false;
      setActions([]);
      setLastAbortReason("session-switched");
    }
    sessionRef.current = sessionId;
  }, [sessionId]);

  // Listen for SW broadcasts via the shared per-session swPort subscription.
  // swPort owns the port lifecycle (open / reconnect on SW death); we just
  // subscribe an onMessage listener that survives reconnects.
  useEffect(() => {
    if (!sessionId) return;
    const listener = (msg: PortMessageToPanel) => {
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (
        msg.type !== "recording-started" &&
        msg.type !== "recording-action-broadcast" &&
        msg.type !== "recording-finished" &&
        msg.type !== "recording-aborted"
      ) {
        return;
      }
      if (msg.sessionId !== sessionRef.current) return;

      if (msg.type === "recording-started") {
        setActive(true);
        activeRef.current = true;
        setActions([]);
        setLastAbortReason(null);
      } else if (msg.type === "recording-action-broadcast") {
        setActions((prev) => [...prev, msg.action]);
      } else if (msg.type === "recording-finished") {
        setActive(false);
        activeRef.current = false;
        setActions([]);
        if (onFinished) onFinished(msg.serializedTrace, msg.stepCount);
      } else if (msg.type === "recording-aborted") {
        setActive(false);
        activeRef.current = false;
        setActions([]);
        setLastAbortReason(msg.reason);
      }
    };
    const unsubscribe = swPort.connect(sessionId, { onMessage: listener });
    return unsubscribe;
  }, [sessionId, onFinished]);

  const startRecording = useCallback(() => {
    if (!sessionId) return;
    swPort.send(sessionId, { type: "recording-start", sessionId });
  }, [sessionId]);

  const finishRecording = useCallback(() => {
    if (!sessionId) return;
    swPort.send(sessionId, { type: "recording-finish", sessionId });
  }, [sessionId]);

  const discardRecording = useCallback(() => {
    if (!sessionId) return;
    swPort.send(sessionId, { type: "recording-discard", sessionId });
  }, [sessionId]);

  return {
    active,
    actions,
    lastAbortReason,
    startRecording,
    finishRecording,
    discardRecording,
  };
}
