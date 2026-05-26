// Phase 2.5 — keyboard tool handlers (dispatch_keyboard_input + press_key).
//
// These tools use chrome.debugger + CDP Input.* commands to send isTrusted
// keyboard events that canvas-rendered editors (Feishu Docs, Google Docs,
// Notion) accept where DOM-synthesized events fail.
//
// Critical security invariants — every CDP send is preceded by:
//   1. Argument sanitization (length cap, character-class denylist)
//   2. Per-call origin & active-tab re-check (tab may have navigated
//      during the user's high-risk confirm latency)
//
// Args.text in observations and panel-side display is REDACTED (only
// length surfaces); the confirm-request flow shows the raw text to the
// user (so they can make an informed approval) but every OTHER channel
// strips it. This split is intentional — see plan Key Technical
// Decisions.
//
// Spec: docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md

import type { ActionResult } from "../../dom-actions/types";

/**
 * Self-contained function injected via chrome.scripting.executeScript to
 * focus-click an element before a keyboard dispatch. Mirrors the old
 * dom-actions/click.ts contract; lives here as the only remaining
 * consumer of synthetic click (the public click tool is now CDP-based).
 */
function focusClickByIndex(index: number): ActionResult {
  const el = document.querySelector(`[data-pie-idx="${index}"]`);
  if (!el) {
    return {
      success: false,
      error: `Element not found at index ${index}. The page may have changed; try snapshotting again.`,
    };
  }
  (el as HTMLElement).click();
  return {
    success: true,
    observation: `Focus-clicked element [${index}]`,
  };
}
import { safeParseOrigin } from "../loop";
import { requireCdpInput } from "./mouse";
import type { CdpSession } from "../../../background/cdp-session";
import type { Tool, ToolHandlerContext } from "../types";
import { withActionSettle } from "../wait-for-settle";

// ── Configuration ────────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 5000;

// Whitelist of supported control keys for press_key. Each entry maps the
// LLM-facing key name to the CDP Input.dispatchKeyEvent parameters.
// Limited intentionally — adding a key requires a deliberate decision.
const KEY_MAP: Record<
  string,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
};

// CDP modifier bitmask (Input.dispatchKeyEvent.modifiers field).
//   Alt = 1, Ctrl = 2, Meta = 4, Shift = 8
// Only Shift is currently used (soft-break paragraphs in Notion / Feishu /
// Google Docs require Shift+Enter); other bits intentionally not exposed.
const MODIFIER_SHIFT = 8;

// Helper: send a paired keyDown/keyUp via CDP. Used internally when
// expanding \n inside dispatch_keyboard_input — canvas editors (Feishu
// Docs / Google Docs / Notion) bind paragraph breaks to keydown(Enter),
// not to the literal \n character, so we MUST translate.
async function sendKeyPress(
  session: CdpSession,
  keyName: string,
  modifiers = 0,
): Promise<void> {
  const mapping = KEY_MAP[keyName];
  if (!mapping) throw new Error(`No mapping for key '${keyName}'`);
  const baseParams: Record<string, unknown> = {
    key: keyName,
    code: mapping.code,
    windowsVirtualKeyCode: mapping.windowsVirtualKeyCode,
    nativeVirtualKeyCode: mapping.windowsVirtualKeyCode,
  };
  if (modifiers !== 0) baseParams.modifiers = modifiers;
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...baseParams,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...baseParams,
  });
}

// Bidi formatting controls — banned to prevent phishing via right-to-left
// override and isolate marks. Other Cf characters (e.g. U+200D ZWJ used
// in legitimate emoji sequences) are allowed.
const BIDI_CONTROL_CODEPOINTS = new Set<number>([
  0x200e, 0x200f, // LTR/RTL marks
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embedding/override
  0x2066, 0x2067, 0x2068, 0x2069, // isolate marks
]);

// ── Validation ───────────────────────────────────────────────────────────────

