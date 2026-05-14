import { showBubble, hideBubble } from "./floating-bubble";

let attached = false;

function onMouseUp(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const text = sel.toString().trim();
  if (text.length === 0) {
    hideBubble();
    return;
  }
  const range = sel.getRangeAt(sel.rangeCount - 1);
  const rect = range.getBoundingClientRect();
  showBubble({
    anchorTop: rect.top,
    anchorLeft: rect.right,
    onClick: () => {
      void chrome.runtime.sendMessage({
        type: "quote-text-captured",
        payload: { text, sourceUrl: location.href },
      });
    },
  });
}

function onSelectionChange(): void {
  const sel = window.getSelection();
  if (!sel || sel.toString().trim().length === 0) {
    hideBubble();
  }
}

export function attachSelectionListener(): void {
  if (attached) return;
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("selectionchange", onSelectionChange);
  attached = true;
}

export function detachSelectionListener(): void {
  window.removeEventListener("mouseup", onMouseUp);
  document.removeEventListener("selectionchange", onSelectionChange);
  hideBubble();
  attached = false;
}
