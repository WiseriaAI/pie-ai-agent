import { isCdpInputEnabled } from "@/lib/cdp-input-enabled";
import type { CdpSession } from "@/background/cdp-session";
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { elementToPagePoint, type GeometryError } from "@/lib/dom-actions/geometry";
import { execActInTab } from "@/lib/dom-actions/exec-act";
import { withActionSettle } from "../wait-for-settle";

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
      `Hover the mouse over an element by its data-pie-idx from the latest read_page <interactive_index>. Uses real mouse events (CDP). After hovering, call read_page again to see any newly revealed elements.

USE WHEN:
- An element reveals new content on mouseover — dropdown menus, tooltips, hover cards.

**Top frame only** (frameId 0). Hover is not supported inside iframes — click directly, or re-run read_page to check whether the content is already visible.

**DO NOT USE WHEN:**
- You want to activate or open the element — use click.`,
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from the latest read_page <interactive_index>.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the element from the latest read_page <interactive_index>.",
        },
      },
      required: ["frameId", "elementIndex"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      // Models sometimes send frameId as a JSON string ("5"); coerce before
      // routing. undefined/NaN → 0 (CDP top-frame path).
      const a = args as { frameId: number | string; elementIndex: number };
      const rawFrameId = Number(a.frameId);
      const frameId = Number.isFinite(rawFrameId) ? rawFrameId : 0;

      if (frameId !== 0) {
        return {
          success: false,
          error:
            "hover is only supported in the top frame for now. For elements inside iframes, try clicking directly, or use read_page to check whether the target content is already visible.",
        };
      }

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

      return withActionSettle(ctx.tabId, async () => {
        const point = await elementToPagePoint(ctx.tabId, a.elementIndex);
        if ("kind" in point) return geometryErrorToActionResult(point);

        await dispatchMouseAt(session, point.x, point.y, "mouseMoved");
        return {
          success: true,
          observation: `Hovered [${a.elementIndex}] at (${Math.round(point.x)},${Math.round(point.y)}). New content may have appeared; call read_page to observe.`,
        };
      });
    },
  };
}

export function buildClickTool(deps: MouseToolDeps): Tool {
  return {
    name: "click",
    description:
      `Click an interactive element by its data-pie-idx from the latest read_page <interactive_index>. If the element is gone (page changed), returns 'Element not found' — call read_page({mode:"interactive"}) again for current indices.
Top-frame elements (frameId 0) get real mouse events (CDP). Elements inside iframes (frameId > 0) get synthetic in-frame events — works on virtually all sites, but controls demanding trusted input may ignore it.

USE WHEN:
- You need to activate a clickable element — button, link, checkbox, radio, menu item, tab.

**DO NOT USE WHEN:**
- You want to enter text — use type (or set_editor_value / dispatch_keyboard_input for editors).
- You want to pick a native <select> option — use select.
- You only need to reveal hover content — use hover.`,
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from the latest read_page <interactive_index>.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the element from the latest read_page <interactive_index>.",
        },
      },
      required: ["frameId", "elementIndex"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      // Models sometimes send frameId as a JSON string ("5"); coerce before
      // routing. undefined/NaN → 0 (CDP top-frame path).
      const a = args as { frameId: number | string; elementIndex: number };
      const rawFrameId = Number(a.frameId);
      const frameId = Number.isFinite(rawFrameId) ? rawFrameId : 0;

      if (frameId !== 0) {
        // Subframe path — in-frame synthetic click. No CDP: the chrome↔CDP
        // frame mapping was the broken link (OOPIF frames invisible to the
        // root session). executeScript reaches exactly the frames read_page
        // can snapshot, so anything the agent can see it can click.
        // Settle signals are top-frame scoped: the mutation tracker injects at
        // {tabId} and nav events with frameId!==0 are ignored — in-iframe-only
        // updates just ride out the quiet floor.
        return withActionSettle(ctx.tabId, async () => {
          const result = await execActInTab(
            ctx.tabId,
            { op: "click", idx: a.elementIndex },
            frameId,
          );
          if (!result.ok) return { success: false, error: result.error };
          return {
            success: true,
            observation: `Clicked [${a.elementIndex}] in frame ${frameId} via synthetic events (real mouse input is top-frame only). If the page did not react, the control may require trusted input.`,
          };
        });
      }

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

      return withActionSettle(ctx.tabId, async () => {
        const point = await elementToPagePoint(ctx.tabId, a.elementIndex);
        if ("kind" in point) return geometryErrorToActionResult(point);

        await dispatchMouseAt(session, point.x, point.y, "mouseMoved");
        await dispatchMouseAt(session, point.x, point.y, "mousePressed");
        await dispatchMouseAt(session, point.x, point.y, "mouseReleased");

        return {
          success: true,
          observation: `Clicked [${a.elementIndex}] at (${Math.round(point.x)},${Math.round(point.y)}).`,
        };
      });
    },
  };
}

export async function requireCdpInput(
  args: RequireCdpInputArgs,
): Promise<CdpGateResult> {
  const flag = await isCdpInputEnabled();
  if (flag === true) return { ok: true };
  // undefined (never configured) OR false (previously disabled) — both prompt
  // the user to enable CDP input now. Re-prompting on `false` is intentional:
  // when a task genuinely needs CDP we let the user authorize on the spot
  // instead of dead-ending and asking them to go dig through Settings.
  try {
    const granted = await args.requestConsent(args.sessionId);
    if (granted) return { ok: true };
    return {
      ok: false,
      error: "CDP input not enabled — the user declined. This action requires CDP and can't be performed otherwise.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Onboarding cancelled/i.test(msg)) {
      return { ok: false, error: "Onboarding cancelled (panel closed)." };
    }
    return { ok: false, error: `CDP consent error: ${msg}` };
  }
}
