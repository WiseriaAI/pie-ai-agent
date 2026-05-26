export type GeometryError =
  | { kind: "element-not-found"; index: number }
  | { kind: "element-not-visible"; index: number }
  | { kind: "frame-gone"; frameId: number }
  | { kind: "cdp-frame-id-unresolved"; frameId: number };

export type PagePoint = { x: number; y: number };

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Locates element by data-pie-idx, scrolls into view if needed,
 * returns its rect in frame-local coordinates.
 */
export function readRectByIdx(idx: number):
  | { x: number; y: number; w: number; h: number }
  | null {
  const el = document.querySelector(`[data-pie-idx="${idx}"]`);
  if (!el) return null;
  // scrollIntoViewIfNeeded is non-standard but widely supported in Chromium
  (el as unknown as { scrollIntoViewIfNeeded?: (arg: unknown) => void })
    .scrollIntoViewIfNeeded?.({ block: "center" });
  const r = (el as HTMLElement).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/**
 * Compute page-level coordinates for the center of an element by data-pie-idx.
 * For frameId === 0, returns the rect center directly (frame-local === page-level).
 * For frameId > 0, see Task 8 + 9 for iframe geometry (throws here for now).
 */
export async function elementToPagePoint(
  tabId: number,
  frameId: number,
  elementIndex: number,
): Promise<PagePoint | GeometryError> {
  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: readRectByIdx,
      args: [elementIndex],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Frame with ID .* not found|No frame with id/i.test(msg)) {
      return { kind: "frame-gone", frameId };
    }
    throw err;
  }
  const rect = injection[0]?.result as ReturnType<typeof readRectByIdx>;
  if (!rect) return { kind: "element-not-found", index: elementIndex };
  if (rect.w <= 0 || rect.h <= 0) return { kind: "element-not-visible", index: elementIndex };
  const center: PagePoint = {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
  };
  if (frameId === 0) return center;
  // iframe path filled in Task 9.
  throw new Error(`Iframe geometry not yet implemented (frameId=${frameId})`);
}
