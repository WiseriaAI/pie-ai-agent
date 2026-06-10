import { actByIdxInjected } from "./act-core";

export type GeometryError =
  | { kind: "element-not-found"; index: number }
  | { kind: "element-not-visible"; index: number };

export type PagePoint = { x: number; y: number };

/**
 * Compute viewport coordinates for the center of a TOP-FRAME element by
 * data-pie-idx (scrolled into view first by the rect op). Subframe clicks
 * never use CDP geometry — they run in-frame synthetic clicks (see
 * tools/mouse.ts) — so this function only targets frame 0 and needs no
 * chrome↔CDP frame mapping.
 */
export async function elementToPagePoint(
  tabId: number,
  elementIndex: number,
): Promise<PagePoint | GeometryError> {
  const injection = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: actByIdxInjected,
    args: [{ op: "rect", idx: elementIndex } as const],
  });
  const out = injection[0]?.result;
  const rect = out && out.ok && out.op === "rect" ? out.rect : null;
  if (!rect) return { kind: "element-not-found", index: elementIndex };
  if (rect.w <= 0 || rect.h <= 0) return { kind: "element-not-visible", index: elementIndex };
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}
