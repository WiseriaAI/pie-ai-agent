import { showBubble, hideBubble } from "./floating-bubble";
import { safeSendMessage } from "./safe-send-message";

// Stale-listener handle: after extension reload + SW reinject, the OLD
// content-script instance's event listeners are still attached to window.
// A new instance can't access the old closure to remove them, so we park
// the handler refs on `window` itself for a cross-instance handoff.
interface PieQuoteWindow extends Window {
  __pieQuoteHandlers?: {
    mouseup: EventListener;
    selectionchange: EventListener;
  };
}

let attached = false;

function handleSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    hideBubble();
    return;
  }
  const text = sel.toString().trim();
  if (text.length === 0) {
    hideBubble();
    return;
  }
  const range = sel.getRangeAt(sel.rangeCount - 1);
  // getBoundingClientRect 返回整个 range 的并集 bbox，多行/跨段时 right/top 会飘到最右上角
  // 而不是结束 cursor 那行。用 getClientRects() 最后一个 rect = end cursor 所在行。
  const rects = range.getClientRects();
  const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
  showBubble({
    anchorTop: rect.top,
    anchorLeft: rect.right,
    onClick: () => {
      safeSendMessage({
        type: "quote-text-captured",
        payload: { text, sourceUrl: location.href },
      });
    },
  });
}

function onMouseUp(): void {
  setTimeout(handleSelection, 0);
}

function onSelectionChange(): void {
  handleSelection();
}

export function attachSelectionListener(): void {
  if (attached) return;
  const w = window as PieQuoteWindow;
  const stale = w.__pieQuoteHandlers;
  if (stale) {
    window.removeEventListener("mouseup", stale.mouseup);
    document.removeEventListener("selectionchange", stale.selectionchange);
  }
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("selectionchange", onSelectionChange);
  w.__pieQuoteHandlers = { mouseup: onMouseUp, selectionchange: onSelectionChange };
  attached = true;
}

export function detachSelectionListener(): void {
  window.removeEventListener("mouseup", onMouseUp);
  document.removeEventListener("selectionchange", onSelectionChange);
  hideBubble();
  delete (window as PieQuoteWindow).__pieQuoteHandlers;
  attached = false;
}
