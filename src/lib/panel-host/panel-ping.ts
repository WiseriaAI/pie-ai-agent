// A liveness ping the panel document answers — the detection signal of last
// resort.
//
// `chrome.runtime.getContexts` is the precise way to ask whether a SIDE_PANEL
// document exists, but it is Chrome 116+ and a fork may simply not implement
// it. Treating "can't measure" as "works fine" is the safe default for a
// healthy browser and exactly the wrong answer for the broken one this whole
// module exists for, so there needs to be a second signal that works
// everywhere.
//
// A reply to this ping proves a panel document is running: it means real
// JavaScript, in a real extension page, executed and answered. Nothing about
// that can be faked by a browser resolving a promise it has no intention of
// honouring — which is the failure mode that defeated every other check.
//
// Deliberately coarse: it cannot tell a side panel from an already-open
// fallback window. That is fine. Both mean a panel is on screen, and both mean
// there is nothing to open.

export const PANEL_PING_MESSAGE = "pie:panel-ping";

type PingResponse = { pong: true } | undefined;

/**
 * Register the panel-side responder.
 *
 * Must be called at module scope, before React mounts: the probe runs within a
 * couple of seconds of the panel being asked to open, and a listener that only
 * appears after the app has rendered would lose that race on a slow machine
 * and report a working panel as missing.
 */
export function installPanelPingResponder(): void {
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: unknown } | null)?.type !== PANEL_PING_MESSAGE) return;
      sendResponse({ pong: true });
      // No `return true` — answered synchronously, so the channel can close.
    });
  } catch {
    /* not an extension context (unit tests) — nothing to answer with */
  }
}

/**
 * Ask whether any panel document is alive.
 *
 * Distinguishes three cases that all have to collapse to a boolean:
 *   - rejection  → no listeners at all, so no panel;
 *   - `undefined`→ some other context answered the broadcast (the offscreen
 *     PDF document also listens) but no panel did;
 *   - `{pong}`   → a panel is running.
 */
export async function panelDocumentResponds(): Promise<boolean> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      type: PANEL_PING_MESSAGE,
    })) as PingResponse;
    return reply?.pong === true;
  } catch {
    // "Could not establish connection. Receiving end does not exist."
    return false;
  }
}
