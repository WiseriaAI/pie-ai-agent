import { useEffect, useState } from "react";
import type { PortMessageToPanel } from "@/types/messages";

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
    const listener = (msg: PortMessageToPanel) => {
      if (msg.type === "pdf:needs-file-access") setShowCard(true);
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port]);

  return { showCard, dismiss: () => setShowCard(false) };
}
