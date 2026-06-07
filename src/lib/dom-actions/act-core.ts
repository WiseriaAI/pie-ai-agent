/**
 * act-core.ts — Shadow-aware element locator + op-dispatched DOM actions.
 *
 * Self-contained constraint: `actByIdxInjected` is injected via
 * chrome.scripting.executeScript — no imports may be used inside the function
 * body at runtime. All helpers are nested inside the exported function.
 *
 * op=rect: implemented (used by CDP mouse-click geometry)
 * op=type / select / focusClick: stubbed — implemented in Tasks 6-7
 */

export type ActParams =
  | { op: "rect"; idx: number }
  | { op: "focusClick"; idx: number }
  | { op: "type"; idx: number; text: string; clear: boolean }
  | { op: "select"; idx: number; value: string };

export type ActResult =
  | { ok: true; op: "rect"; rect: { x: number; y: number; w: number; h: number } }
  | { ok: false; error: string };

export async function actByIdxInjected(params: ActParams): Promise<ActResult> {
  // Shadow-DOM-aware locator: walks open shadow roots recursively.
  // document.querySelector('[data-pie-idx=N]') does NOT pierce shadow roots,
  // but probe-core.ts stamps elements inside shadow trees — this closes the gap.
  function findByIdxDeep(idx: number): Element | null {
    const sel = `[data-pie-idx="${idx}"]`;

    function search(root: Document | ShadowRoot): Element | null {
      const direct = root.querySelector(sel);
      if (direct) return direct;

      const all = root.querySelectorAll("*");
      for (const el of all) {
        const sr = (el as Element).shadowRoot;
        if (sr && sr.mode === "open") {
          const found = search(sr);
          if (found) return found;
        }
      }
      return null;
    }

    return search(document);
  }

  const el = findByIdxDeep(params.idx);
  if (!el) {
    return {
      ok: false,
      error: `Element not found at index ${params.idx}. The page may have changed; try snapshotting again.`,
    };
  }

  if (params.op === "rect") {
    // Scroll element into view before reading geometry so CDP clicks land correctly.
    (el as unknown as { scrollIntoViewIfNeeded?: (a: unknown) => void }).scrollIntoViewIfNeeded?.({
      block: "center",
    });
    const r = (el as HTMLElement).getBoundingClientRect();
    return { ok: true, op: "rect", rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }

  // type / select / focusClick — implemented in Tasks 6-7
  return { ok: false, error: "unimplemented op" };
}
