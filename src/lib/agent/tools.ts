import { buildClickTool, buildHoverTool, type MouseToolDeps } from "./tools/mouse";
import type { ActResult } from "../dom-actions/act-core";
import { execActInTab } from "../dom-actions/exec-act";
import { scroll } from "../dom-actions/scroll";
import { wait } from "../dom-actions/wait";
import type { ActionResult } from "../dom-actions/types";
import type { Tool, ToolHandlerContext } from "./types";
import { buildKeyboardTools, type KeyboardToolDeps } from "./tools/keyboard";
import { buildEditorTools, type EditorToolDeps } from "./tools/editor";
import { SKILL_META_TOOLS } from "./tools/skill-meta";
import { SKILL_ACCESS_TOOLS } from "./tools/skill-access";
import { TAB_TOOLS } from "./tools/tabs";
import { searchWebTool } from "./tools/search";
import { readPageTool } from "./tools/read-page";
import { createPageAtlasTargetTools } from "./tools/page-atlas";
import { PDF_TOOLS } from "./tools/pdf";

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

/**
 * Phase 6 — mouse tools (hover + CDP click). Always returned (handlers
 * gate via requireCdpInput → inline onboarding flow). T16 wires this
 * into loop.ts alongside getKeyboardTools.
 */
export function getMouseTools(deps: MouseToolDeps): Tool[] {
  return [buildHoverTool(deps), buildClickTool(deps)];
}

export type { MouseToolDeps };

/**
 * Editor tools (read_editor + set_editor_value). Returned only when CDP is
 * available (handlers also gate via requireCdpInput). Deps are task-scoped,
 * mirroring getKeyboardTools.
 */
export function getEditorTools(deps: EditorToolDeps): Tool[] {
  return buildEditorTools(deps);
}

export type { EditorToolDeps };

// ── Helper: run a self-contained function in the target tab ──────────────────

async function execInTab<T extends unknown[]>(
  tabId: number,
  // chrome.scripting.executeScript awaits promise-returning injected functions at runtime.
  func: (...args: T) => ActionResult | Promise<ActionResult>,
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

// Adapt the act-core ActResult into the legacy ActionResult that tool handlers
// return. The op-tagged success variants all carry an `observation`.
function actResultToActionResult(r: ActResult): ActionResult {
  if (r.ok) {
    // op === "rect" carries no observation, but type/select/focusClick do; the
    // tool handlers below only invoke type/select ops, so observation is present.
    return { success: true, observation: "observation" in r ? r.observation : undefined };
  }
  return { success: false, error: r.error };
}

// ── Built-in tools ────────────────────────────────────────────────────────────

export const BUILT_IN_TOOLS: Tool[] = [
  {
    name: "type",
    description:
      `Type text into a native input / textarea / contenteditable by its data-pie-idx from the latest read_page <interactive_index>. If the element is gone (page changed), returns 'Element not found' — call read_page({mode:"interactive"}) again.

USE WHEN:
- The target is a standard form field — text input, textarea, search box, or a plain contenteditable.

**DO NOT USE WHEN:**
- The field is a code editor (Monaco / CodeMirror) or TinyMCE — read_page tags these role="editor"; use set_editor_value.
- The field is a canvas-rendered editor (Google Docs, Feishu Docs, Notion) where type returns 'hidden IME / keyboard capture buffer' — use dispatch_keyboard_input.
- You're choosing a native <select> option — use select.`,
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
        text: {
          type: "string",
          description: "The text to type.",
        },
        clear: {
          type: "boolean",
          description: "If true, clear existing content before typing. Defaults to false.",
        },
      },
      required: ["frameId", "elementIndex", "text"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number; text: string; clear?: boolean };
      const r = await execActInTab(
        ctx.tabId,
        { op: "type", idx: a.elementIndex, text: a.text, clear: a.clear ?? false },
        a.frameId,
      );
      return actResultToActionResult(r);
    },
  },

  {
    name: "scroll",
    description:
      `Scroll the page up or down. Defaults to the top frame if frameId is not specified.

USE WHEN:
- You need to trigger lazy-load / infinite-scroll to pull more content into the DOM.

**DO NOT USE WHEN:**
- You only want to read off-screen content — read_page already captures the full page DOM; you don't need to scroll first.`,
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
      `Select an option in a native <select> element by its data-pie-idx from the latest read_page <interactive_index>. If the element is gone (page changed), returns 'Element not found' — call read_page({mode:"interactive"}) again.

USE WHEN:
- The target is a real HTML <select> dropdown (read_page shows it as a select).

**DO NOT USE WHEN:**
- The dropdown is a custom widget (div / listbox, not a real <select>) — click to open it, then click the option.`,
    parameters: {
      type: "object",
      properties: {
        frameId: {
          type: "number",
          description: "Frame ID from the latest read_page <interactive_index>.",
        },
        elementIndex: {
          type: "number",
          description: "data-pie-idx of the <select> from the latest read_page <interactive_index>.",
        },
        value: {
          type: "string",
          description: "Option value to select.",
        },
      },
      required: ["frameId", "elementIndex", "value"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = args as { frameId: number; elementIndex: number; value: string };
      const r = await execActInTab(
        ctx.tabId,
        { op: "select", idx: a.elementIndex, value: a.value },
        a.frameId,
      );
      return actResultToActionResult(r);
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
  ...createPageAtlasTargetTools(),
  ...PDF_TOOLS,
];

// iframe spec R-iframe-1 — build-time assertion: writes target a specific
// frame via (frameId, elementIndex) tuple. If this fails, a future schema
// edit accidentally dropped frameId required-ness.
(function assertWriteToolsRequireFrameId() {
  const writeTools = ["type", "select"];
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

// iframe spec R-iframe-1 (mouse tools) — same invariant for hover + click,
// which are built via getMouseTools factory (not in BUILT_IN_TOOLS).
(function assertMouseToolsRequireFrameId() {
  const dummyDeps: MouseToolDeps = {
    acquireSession: () => Promise.reject(new Error("dummy")),
    sessionId: "build-time-check",
    requestConsent: () => Promise.reject(new Error("dummy")),
  };
  const mouseTools = getMouseTools(dummyDeps);
  for (const name of ["click", "hover"]) {
    const t = mouseTools.find((tool) => tool.name === name);
    if (!t) {
      throw new Error(`[R-iframe-1] getMouseTools missing tool: ${name}`);
    }
    const required = (t.parameters as { required?: string[] }).required ?? [];
    if (!required.includes("frameId")) {
      throw new Error(`[R-iframe-1] mouse tool "${name}" must require frameId`);
    }
  }
})();
