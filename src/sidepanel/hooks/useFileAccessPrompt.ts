import { useEffect, useState } from "react";
import { swPort } from "@/lib/sw-connection/manager";
import type { PortMessageToPanel } from "@/types/messages";

interface State {
  showCard: boolean;
  dismiss: () => void;
}

/**
 * Listens for `needs-file-access` messages from the SW on the given
 * session's swPort subscription and surfaces a flag that drives
 * <FileAccessCard />.
 *
 * Pattern mirrors useCdpOnboarding — the SW iterates all portsBySession
 * entries and posts the message to every connected sidepanel. Fired both
 * when the user navigates to a local PDF tab and when read_local_file is
 * called without 'Allow access to file URLs' granted.
 *
 * SW 连接服务 cutover：不再收 `port` prop；订阅经 `swPort.connect`（重连安全）。
 */
export function useFileAccessPrompt(sessionId: string | null): State {
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    const listener = (msg: PortMessageToPanel) => {
      if (msg.type === "needs-file-access") setShowCard(true);
    };
    const unsubscribe = swPort.connect(sessionId, { onMessage: listener });
    return unsubscribe;
  }, [sessionId]);

  return { showCard, dismiss: () => setShowCard(false) };
}
