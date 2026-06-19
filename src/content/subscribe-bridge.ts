// Bridge between the Pie marketing site (pie.chat) and the extension.
// The site marks its "Subscribe" CTAs with [data-pie-subscribe] and keeps a
// Chrome Web Store href as the no-extension fallback. When the extension IS
// installed, this content script intercepts the click, cancels the store
// navigation, and asks the SW to open the side panel on the managed-subscribe
// screen. Sending the message synchronously inside the click handler preserves
// the user gesture chrome.sidePanel.open requires (same trick the quote bubble
// uses; see background/index.ts "quote-text-captured").
import { safeSendMessage } from "./quote/safe-send-message";

// Gate by host: the marker only lives on pie.chat, but a document-level click
// listener on every page is needless surface — and would let any site open the
// user's side panel via the attribute. Restrict to the marketing site (plus
// localhost for `python3 -m http.server` previews).
const ALLOWED_HOSTS = new Set(["pie.chat", "www.pie.chat", "localhost", "127.0.0.1"]);

let clickHandler: EventListener | null = null;

export function attachSubscribeBridge(): void {
  if (!ALLOWED_HOSTS.has(location.hostname)) return;
  if (clickHandler) return; // idempotent
  clickHandler = (e: Event) => {
    const el = e.target as Element | null;
    if (!el?.closest?.("[data-pie-subscribe]")) return;
    e.preventDefault();
    safeSendMessage({ type: "open-managed-subscribe" });
  };
  document.addEventListener("click", clickHandler, true);
}

export function detachSubscribeBridge(): void {
  if (!clickHandler) return;
  document.removeEventListener("click", clickHandler, true);
  clickHandler = null;
}
