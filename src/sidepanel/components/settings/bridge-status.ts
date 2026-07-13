// Local daemon bridge status query — shared by the Settings root page (badge)
// and the Bridge sub-page (LocalBridgeSection). Extracted from Settings.tsx so
// the root badge can read bridge state without pulling in the whole section.

import { useEffect, useState } from "react";

export type BridgeStatus = {
  hasPermission: boolean;
  ready: boolean;
  daemonVersion?: string | null;
  needsUpgrade?: boolean;
  protocolMismatch?: boolean;
};

// Ask the SW for live bridge status (nativeMessaging granted + connected to the
// daemon). Silently returns nothing when the SW is asleep / unresponsive — the
// panel keeps its last-known state.
export function queryBridgeStatus(cb: (s: BridgeStatus) => void): void {
  try {
    chrome.runtime.sendMessage({ type: "local-bridge:status" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && typeof res.hasPermission === "boolean") cb(res as BridgeStatus);
    });
  } catch {
    /* noop */
  }
}

// React hook wrapping `queryBridgeStatus` with polling. The bridge connects
// asynchronously (SW ↔ native host handshake), so a one-shot query at mount can
// miss the ready transition — callers must poll to observe connect/disconnect
// while the panel stays open. Both the Settings root badge and the Bridge
// sub-page's LocalBridgeSection share this so they never drift.
export function useBridgeStatus(intervalMs = 1500): BridgeStatus | null {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      queryBridgeStatus((s) => {
        if (alive) setStatus(s);
      });
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return status;
}
