// Right-click entry point for opening Pie in its own window.
//
// The keyboard command that does the same thing needs a hotkey bound at
// chrome://extensions/shortcuts — a page a browser with its own custom UI may
// not even expose, which makes it useless as a rescue path on exactly the
// browsers that need rescuing. A context-menu item needs no setup and no
// toolbar, so it works even when the panel can't be opened to reach a setting.
//
// Offered on every browser rather than only when the side panel is known
// broken: gating it on the capability verdict would hide it in precisely the
// case where detection is wrong, which is the case it exists for. On a healthy
// browser it is simply a way to pop the panel out into its own window.
//
// Registration only — the click handler lives with the orchestration in
// `panel-open.ts`, so this module has no dependency on the fallback path.

import { makeT, resolveLocale } from "@/lib/i18n";

/** Context-menu id for the manual "pop Pie out" entry. */
export const FALLBACK_MENU_ID = "pie-open-panel-window";

export function installPanelContextMenu(): void {
  void (async () => {
    // Localized: this is user-visible browser chrome, and it shares the string
    // with the Settings toggle so the docs for either route read identically in
    // every locale.
    let title = "Open Pie in a separate window";
    try {
      title = makeT(await resolveLocale())("settings.panelWindow.title");
    } catch {
      /* locale unresolvable — the English default above still works */
    }
    try {
      chrome.contextMenus?.removeAll(() => {
        // Swallow "duplicate id" if two startup paths race.
        void chrome.runtime.lastError;
        chrome.contextMenus.create({ id: FALLBACK_MENU_ID, title, contexts: ["all"] }, () => {
          void chrome.runtime.lastError;
        });
      });
    } catch {
      /* contextMenus unavailable — the toolbar and Settings paths remain */
    }
  })();
}
