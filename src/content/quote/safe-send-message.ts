// chrome.runtime.sendMessage from an orphaned content-script (extension
// reloaded, SW gone) either throws synchronously ("Extension context
// invalidated") or resolves to a Promise that rejects. Both paths used
// to be silently swallowed by `void chrome.runtime.sendMessage(...)`.
// Surface them as console.error so devs see why nothing happened —
// v1.1 SW startup reinject handles the auto-heal path; this is the
// fallback for edge cases (tab opened after reload but before reinject
// finishes, or a tab the reinject couldn't reach).

const ORPHAN_MESSAGE = "[Pie] orphaned content script — refresh this tab to restore quoting";

export function safeSendMessage(msg: unknown): void {
  try {
    const p = chrome.runtime.sendMessage(msg) as unknown;
    if (p && typeof (p as Promise<unknown>).catch === "function") {
      (p as Promise<unknown>).catch((err: unknown) => {
        console.error(ORPHAN_MESSAGE, err);
      });
    }
  } catch (e) {
    console.error(ORPHAN_MESSAGE, e);
  }
}
