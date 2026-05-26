import { useEffect, useState, useCallback } from "react";

interface State {
  pending: boolean;
  answer: (enabled: boolean) => void;
}

export function useCdpOnboarding(
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
      if (m.type === "cdp-onboarding-request") setPending(true);
      if (m.type === "cdp-onboarding-resolved") setPending(false);
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port, sessionId]);

  const answer = useCallback(
    (enabled: boolean) => {
      if (!port || !sessionId) return;
      port.postMessage({
        type: "cdp-onboarding-response",
        sessionId,
        enabled,
      });
      setPending(false);
    },
    [port, sessionId],
  );

  return { pending, answer };
}
