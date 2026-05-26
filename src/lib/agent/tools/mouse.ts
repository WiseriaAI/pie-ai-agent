import { isCdpInputEnabled } from "@/lib/cdp-input-enabled";
import type { CdpSession } from "@/background/cdp-session";
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { elementToPagePoint, type GeometryError } from "@/lib/dom-actions/geometry";

/**
 * Internal: dispatch a single CDP mouse event at the given page coords.
 */
export async function dispatchMouseAt(
  session: CdpSession,
  x: number,
  y: number,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    clickCount: type === "mouseMoved" ? 0 : 1,
    pointerType: "mouse",
  });
}

export type CdpGateResult = { ok: true } | { ok: false; error: string };

interface RequireCdpInputArgs {
  sessionId: string;
  requestConsent: (sessionId: string) => Promise<boolean>;
}

/**
 * Tri-state gate for CDP-dependent tools. Reads cdp_input_enabled:
 *   - true → ok=true
 *   - false → ok=false, error="disabled in Settings"
 *   - undefined → invoke requestConsent (inline guide); true→ok, false/throw→error
 */
export interface MouseToolDeps {
  /**
   * Lazy attach (or reuse) a CdpSession bound to this task.
   * Curried by runAgentLoop with the task's signal/ownerToken.
   */
  acquireSession: (tabId: number) => Promise<CdpSession>;
  /**
   * Session id for the current chat task — used to route the inline
   * consent guide through the correct sidepanel port.
   */
  sessionId: string;
  /**
   * Trigger sidepanel consent flow when the flag is unset (undefined).
   * Bound to requestCdpInputConsent in loop.ts.
   */
  requestConsent: (sessionId: string) => Promise<boolean>;
}

function geometryErrorToActionResult(e: GeometryError): ActionResult {
  switch (e.kind) {
    case "element-not-found":
      return {
        success: false,
        error: `Element not found at index ${e.index}. Page changed; call read_page again.`,
      };
    case "element-not-visible":
      return {
        success: false,
        error: `Element [${e.index}] has zero size (display:none / removed from layout). Call read_page again.`,
      };
    case "frame-gone":
      return {
        success: false,
        error: `Frame ${e.frameId} unreachable; re-snapshot.`,
      };
    case "cdp-frame-id-unresolved":
      return {
        success: false,
        error: `Internal: frame mapping failed for frameId ${e.frameId}. Try in top frame.`,
      };
    default: {
      // Exhaustiveness check — if GeometryError gains a new kind, this
      // triggers a compile error so the mapping must be updated.
      const _exhaustive: never = e;
      throw new Error(`Unhandled GeometryError kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function buildHoverTool(deps: MouseToolDeps): Tool {
  return {
    name: "hover",
    description:
      "Hover the mouse over an element by its data-pie-idx from the most recent read_page. Use this when an element shows new content on mouseover (dropdown menus, tooltips, hover cards). After hovering, call read_page again to see any newly revealed elements.",
    parameters: {
      type: "object",
      properties: {
        frameId: { type: "number", description: "Frame ID from latest read_page." },
        elementIndex: { type: "number", description: "data-pie-idx of the element." },
      },
      required: ["frameId", "elementIndex"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number };

      const gate = await requireCdpInput({
        sessionId: deps.sessionId,
        requestConsent: deps.requestConsent,
      });
      if (!gate.ok) return { success: false, error: gate.error };

      let session: CdpSession;
      try {
        session = await deps.acquireSession(ctx.tabId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Another debugger|conflict/i.test(msg)) {
          return {
            success: false,
            error: `CDP attach failed: another debugger is attached to this tab (DevTools or another agent task). Close it and retry.`,
          };
        }
        return { success: false, error: `CDP attach failed: ${msg}` };
      }

      const point = await elementToPagePoint(ctx.tabId, a.frameId, a.elementIndex, session);
      if ("kind" in point) return geometryErrorToActionResult(point);

      await dispatchMouseAt(session, point.x, point.y, "mouseMoved");
      return {
        success: true,
        observation: `Hovered [${a.elementIndex}] at (${Math.round(point.x)},${Math.round(point.y)}). New content may have appeared; call read_page to observe.`,
      };
    },
  };
}

export function buildClickTool(deps: MouseToolDeps): Tool {
  return {
    name: "click",
    description:
      "Click an interactive element by its data-pie-idx from the most recent read_page. Uses real mouse events (CDP). If the element is gone (page changed), returns 'Element not found'; call read_page again to get current indices.",
    parameters: {
      type: "object",
      properties: {
        frameId: { type: "number", description: "Frame ID from latest read_page." },
        elementIndex: { type: "number", description: "data-pie-idx of the element." },
      },
      required: ["frameId", "elementIndex"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number };

      const gate = await requireCdpInput({
        sessionId: deps.sessionId,
        requestConsent: deps.requestConsent,
      });
      if (!gate.ok) return { success: false, error: gate.error };

      let session: CdpSession;
      try {
        session = await deps.acquireSession(ctx.tabId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Another debugger|conflict/i.test(msg)) {
          return {
            success: false,
            error: `CDP attach failed: another debugger is attached to this tab (DevTools or another agent task). Close it and retry.`,
          };
        }
        return { success: false, error: `CDP attach failed: ${msg}` };
      }

      const point = await elementToPagePoint(ctx.tabId, a.frameId, a.elementIndex, session);
      if ("kind" in point) return geometryErrorToActionResult(point);

      await dispatchMouseAt(session, point.x, point.y, "mouseMoved");
      await dispatchMouseAt(session, point.x, point.y, "mousePressed");
      await dispatchMouseAt(session, point.x, point.y, "mouseReleased");

      return {
        success: true,
        observation: `Clicked [${a.elementIndex}] at (${Math.round(point.x)},${Math.round(point.y)}).`,
      };
    },
  };
}

export async function requireCdpInput(
  args: RequireCdpInputArgs,
): Promise<CdpGateResult> {
  const flag = await isCdpInputEnabled();
  if (flag === true) return { ok: true };
  if (flag === false) {
    return {
      ok: false,
      error: "CDP input is disabled in Settings. Cannot click/hover.",
    };
  }
  // undefined — request consent
  try {
    const granted = await args.requestConsent(args.sessionId);
    if (granted) return { ok: true };
    return {
      ok: false,
      error: "CDP input is disabled in Settings. Cannot click/hover.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Onboarding cancelled/i.test(msg)) {
      return { ok: false, error: "Onboarding cancelled (panel closed)." };
    }
    return { ok: false, error: `CDP consent error: ${msg}` };
  }
}
