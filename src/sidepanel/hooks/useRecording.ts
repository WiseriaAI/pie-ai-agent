import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordedAction } from "@/lib/recording/types";
import type { PortMessageToPanel } from "@/types";

interface UseRecordingArgs {
  port: chrome.runtime.Port | null;
  sessionId: string | null;
  onFinished?: (skillId: string) => void;
}

interface FinishArgs {
  skillName: string;
  skillDescription: string;
  finalActions: RecordedAction[];
  finalAllowedTools: string[];
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
  finishRecording: (args: FinishArgs) => void;
  discardRecording: () => void;
}

export function useRecording({ port, sessionId, onFinished }: UseRecordingArgs): UseRecording {
  const [active, setActive] = useState(false);
  const [actions, setActions] = useState<RecordedAction[]>([]);
  const [lastAbortReason, setLastAbortReason] = useState<UseRecording["lastAbortReason"]>(null);

  const sessionRef = useRef(sessionId);
  const activeRef = useRef(false);

  // Auto-discard when session switches mid-recording.
  useEffect(() => {
    const prev = sessionRef.current;
    if (prev && sessionId !== prev && activeRef.current && port) {
      try {
        port.postMessage({ type: "recording-discard", sessionId: prev });
      } catch {
        // port may be already disconnected — non-fatal
      }
      setActive(false);
      activeRef.current = false;
      setActions([]);
      setLastAbortReason("session-switched");
    }
    sessionRef.current = sessionId;
  }, [sessionId, port]);

  // Listen for SW broadcasts. We share the per-session port owned by useSession;
  // the parent App passes the port reference once it's connected.
  useEffect(() => {
    if (!port) return;
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
        if (onFinished) onFinished(msg.skillId);
      } else if (msg.type === "recording-aborted") {
        setActive(false);
        activeRef.current = false;
        setActions([]);
        setLastAbortReason(msg.reason);
      }
    };
    port.onMessage.addListener(listener);
    return () => {
      try {
        port.onMessage.removeListener(listener);
      } catch {
        // port may already be closing — non-fatal
      }
    };
  }, [port, onFinished]);

  const startRecording = useCallback(() => {
    if (!port || !sessionId) return;
    try {
      port.postMessage({ type: "recording-start", sessionId });
    } catch {
      // non-fatal
    }
  }, [port, sessionId]);

  const finishRecording = useCallback(
    (args: FinishArgs) => {
      if (!port || !sessionId) return;
      try {
        port.postMessage({
          type: "recording-finish",
          sessionId,
          skillName: args.skillName,
          skillDescription: args.skillDescription,
          finalActions: args.finalActions,
          finalAllowedTools: args.finalAllowedTools,
        });
      } catch {
        // non-fatal
      }
    },
    [port, sessionId],
  );

  const discardRecording = useCallback(() => {
    if (!port || !sessionId) return;
    try {
      port.postMessage({ type: "recording-discard", sessionId });
    } catch {
      // non-fatal
    }
  }, [port, sessionId]);

  return {
    active,
    actions,
    lastAbortReason,
    startRecording,
    finishRecording,
    discardRecording,
  };
}
