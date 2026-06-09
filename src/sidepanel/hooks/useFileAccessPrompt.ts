import { useEffect, useState } from "react";
import type { PortMessageToPanel } from "@/types/messages";

interface State {
  showCard: boolean;
  dismiss: () => void;
}

/**
 * Listens for `needs-file-access` messages from the SW on the given
 * session port and surfaces a flag that drives <FileAccessCard />.
 *
 * Pattern mirrors useCdpOnboarding — the SW iterates all portsBySession
 * entries and posts the message to every connected sidepanel. Fired both
 * when the user navigates to a local PDF tab and when read_local_file is
 * called without 'Allow access to file URLs' granted.
 */
export function useFileAccessPrompt(port: chrome.runtime.Port | null): State {
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    if (!port) return;
    const listener = (msg: PortMessageToPanel) => {
      if (msg.type === "needs-file-access") setShowCard(true);
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port]);

  return { showCard, dismiss: () => setShowCard(false) };
}
