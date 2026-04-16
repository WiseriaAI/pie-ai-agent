import type { ElementInfo, PageSnapshot } from "../dom-actions/types";
import type { RiskAssessment } from "./types";

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
 */
export function classifyRisk(
  toolName: string,
  args: { elementIndex?: number; value?: string },
  snapshot: PageSnapshot,
): RiskAssessment {
  // Terminal / always-low tools
  if (
    toolName === "done" ||
    toolName === "fail" ||
    toolName === "scroll" ||
    toolName === "wait"
  ) {
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
