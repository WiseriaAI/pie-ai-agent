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

export function dispatchQuoteAdded(
  out: PendingQuote,
  ports: Map<string, chrome.runtime.Port>,
): void {
  if (ports.size === 0) {
    if (pending.length < PENDING_LIMIT) pending.push(out);
    return;
  }
  for (const [sessionId, port] of ports.entries()) {
    try { port.postMessage({ ...out, sessionId }); } catch { /* port closed */ }
  }
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
