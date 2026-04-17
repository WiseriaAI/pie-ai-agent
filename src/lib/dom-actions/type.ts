import type { ActionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Types text into an input, textarea, or contenteditable element.
 *
 * Sensitivity check is fully inlined (cannot import from Unit 3 risk.ts
 * since this function must be self-contained).
 *
 * NOTE: Plain el.value = text does not trigger React's synthetic change event
 * on React-controlled inputs. A TODO is left for future improvement.
 *
 * @param index - The index assigned by snapshotInteractiveElements
 * @param text  - Text to type
 * @param clear - If true, clear existing content before typing
 */
export function typeByIndex(
  index: number,
  text: string,
  clear: boolean,
): ActionResult {
  // ── Inline sensitivity detection ──
  function isSensitive(el: Element): boolean {
    const inputEl = el as HTMLInputElement;

    // type="password"
    if (inputEl.type === "password") return true;

    // autocomplete matches cc-* patterns
    const autocomplete = inputEl.autocomplete || "";
    if (/cc-(number|cvc|exp|csc)/i.test(autocomplete)) return true;

    // name or id matches sensitive patterns
    const sensitivePattern =
      /password|密码|cvv|cvc|otp|验证码|card.*number|card.*code/i;
    if (inputEl.name && sensitivePattern.test(inputEl.name)) return true;
    if (inputEl.id && sensitivePattern.test(inputEl.id)) return true;

    // Check nearest <label> text
    let label: HTMLLabelElement | null = null;
    if (inputEl.id) {
      label = document.querySelector<HTMLLabelElement>(
        `label[for="${inputEl.id}"]`,
      );
    }
    if (!label) {
      // Walk up to find wrapping label
      let node: Element | null = el.parentElement;
      while (node) {
        if (node.tagName?.toLowerCase() === "label") {
          label = node as HTMLLabelElement;
          break;
        }
        node = node.parentElement;
      }
    }
    if (label?.textContent && sensitivePattern.test(label.textContent)) {
      return true;
    }

    return false;
  }

  // ── Derive field name for redacted observation ──
  function getFieldName(el: Element): string {
    const inputEl = el as HTMLInputElement;
    if (inputEl.name) return inputEl.name;
    if (inputEl.id) return inputEl.id;
    // Check label
    if (inputEl.id) {
      const label = document.querySelector<HTMLLabelElement>(
        `label[for="${inputEl.id}"]`,
      );
      if (label?.textContent?.trim()) {
        return label.textContent.trim().slice(0, 60);
      }
    }
    if (el.getAttribute("aria-label")) {
      return el.getAttribute("aria-label")!.trim().slice(0, 60);
    }
    if (inputEl.placeholder) {
      return inputEl.placeholder.trim().slice(0, 60);
    }
    return "field";
  }

  // ── Locate element ──
  const el = document.querySelector(`[data-chrome-ai-agent-idx="${index}"]`);
  if (!el) {
    return {
      success: false,
      error: `Element not found at index ${index}. The page may have changed; try snapshotting again.`,
    };
  }

  const tag = el.tagName.toLowerCase();
  const isContentEditable =
    (el as HTMLElement).contentEditable === "true" ||
    el.getAttribute("contenteditable") === "true";
  const isInputOrTextarea = tag === "input" || tag === "textarea";

  if (!isInputOrTextarea && !isContentEditable) {
    return {
      success: false,
      error: `Element [${index}] is a <${tag}> which is not typeable (expected input, textarea, or contenteditable).`,
    };
  }

  const inputEl = el as HTMLInputElement;

  // Check disabled state
  if (inputEl.disabled) {
    return {
      success: false,
      error: `Element [${index}] is disabled.`,
    };
  }

  // Check sensitivity before typing (we don't need the value for the check)
  const sensitive = isSensitive(el);

  if (isInputOrTextarea) {
    if (clear) inputEl.value = "";
    inputEl.value += text;
    // TODO: React-controlled inputs won't pick up this assignment via the native setter.
    // Future improvement: use Object.getOwnPropertyDescriptor on prototype to call React's setter.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // contenteditable
    if (clear) (el as HTMLElement).textContent = "";
    (el as HTMLElement).textContent += text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  if (sensitive) {
    const fieldName = getFieldName(el);
    return {
      success: true,
      observation: `Typed into ${fieldName} (value redacted)`,
    };
  }

  return {
    success: true,
    observation: `Typed "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" into element [${index}]`,
  };
}
