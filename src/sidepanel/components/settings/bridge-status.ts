// Local daemon bridge status query — shared by the Settings root page (badge)
// and the Bridge sub-page (LocalBridgeSection). Extracted from Settings.tsx so
// the root badge can read bridge state without pulling in the whole section.

export type BridgeStatus = { hasPermission: boolean; ready: boolean };

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
