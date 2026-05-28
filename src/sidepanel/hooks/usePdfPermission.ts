import { useEffect, useState } from "react";

interface State {
  showCard: boolean;
  dismiss: () => void;
}

/**
 * Listens for `pdf:needs-file-access` messages from the SW on the given
 * session port and surfaces a flag that drives <PdfPermissionCard />.
 *
 * Pattern mirrors useCdpOnboarding — the SW iterates all portsBySession
 * entries and posts the message to every connected sidepanel.
 */
export function usePdfPermission(port: chrome.runtime.Port | null): State {
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    if (!port) return;
    const listener = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: string };
      if (m.type === "pdf:needs-file-access") setShowCard(true);
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port]);

  return { showCard, dismiss: () => setShowCard(false) };
}
