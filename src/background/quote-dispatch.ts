import type { QuoteAddedMessage } from "@/types";

// When user clicks the in-page quote bubble while side panel is closed,
// chrome.sidePanel.open() boots the panel async — but the SW already
// runs quote-bridge and tries to broadcast quote-added before the panel
// has connected its port. Without a buffer, the chip is silently dropped
// and only the *next* bubble click (after panel is up) lands.
//
// Strategy: if `portsBySession` is empty at dispatch time, stash the
// quote in a short queue. The next port that connects drains the queue
// into its own sessionId — which is exactly the session the user landed
// in after sidePanel.open(), so the chip ends up in the right composer.

type PendingQuote = Omit<QuoteAddedMessage, "sessionId">;

// Cap protects against extreme bubble-mash before panel boots. 8 covers
// realistic burst (panel mount is sub-second); past that we drop quietly.
const PENDING_LIMIT = 8;

const pending: PendingQuote[] = [];

/**
 * Returns `true` when the quote was stashed (no live port to deliver to),
 * `false` when it was broadcast to at least one connected port.
 *
 * The stashed signal lets the caller wake an *already-open but
 * port-dead* panel: when the SW idles/restarts, the side panel document
 * stays mounted on the user's current session but its streaming port is
 * silently dropped (lazy-reconnect only fires on the next send). A quote
 * captured in that window would otherwise sit in `pending` until some
 * unrelated port connects (typically a freshly-opened blank session) and
 * drains it to the wrong place. The caller broadcasts a runtime message
 * (which does NOT need the dead port) so the live panel reconnects its
 * current session's port and the drain lands where the user is looking.
 */
export function dispatchQuoteAdded(
  out: PendingQuote,
  ports: Map<string, chrome.runtime.Port>,
): boolean {
  if (ports.size === 0) {
    if (pending.length < PENDING_LIMIT) pending.push(out);
    return true;
  }
  for (const [sessionId, port] of ports.entries()) {
    try { port.postMessage({ ...out, sessionId }); } catch { /* port closed */ }
  }
  return false;
}

export function drainPendingQuotesToPort(
  sessionId: string,
  port: chrome.runtime.Port,
): void {
  if (pending.length === 0) return;
  for (const out of pending) {
    try { port.postMessage({ ...out, sessionId }); } catch { /* port closed */ }
  }
  pending.length = 0;
}

export function __resetPendingForTest(): void {
  pending.length = 0;
}

export function __pendingLengthForTest(): number {
  return pending.length;
}
