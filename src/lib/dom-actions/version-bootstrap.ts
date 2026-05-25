/**
 * Self-contained injected function. Installs window.__pieFrameVersion__ + a
 * MutationObserver that increments it on each (debounced) mutation batch.
 *
 * Idempotent: re-injection is a no-op when the observer is already installed.
 * The observer is NOT composed; mutations inside shadow roots will not trigger
 * version bumps (known trade-off documented in spec).
 *
 * The injected function also sends frame-version-bump messages to the SW;
 * the SW listens via chrome.runtime.onMessage (registered in Task 2.2).
 */
export function versionBootstrapInjected(): { installed: boolean } {
  if ((window as any).__pieFrameObserver__) {
    return { installed: false };
  }
  if (typeof (window as any).__pieFrameVersion__ !== "number") {
    (window as any).__pieFrameVersion__ = 0;
  }
  const DEBOUNCE_MS = 150;
  let timer: number | null = null;
  const observer = new MutationObserver(() => {
    if (timer !== null) return;
    timer = (window as any).setTimeout(() => {
      timer = null;
      (window as any).__pieFrameVersion__ = ((window as any).__pieFrameVersion__ ?? 0) + 1;
      try {
        chrome.runtime?.sendMessage({
          type: "pie/frame-version-bump",
          version: (window as any).__pieFrameVersion__,
        });
      } catch {
        // Service worker may be asleep; SW will catch up at next read_page.
      }
    }, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  (window as any).__pieFrameObserver__ = observer;
  return { installed: true };
}