function validateText(text: string): { ok: true } | { ok: false; reason: string } {
  if (typeof text !== "string") {
    return { ok: false, reason: "text must be a string" };
  }
  if (text.length === 0) {
    return { ok: true };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      reason: `text length ${text.length} exceeds ${MAX_TEXT_LENGTH} character cap`,
    };
  }
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp === undefined) continue;
    // Skip the second half of surrogate pairs (already covered)
    if (cp > 0xffff) i++;

    if (BIDI_CONTROL_CODEPOINTS.has(cp)) {
      return {
        ok: false,
        reason: `text contains forbidden bidi control U+${cp.toString(16).toUpperCase().padStart(4, "0")} (phishing risk)`,
      };
    }
    // Cc class: ASCII control chars (0x00-0x1F + 0x7F) and C1 (0x80-0x9F).
    // Allow newline (0x0A) and tab (0x09); reject everything else in those ranges.
    if (cp !== 0x0a && cp !== 0x09 && (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f))) {
      return {
        ok: false,
        reason: `text contains forbidden control character U+${cp.toString(16).toUpperCase().padStart(4, "0")} (Cc class)`,
      };
    }
  }
  return { ok: true };
}

// ── Origin & active-tab re-check ─────────────────────────────────────────────

async function reverifyOriginAndActive(
  pinnedTabId: number,
  pinnedOrigin: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(pinnedTabId);
  } catch (e) {
    return {
      ok: false,
      reason: `pinned tab ${pinnedTabId} no longer exists: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!tab.url) {
    return { ok: false, reason: "pinned tab has no URL (likely closed mid-task)" };
  }
  const currentOrigin = safeParseOrigin(tab.url);
  if (currentOrigin !== pinnedOrigin) {
    return {
      ok: false,
      reason: `origin changed during task: pinned ${pinnedOrigin}, now ${currentOrigin ?? "(unparseable)"}`,
    };
  }
  if (!tab.active) {
    return {
      ok: false,
      reason: "pinned tab is no longer the active tab; user must keep the target tab focused during keyboard input",
    };
  }
  return { ok: true };
}

// ── Tool factory ─────────────────────────────────────────────────────────────

export interface KeyboardToolDeps {
  /**
   * Lazy attach (or reuse) a CdpSession bound to this task. Curried by
   * runAgentLoop with the task's signal/ownerToken/onExternalDetach.
   */
  acquireSession: (tabId: number) => Promise<CdpSession>;
  /**
   * The origin pinned at task start. Per-CDP-call re-check rejects if
   * the active tab's current origin differs.
   */
  pinnedOrigin: string;
  /**
   * Trigger sidepanel consent flow when cdp_input_enabled is undefined.
   * Bound to requestCdpInputConsent in loop.ts.
   */
  requestConsent: (sessionId: string) => Promise<boolean>;
  /**
   * Session id for the current chat task — used to route the inline
   * consent guide through the correct sidepanel port.
   */
  sessionId: string;
}

export function buildKeyboardTools(deps: KeyboardToolDeps): Tool[] {
  const { acquireSession, pinnedOrigin, requestConsent, sessionId } = deps;

  return [
    {
      name: "dispatch_keyboard_input",
      description:
        "Send text input via simulated real keyboard (Chrome DevTools Protocol). Pass the FULL multi-paragraph content in one call — every newline character inside `text` is converted to an Enter key press, so paragraphs/lists/code blocks are inserted correctly. Avoid breaking content into many small calls; each call requires the user to approve. Use ONLY for canvas-rendered editors (Feishu Docs, Google Docs, Notion) where the regular `type` tool returns 'hidden IME / keyboard capture buffer'. Activates Chrome's debugger (yellow bar appears). Set `softBreak: true` if newlines should be intra-paragraph soft breaks (Shift+Enter) instead of new paragraphs — Notion / Feishu / Google Docs treat Enter as block break and Shift+Enter as line break within the same block.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: `Text to insert. Max ${MAX_TEXT_LENGTH} characters. Use real newline characters in the string for line breaks (each newline becomes Enter, or Shift+Enter when softBreak is true). Must not contain other control characters or bidi formatting controls.`,
          },
          after_element_index: {
            type: "number",
            description:
              "Optional: click this element index (from snapshot) before sending the input, to ensure the editor has focus.",
          },
          softBreak: {
            type: "boolean",
            description:
              "If true, every newline in `text` is sent as Shift+Enter (intra-paragraph soft break) instead of Enter (new paragraph/block). Use when authoring inside Notion, Feishu Docs, or Google Docs and you want lines to stay inside the same block. Default false. If you need a mix of hard and soft breaks, split into two calls.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      // Issue #27 — wrap dispatch in `withActionSettle` so the page
      // settles after the keystrokes (Enter may submit a form or trigger
      // navigation; insertText into autocompletes can fire async DOM
      // updates). Validation failures short-circuit before any wait
      // because the helper exits on !result.success.
      handler: async (
        args: unknown,
        ctx: ToolHandlerContext,
      ): Promise<ActionResult> => {
        const gate = await requireCdpInput({ sessionId, requestConsent });
        if (!gate.ok) return { success: false, error: gate.error };
        return withActionSettle(ctx.tabId, async () => {
        const a = args as {
          text: string;
          after_element_index?: number;
          softBreak?: boolean;
        };
        const enterModifiers = a.softBreak ? MODIFIER_SHIFT : 0;

        const validation = validateText(a.text);
        if (!validation.ok) {
          return { success: false, error: `Rejected: ${validation.reason}` };
        }

        // Empty text → no-op success (don't even attach debugger).
        if (a.text.length === 0) {
          return {
            success: true,
            observation: "No-op: empty text, no keyboard event sent",
          };
        }

        // Optional focus assurance via click. Failure here is a real
        // tool failure (user asked for a focus step before input);
        // skip the CDP attach.
        if (typeof a.after_element_index === "number") {
          const clickResult = await chrome.scripting
            .executeScript({
              target: { tabId: ctx.tabId },
              func: focusClickByIndex,
              args: [a.after_element_index],
            })
            .then(
              (results) =>
                (results[0]?.result as ActionResult | undefined) ?? null,
            )
            .catch((e: unknown) => {
              return {
                success: false,
                error: e instanceof Error ? e.message : String(e),
              } satisfies ActionResult;
            });
          if (!clickResult || !clickResult.success) {
            return {
              success: false,
              error: `Failed to focus target before keyboard input: ${clickResult?.error ?? "unknown"}`,
            };
          }
        }

        // Per-call origin & active-tab re-check — happens AFTER the
        // optional click (which is just a regular DOM op via
        // executeScript and tolerates page state changes by failing
        // gracefully) but BEFORE attaching the debugger.
        const recheck = await reverifyOriginAndActive(ctx.tabId, pinnedOrigin);
        if (!recheck.ok) {
          return { success: false, error: recheck.reason };
        }

        let session: CdpSession;
        try {
          session = await acquireSession(ctx.tabId);
        } catch (e) {
          return {
            success: false,
            error:
              e instanceof Error
                ? `CDP attach failed: ${e.message}`
                : "CDP attach failed",
          };
        }

        // Split on newlines: each segment becomes an Input.insertText,
        // with sendKeyPress(Enter) between segments. This lets one
        // tool call submit multi-line content end-to-end without
        // needing the LLM to interleave press_key("Enter") calls
        // (each of which would otherwise need its own user approval).
        //
        // Tolerate two forms of "newline" coming from the LLM:
        //   (a) actual U+000A character — what JSON parsing of "...\n..." yields
        //   (b) literal two-char backslash + n — what some LLMs emit when they
        //       over-escape JSON ("...\\n..." in the wire body, parsing to "\n"
        //       as two chars rather than one newline)
        // Both should produce a paragraph break in the editor. Replace
        // the literal-form first, then split on the real char.
        //
        // Edge cases:
        //   "a\nb"     → ["a", "b"]              insert a, Enter, insert b
        //   "a\n"      → ["a", ""]               insert a, Enter
        //   "\nb"      → ["", "b"]               Enter, insert b
        //   "\n\n"     → ["", "", ""]            Enter, Enter
        //   no newline → [text]                  insert text
        const normalized = a.text.replace(/\\n/g, "\n");
        const segments = normalized.split("\n");
        const enterCount = segments.length - 1;
        try {
          for (let i = 0; i < segments.length; i++) {
            if (i > 0) {
              await sendKeyPress(session, "Enter", enterModifiers);
            }
            if (segments[i].length > 0) {
              await session.send("Input.insertText", { text: segments[i] });
            }
          }
        } catch (e) {
          return {
            success: false,
            error:
              e instanceof Error
                ? `Keyboard input failed: ${e.message}`
                : "Keyboard input failed",
          };
        }

        // Observation NEVER includes the actual text content. Surface
        // length + Enter count so the LLM knows what shape it sent.
        // Length uses the normalized text so it reflects what was
        // actually delivered to the editor (literal-\n collapsed to
        // single newline char before splitting).
        const charCount = normalized.length - enterCount; // exclude newlines from char count
        const lengthDesc = `${charCount} character${charCount === 1 ? "" : "s"}`;
        const breakLabel = a.softBreak ? "soft break" : "paragraph break";
        const enterDesc =
          enterCount > 0
            ? ` (${enterCount} ${breakLabel}${enterCount === 1 ? "" : "s"})`
            : "";
        return {
          success: true,
          observation: `Typed ${lengthDesc}${enterDesc} via keyboard simulation (value redacted)`,
        };
        });
      },
    },
    {
      name: "press_key",
      description: `Press a single control key via simulated real keyboard (CDP). Use for navigation in canvas-rendered editors. Activates Chrome's debugger; each call requires approval. Allowed keys: ${Object.keys(KEY_MAP).join(", ")}.`,
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            enum: Object.keys(KEY_MAP),
            description: "The control key to press.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
      // Issue #27 — same settle wrap as dispatch_keyboard_input. Enter
      // / Space / Tab can submit forms or trigger navigation; arrow
      // keys can scroll lists and load more content asynchronously.
      handler: async (
        args: unknown,
        ctx: ToolHandlerContext,
      ): Promise<ActionResult> => {
        const gate = await requireCdpInput({ sessionId, requestConsent });
        if (!gate.ok) return { success: false, error: gate.error };
        return withActionSettle(ctx.tabId, async () => {
        const a = args as { key: string };
        const mapping = KEY_MAP[a.key];
        if (!mapping) {
          return {
            success: false,
            error: `Unsupported key '${a.key}'. Allowed: ${Object.keys(KEY_MAP).join(", ")}`,
          };
        }

        const recheck = await reverifyOriginAndActive(ctx.tabId, pinnedOrigin);
        if (!recheck.ok) {
          return { success: false, error: recheck.reason };
        }

        let session: CdpSession;
        try {
          session = await acquireSession(ctx.tabId);
        } catch (e) {
          return {
            success: false,
            error:
              e instanceof Error
                ? `CDP attach failed: ${e.message}`
                : "CDP attach failed",
          };
        }

        try {
          // keyDown + keyUp pair shares a single origin re-check (the
          // two events fire <1ms apart; origin can't realistically
          // change between them, and re-checking would double the
          // chrome.tabs.get round-trip per press).
          await sendKeyPress(session, a.key);
        } catch (e) {
          return {
            success: false,
            error:
              e instanceof Error
                ? `Input.dispatchKeyEvent failed: ${e.message}`
                : "Input.dispatchKeyEvent failed",
          };
        }

        return {
          success: true,
          observation: `Pressed ${a.key} via keyboard simulation`,
        };
        });
      },
    },
  ];
}

/**
 * Names of the keyboard tools — used by:
 *   - risk classifier (always-high)
 *   - args redaction logic in sendAgentStep
 *   - confirm-card raw-text disclosure logic
 *
 * Keep in sync with the tool definitions above.
 */
export const KEYBOARD_TOOL_NAMES = [
  "dispatch_keyboard_input",
  "press_key",
] as const;

export type KeyboardToolName = (typeof KEYBOARD_TOOL_NAMES)[number];

export function isKeyboardToolName(name: string): name is KeyboardToolName {
  return (KEYBOARD_TOOL_NAMES as readonly string[]).includes(name);
}
