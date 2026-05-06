import { clickByIndex } from "../dom-actions/click";
import { typeByIndex } from "../dom-actions/type";
import { scroll } from "../dom-actions/scroll";
import { selectByIndex } from "../dom-actions/select";
import { wait } from "../dom-actions/wait";
import type { ActionResult } from "../dom-actions/types";
import type { Tool, ToolHandlerContext } from "./types";
import { buildKeyboardTools, type KeyboardToolDeps } from "./tools/keyboard";
import { SKILL_META_TOOLS } from "./tools/skill-meta";
import { TAB_TOOLS } from "./tools/tabs";
import { withActionSettle } from "./wait-for-settle";

export {
  KEYBOARD_TOOL_NAMES,
  isKeyboardToolName,
  type KeyboardToolName,
  type KeyboardToolDeps,
} from "./tools/keyboard";

export {
  SKILL_META_TOOL_NAMES,
  isSkillMetaToolName,
  type SkillMetaToolName,
} from "./tools/skill-meta";

/**
 * Phase 2.5 keyboard tools (dispatch_keyboard_input + press_key). Returned
 * only when the user has enabled keyboard simulation in Settings; the loop
 * concatenates these into the tool list per iteration via this factory so
 * the deps closure (acquireSession, pinnedOrigin) is task-scoped.
 */
export function getKeyboardTools(deps: KeyboardToolDeps): Tool[] {
  return buildKeyboardTools(deps);
}

// ── Helper: run a self-contained function in the target tab ──────────────────

async function execInTab<T extends unknown[]>(
  tabId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: T) => ActionResult,
  args: T,
): Promise<ActionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return (results[0]?.result as ActionResult) ?? { success: false, error: "Execution failed" };
}

// ── Built-in tools ────────────────────────────────────────────────────────────

export const BUILT_IN_TOOLS: Tool[] = [
  {
    name: "click",
    description:
      "Click an interactive element on the page identified by its element index from the most recent snapshot.",
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "The index of the element to click (from snapshot).",
        },
      },
      required: ["elementIndex"],
      additionalProperties: false,
    },
    // Issue #27 — wrap click in `withActionSettle` so any consequence
    // (cross-doc nav, SPA pushState, async DOM update) settles before
    // the loop's next-iteration snapshot reads the page. See
    // `wait-for-settle.ts` for the dual-signal design.
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { elementIndex: number };
      return withActionSettle(ctx.tabId, () =>
        execInTab(ctx.tabId, clickByIndex, [a.elementIndex]),
      );
    },
  },

  {
    name: "type",
    description:
      "Type text into an input, textarea, or contenteditable element identified by its element index.",
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "The index of the element to type into (from snapshot).",
        },
        text: {
          type: "string",
          description: "The text to type.",
        },
        clear: {
          type: "boolean",
          description: "If true, clear existing content before typing. Defaults to false.",
        },
      },
      required: ["elementIndex", "text"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { elementIndex: number; text: string; clear?: boolean };
      return execInTab(ctx.tabId, typeByIndex, [a.elementIndex, a.text, a.clear ?? false]);
    },
  },

  {
    name: "scroll",
    description: "Scroll the page up or down.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Direction to scroll.",
        },
        amount: {
          type: "number",
          description:
            "Pixels to scroll. Defaults to 80% of viewport height if omitted.",
        },
      },
      required: ["direction"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { direction: "up" | "down"; amount?: number };
      // chrome.scripting.executeScript args go through structuredClone, which
      // rejects `undefined` (unlike JSON which silently drops it). When LLM
      // omits the optional amount, drop the trailing slot entirely so the
      // serializer sees [direction] not [direction, undefined].
      const scrollArgs: ["up" | "down"] | ["up" | "down", number] =
        a.amount !== undefined ? [a.direction, a.amount] : [a.direction];
      return execInTab(ctx.tabId, scroll, scrollArgs);
    },
  },

  {
    name: "select",
    description:
      "Select an option in a <select> element by its value, identified by element index.",
    parameters: {
      type: "object",
      properties: {
        elementIndex: {
          type: "number",
          description: "The index of the <select> element (from snapshot).",
        },
        value: {
          type: "string",
          description: "The option value to select.",
        },
      },
      required: ["elementIndex", "value"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { elementIndex: number; value: string };
      return execInTab(ctx.tabId, selectByIndex, [a.elementIndex, a.value]);
    },
  },

  {
    name: "wait",
    description: "Wait for a number of seconds (capped at 10) before proceeding.",
    parameters: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: "Number of seconds to wait (capped at 10).",
        },
      },
      required: ["seconds"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { seconds: number };
      return wait(a.seconds);
    },
  },

  {
    name: "done",
    description:
      "Signal that the task has been completed successfully. Provide a summary of what was accomplished.",
    parameters: {
      type: "object",
      properties: {
        result: {
          type: "string",
          description: "Summary of the completed task.",
        },
      },
      required: ["result"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { result: string };
      return { success: true, observation: a.result };
    },
  },

  {
    name: "fail",
    description:
      "Signal that the task cannot be completed. Provide the reason for failure.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Explanation of why the task failed.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { reason: string };
      return { success: false, error: a.reason };
    },
  },

  // Phase 2.6 — Skill autonomous CRUD meta tools (see tools/skill-meta.ts)
  ...SKILL_META_TOOLS,

  // Phase 3 — Cross-tab tools (see tools/tabs.ts)
  ...TAB_TOOLS,

  // Phase 5 — Screenshot tools (handlers wired in Tasks 8/9)
  {
    name: "capture_visible_tab",
    description:
      "Capture a JPEG screenshot of the currently visible viewport of the pinned tab. Returns post-resize image content (max-edge 1568 px). Use when you need to see the visible page region (e.g. 'click the third button I can see'). Never use for capturing scrolled-out-of-view content — use capture_fullpage_tab for that.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: async (_args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      // The loop dispatch (loop.ts ~line 1503) intercepts these tool names
      // BEFORE reaching this handler. If we ever land here, that intercept
      // was removed or bypassed — surface as a contract violation rather
      // than a silent error observation.
      throw new Error(
        "[contract violation] capture_visible_tab reached BUILT_IN_TOOLS handler — must be intercepted in loop.ts"
      );
    },
  },
  {
    name: "capture_fullpage_tab",
    description:
      "Capture a JPEG screenshot of the FULL page (including content below the visible viewport) of the pinned tab via Chrome DevTools Protocol. Returns post-resize image content (max-edge 1568 px). Use sparingly — this attaches CDP if not already attached and may show a yellow browser banner.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: async (_args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      // The loop dispatch (loop.ts ~line 1503) intercepts these tool names
      // BEFORE reaching this handler. If we ever land here, that intercept
      // was removed or bypassed — surface as a contract violation rather
      // than a silent error observation.
      throw new Error(
        "[contract violation] capture_fullpage_tab reached BUILT_IN_TOOLS handler — must be intercepted in loop.ts"
      );
    },
  },
];
