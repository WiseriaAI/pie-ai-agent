import { clickByIndex } from "../dom-actions/click";
import { typeByIndex } from "../dom-actions/type";
import { scroll } from "../dom-actions/scroll";
import { selectByIndex } from "../dom-actions/select";
import { wait } from "../dom-actions/wait";
import type { ActionResult } from "../dom-actions/types";
import type { Tool, ToolHandlerContext } from "./types";
import { buildKeyboardTools, type KeyboardToolDeps } from "./tools/keyboard";
import { SKILL_META_TOOLS } from "./tools/skill-meta";
import { SKILL_ACCESS_TOOLS } from "./tools/skill-access";
import { TAB_TOOLS } from "./tools/tabs";
import { searchWebTool } from "./tools/search";
import { readPageTool } from "./tools/read-page";
import { withActionSettle } from "./wait-for-settle";
import { getFrameVersion } from "./tools/page-version-registry";

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
  frameId?: number,
): Promise<ActionResult> {
  // iframe spec §5: writes target a specific frame via target.frameIds.
  // Reads (snapshot/extract) go through allFrames in their own callsites,
  // not through this helper.
  const target: chrome.scripting.InjectionTarget = frameId !== undefined
    ? { tabId, frameIds: [frameId] }
    : { tabId };

  try {
    const results = await chrome.scripting.executeScript({ target, func, args });
    return (results[0]?.result as ActionResult) ?? { success: false, error: "Execution failed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // iframe spec §5: frame already navigated away or removed.
    if (frameId !== undefined && /Frame with ID .* not found|No frame with id/i.test(msg)) {
      return {
        success: false,
        error: `Frame ${frameId} unreachable or removed. Re-snapshot.`,
      };
    }
    throw err;
  }
}

// ── Stale-detection helper ───────────────────────────────────────────────────

/**
 * Verifies the frame version before executing a write-class tool.
 * Returns { ok: true } if the frame is current, or { ok: false, result }
 * with the appropriate error code for the LLM to retry.
 *
 * Error codes:
 *   frameGone    — frame not in registry; LLM must call read_page first.
 *   frameStale   — observer dead (page navigated); LLM must refresh.
 *   frameVersionMismatch — DOM mutated since last snapshot; indices shifted.
 */
function verifyFrameVersion(
  tabId: number,
  frameId: number,
  expectedFrameVersion: number,
): { ok: true } | { ok: false; result: ActionResult } {
  const entry = getFrameVersion(tabId, frameId);
  if (!entry) {
    return {
      ok: false,
      result: {
        success: false,
        error: "frameGone: Frame not in registry. Call read_page first.",
      },
    };
  }
  if (!entry.observerAlive) {
    return {
      ok: false,
      result: {
        success: false,
        error: "frameStale: Observer dead. Re-call read_page to refresh.",
      },
    };
  }
  if (entry.version !== expectedFrameVersion) {
    return {
      ok: false,
      result: {
        success: false,
        error: `frameVersionMismatch: expected ${expectedFrameVersion}, current ${entry.version}. Re-call read_page; indices may have shifted.`,
      },
    };
  }
  return { ok: true };
}

// ── Built-in tools ────────────────────────────────────────────────────────────

export const BUILT_IN_TOOLS: Tool[] = [
  {
    name: "click",
    description:
      "Click an interactive element. Requires expectedFrameVersion from the latest read_page; mismatch returns frameVersionMismatch and you must re-call read_page.",
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from latest read_page.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the element.",
        },
        expectedFrameVersion: {
          type: "number",
          description: "frame_version from the latest read_page for this frame.",
        },
      },
      required: ["frameId", "elementIndex", "expectedFrameVersion"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number; expectedFrameVersion: number };
      const verify = verifyFrameVersion(ctx.tabId, a.frameId, a.expectedFrameVersion);
      if (!verify.ok) return verify.result;
      return withActionSettle(ctx.tabId, () =>
        execInTab(ctx.tabId, clickByIndex, [a.elementIndex], a.frameId),
      );
    },
  },

  {
    name: "type",
    description:
      "Type text into an input/textarea/contenteditable. Requires expectedFrameVersion; mismatch returns frameVersionMismatch.",
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from latest read_page.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the element.",
        },
        text: {
          type: "string",
          description: "The text to type.",
        },
        clear: {
          type: "boolean",
          description: "If true, clear existing content before typing. Defaults to false.",
        },
        expectedFrameVersion: {
          type: "number",
          description: "frame_version from the latest read_page for this frame.",
        },
      },
      required: ["frameId", "elementIndex", "text", "expectedFrameVersion"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number; text: string; clear?: boolean; expectedFrameVersion: number };
      const verify = verifyFrameVersion(ctx.tabId, a.frameId, a.expectedFrameVersion);
      if (!verify.ok) return verify.result;
      return execInTab(ctx.tabId, typeByIndex, [a.elementIndex, a.text, a.clear ?? false], a.frameId);
    },
  },

  {
    name: "scroll",
    description: "Scroll the page up or down. Defaults to the top frame if frameId is not specified.",
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
        frameId: {
          type: "number",
          description: "Frame ID to scroll within. Defaults to 0 (top frame).",
        },
      },
      required: ["direction"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { direction: "up" | "down"; amount?: number; frameId?: number };
      const scrollArgs: ["up" | "down"] | ["up" | "down", number] =
        a.amount !== undefined ? [a.direction, a.amount] : [a.direction];
      return execInTab(ctx.tabId, scroll, scrollArgs, a.frameId ?? 0);
    },
  },

  {
    name: "select",
    description:
      "Select an option in a <select> element. Requires expectedFrameVersion; mismatch returns frameVersionMismatch.",
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from latest read_page.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the <select>.",
        },
        value: {
          type: "string",
          description: "Option value to select.",
        },
        expectedFrameVersion: {
          type: "number",
          description: "frame_version from the latest read_page for this frame.",
        },
      },
      required: ["frameId", "elementIndex", "value", "expectedFrameVersion"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number; value: string; expectedFrameVersion: number };
      const verify = verifyFrameVersion(ctx.tabId, a.frameId, a.expectedFrameVersion);
      if (!verify.ok) return verify.result;
      return execInTab(ctx.tabId, selectByIndex, [a.elementIndex, a.value], a.frameId);
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

  // SP-1 — Skill access tools: use_skill + read_skill_file (see tools/skill-access.ts)
  ...SKILL_ACCESS_TOOLS,

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
  searchWebTool,
  readPageTool,
];

// iframe spec R-iframe-1 — build-time assertion: writes target a specific
// frame via (frameId, elementIndex) tuple. If this fails, a future schema
// edit accidentally dropped frameId required-ness.
(function assertWriteToolsRequireFrameId() {
  const writeTools = ["click", "type", "select"];
  for (const name of writeTools) {
    const t = BUILT_IN_TOOLS.find((tool) => tool.name === name);
    if (!t) {
      throw new Error(`[R-iframe-1] BUILT_IN_TOOLS missing tool: ${name}`);
    }
    const required = (t.parameters as { required?: string[] }).required ?? [];
    if (!required.includes("frameId")) {
      throw new Error(
        `[R-iframe-1] tool "${name}" must require frameId in its JSON schema`,
      );
    }
  }
})();
