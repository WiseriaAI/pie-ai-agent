import { useEffect, useState, useCallback } from "react";

export type LocalFileResponse =
  | { ok: true; name: string; mime: string; text: string; truncated: boolean }
  | { ok: false; reason: string };

interface State {
  /** True while the SW is awaiting a file pick for this session. */
  pending: boolean;
  /** Post the user's file (or a cancel/unsupported reason) back to the SW. */
  respond: (r: LocalFileResponse) => void;
}

/**
 * Panel side of the `request_local_file` round-trip. Mirrors useCdpOnboarding:
 * listens for the SW's `request-local-file` message on the per-session port and
 * flips `pending`; `respond` posts `local-file-response` back and clears.
 */
export function useLocalFileRequest(
  port: chrome.runtime.Port | null,
  sessionId: string | null,
): State {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!port || !sessionId) return;
    const listener = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: string; sessionId?: string };
      if (m.sessionId !== sessionId) return;
      if (m.type === "request-local-file") setPending(true);
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port, sessionId]);

  // Reset pending when switching sessions so a stale card never lingers.
  useEffect(() => {
    setPending(false);
  }, [sessionId]);

  const respond = useCallback(
    (r: LocalFileResponse) => {
      if (!port || !sessionId) return;
      port.postMessage({ type: "local-file-response", sessionId, ...r });
      setPending(false);
    },
    [port, sessionId],
  );

  return { pending, respond };
}
