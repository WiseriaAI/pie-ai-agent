import type { CdpSession } from "../../background/cdp-session";
import { actByIdxInjected } from "./act-core";

export type GeometryError =
  | { kind: "element-not-found"; index: number }
  | { kind: "element-not-visible"; index: number }
  | { kind: "frame-gone"; frameId: number }
  | { kind: "cdp-frame-id-unresolved"; frameId: number };

export type PagePoint = { x: number; y: number };

/**
 * Compute page-level coordinates for the center of an element by data-pie-idx.
 * For frameId === 0, returns the rect center directly (frame-local === page-level).
 * For frameId > 0, resolves chrome→CDP frame id and adds the iframe's
 * page-level top-left (via CDP DOM.getBoxModel) to the frame-local center.
 * Requires a cdpSession when frameId > 0; throws otherwise (caller bug).
 */
export async function elementToPagePoint(
  tabId: number,
  frameId: number,
  elementIndex: number,
  cdpSession?: CdpSession,
): Promise<PagePoint | GeometryError> {
  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: actByIdxInjected,
      args: [{ op: "rect", idx: elementIndex } as const],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Frame with ID .* not found|No frame with id/i.test(msg)) {
      return { kind: "frame-gone", frameId };
    }
    throw err;
  }
  const out = injection[0]?.result;
  const rect = out && out.ok && out.op === "rect" ? out.rect : null;
  if (!rect) return { kind: "element-not-found", index: elementIndex };
  if (rect.w <= 0 || rect.h <= 0) return { kind: "element-not-visible", index: elementIndex };
  const center: PagePoint = {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
  };
  if (frameId === 0) return center;

  if (!cdpSession) {
    throw new Error("elementToPagePoint: iframe geometry requires cdpSession");
  }
  const { frameTree } = (await cdpSession.send("Page.getFrameTree")) as {
    frameTree: CdpFrameTreeNode;
  };
  const cdpFrameId = await resolveChromeToCdpFrameId(tabId, frameId, frameTree);
  if (!cdpFrameId) return { kind: "cdp-frame-id-unresolved", frameId };

  const { nodeId } = (await cdpSession.send("DOM.getNodeForFrameOwner", {
    frameId: cdpFrameId,
  })) as { nodeId: number };

  const { model } = (await cdpSession.send("DOM.getBoxModel", { nodeId })) as {
    model: { content: number[] };
  };
  // content = [x1,y1, x2,y2, x3,y3, x4,y4]; (x1,y1) is top-left
  const iframeOriginX = model.content[0];
  const iframeOriginY = model.content[1];

  return {
    x: iframeOriginX + center.x,
    y: iframeOriginY + center.y,
  };
}

export interface CdpFrame {
  id: string;
  url: string;
  parentId?: string;
}

export interface CdpFrameTreeNode {
  frame: CdpFrame;
  childFrames?: CdpFrameTreeNode[];
}

interface ChromeFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
}

/**
 * Map a chrome.webNavigation frameId to a CDP frame id by walking both
 * trees in parallel, matching by (parentMatch, url). Same-URL siblings
 * are disambiguated by DOM order (sibling index in parent's child list).
 *
 * Returns null when no match (e.g. frame closed between read_page and
 * this call). Caller produces cdp-frame-id-unresolved error.
 */
export async function resolveChromeToCdpFrameId(
  tabId: number,
  chromeFrameId: number,
  cdpFrameTree: CdpFrameTreeNode,
): Promise<string | null> {
  if (chromeFrameId === 0) return cdpFrameTree.frame.id;

  const chromeFrames = (await chrome.webNavigation.getAllFrames({ tabId })) as ChromeFrame[];
  const chromeById = new Map(chromeFrames.map((f) => [f.frameId, f]));

  // Compute chrome ancestry path (root → target).
  const chromePath: ChromeFrame[] = [];
  let cur: ChromeFrame | undefined = chromeById.get(chromeFrameId);
  while (cur && cur.frameId !== 0) {
    chromePath.unshift(cur);
    cur = chromeById.get(cur.parentFrameId);
  }
  if (!cur) return null; // disconnected from root

  // Walk CDP tree from root, matching each level.
  let node: CdpFrameTreeNode = cdpFrameTree;
  for (const chromeChild of chromePath) {
    const candidates = (node.childFrames ?? []).filter(
      (c) => c.frame.url === chromeChild.url,
    );
    if (candidates.length === 0) return null;
    // Same-URL siblings: pick by index among chrome siblings with same URL.
    const chromeSiblings = chromeFrames.filter(
      (f) => f.parentFrameId === chromeChild.parentFrameId && f.url === chromeChild.url,
    );
    const siblingIndex = chromeSiblings.findIndex((f) => f.frameId === chromeChild.frameId);
    node = candidates[siblingIndex] ?? candidates[0];
  }
  return node.frame.id;
}
