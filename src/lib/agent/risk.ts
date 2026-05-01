import type { ElementInfo, PageSnapshot } from "../dom-actions/types";
import type { RiskAssessment, RiskLevel } from "./types";
import { KEYBOARD_TOOL_NAMES } from "./tools/keyboard";

/**
 * Returns true when the element is a sensitive input field
 * (password, credit card, OTP, verification code, etc.).
 *
 * Uses only fields available in ElementInfo: type, text, placeholder, ariaLabel.
 * Note: autocomplete/name/id are not in ElementInfo, so detection is intentionally
 * more conservative than the inline check in type.ts.
 */
export function isSensitiveInputTarget(element: ElementInfo): boolean {
  // type="password"
  if (element.type === "password") return true;

  const sensitivePattern =
    /password|密码|cvv|cvc|otp|验证码|card.*number|card.*code/i;
  const ccPattern = /cc-(number|cvc|exp|csc)/i;

  // Check placeholder
  if (element.placeholder) {
    if (sensitivePattern.test(element.placeholder)) return true;
    if (ccPattern.test(element.placeholder)) return true;
  }

  // Check text (innerText / aria-label — whichever getElementText returned)
  if (element.text) {
    if (sensitivePattern.test(element.text)) return true;
    if (ccPattern.test(element.text)) return true;
  }

  // Check ariaLabel (stored separately from text)
  if (element.ariaLabel) {
    if (sensitivePattern.test(element.ariaLabel)) return true;
    if (ccPattern.test(element.ariaLabel)) return true;
  }

  return false;
}

// Keyword regex for click / select risk classification
const DANGEROUS_KEYWORD_RE =
  /submit|delete|confirm|buy|pay|purchase|确认|删除|支付|购买|提交/i;

function getElement(
  snapshot: PageSnapshot,
  elementIndex?: number,
): ElementInfo | undefined {
  if (elementIndex === undefined || elementIndex === null) return undefined;
  return snapshot.elements.find((el) => el.index === elementIndex);
}

/**
 * Pure function. Classifies the risk of a tool call based on static rules.
 * Default is low; structural signals elevate to high.
 *
 * The args parameter accepts optional fields for every tool that introspects
 * its args during classification (DOM tools use elementIndex/value; Phase 3
 * tab tools use tabIds/tabId/scope). The cast site in loop.ts widens the
 * incoming `unknown` args to this shape; new tools that introspect args must
 * extend this type union (or change to Record<string, unknown> + narrowing).
 */
export function classifyRisk(
  toolName: string,
  args: {
    elementIndex?: number;
    value?: string;
    // Phase 3 cross-tab tools
    tabIds?: number[];
    tabId?: number;
    scope?: string;
  },
  snapshot: PageSnapshot,
): RiskAssessment {
  // Phase 2.5 keyboard simulation tools — ALWAYS high risk. CDP keyboard
  // events bypass all DOM safety checks (visibility, readonly, disabled);
  // any call could trigger arbitrary keyboard-bound logic in the page.
  //
  // INVARIANT: keyboard tools must opt out of any future "approve all in
  // task" / "remember decision" shortcut in the confirm UI. Each call
  // must remain its own independent user decision point. If such a
  // shortcut ever lands, exclude these tool names by reference.
  if (toolName === "dispatch_keyboard_input" || toolName === "press_key") {
    return {
      level: "high",
      reason: "Keyboard simulation via CDP bypasses DOM safety checks",
    };
  }

  // Phase 2.6 — Skill autonomous CRUD meta tools.
  //
  // create_skill / update_skill grant the agent new persistent capabilities
  // (write to chrome.storage.local; the new skill becomes a callable tool on
  // subsequent turns). They are ALWAYS high until the user has reviewed the
  // proposed skill content. Future降级 (e.g. low risk when allowedTools is
  // entirely low-risk) can use riskOfAllowedTools below; the conservative
  // default for now is unconditional high.
  //
  // delete_skill / list_skills are low: delete reduces capabilities (blast
  // radius shrinks), list is a pure read.
  if (toolName === "create_skill" || toolName === "update_skill") {
    return {
      level: "high",
      reason:
        "Persists a skill the agent can later invoke; review promptTemplate, parameters, and allowedTools before approving.",
    };
  }
  if (toolName === "delete_skill" || toolName === "list_skills") {
    return { level: "low" };
  }

  // Terminal / always-low tools
  if (
    toolName === "done" ||
    toolName === "fail" ||
    toolName === "scroll" ||
    toolName === "wait"
  ) {
    return { level: "low" };
  }

  // Phase 3 — list_tabs is the single tab tool with args-dependent risk.
  // currentWindow (default) is low; allWindows triggers high because it
  // exposes tab metadata across windows the user has not chosen as the
  // agent conversation context (P3-T / SEC-3).
  if (toolName === "list_tabs") {
    const scope = typeof args.scope === "string" ? args.scope : "currentWindow";
    if (scope === "allWindows") {
      return {
        level: "high",
        reason:
          "Cross-window tab metadata exposure to BYOK provider — confirm scope.",
      };
    }
    return { level: "low" };
  }

  if (toolName === "type") {
    const target = getElement(snapshot, args.elementIndex);
    if (!target) return { level: "low" };
    if (isSensitiveInputTarget(target)) {
      const fieldName = target.text || target.placeholder || target.ariaLabel || "field";
      return { level: "high", reason: `Sensitive field: ${fieldName}` };
    }
    return { level: "low" };
  }

  if (toolName === "click") {
    const target = getElement(snapshot, args.elementIndex);
    if (!target) return { level: "low" };

    // button[type="submit"]
    if (target.tag === "button" && target.type === "submit") {
      return { level: "high", reason: "Submit button" };
    }

    // input[type="submit"]
    if (target.tag === "input" && target.type === "submit") {
      return { level: "high", reason: "Submit input" };
    }

    // Keyword match on text or ariaLabel
    const textHaystack = [target.text, target.ariaLabel]
      .filter(Boolean)
      .join(" ");
    const match = textHaystack.match(DANGEROUS_KEYWORD_RE);
    if (match) {
      return { level: "high", reason: `Keyword match: ${match[0]}` };
    }

    return { level: "low" };
  }

  if (toolName === "select") {
    const target = getElement(snapshot, args.elementIndex);
    if (!target) return { level: "low" };

    // Check the option value/label being selected
    if (args.value) {
      const match = args.value.match(DANGEROUS_KEYWORD_RE);
      if (match) {
        return { level: "high", reason: `Keyword match: ${match[0]}` };
      }
    }

    return { level: "low" };
  }

  // Default
  return { level: "low" };
}

/**
 * Compute the aggregate risk of a tool whitelist by taking the max risk of any
 * named tool. Used by the R5 inference path — currently exported for future降级
 * of create_skill / update_skill (e.g. lowering risk when allowedTools is
 * entirely low-risk). classifyRisk's hardcoded 'high' for those tools is the
 * conservative default until降级 is enabled.
 *
 * Conservative: unknown names default to 'low' to avoid accidental escalation
 * from typos (the meta tool handler already P1-G-rejects unknown names at
 * write time).
 */
const ALWAYS_HIGH_RISK_TOOL_NAMES = new Set<string>([
  ...KEYBOARD_TOOL_NAMES,
  "create_skill",
  "update_skill",
]);

export function riskOfAllowedTools(names: string[]): RiskLevel {
  for (const n of names) {
    if (ALWAYS_HIGH_RISK_TOOL_NAMES.has(n)) return "high";
  }
  return "low";
}
