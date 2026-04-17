import type { PageSnapshot } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * NO imports, NO closures, NO outer-scope references at runtime.
 * All helpers are nested inside this function.
 */
export function snapshotInteractiveElements(): PageSnapshot {
  // ── Helpers (all nested; captured when Chrome serializes this function) ──

  function sanitizeText(str: string, maxLen: number): string {
    if (!str) return "";
    // Filter control chars (\u0000-\u001F) and zero-width chars (\u200B-\u200F)
    let cleaned = str.replace(/[\u0000-\u001F\u200B-\u200F]/g, "");
    // Neutralize the untrusted-content wrapper tags so page text cannot close the
    // <untrusted_page_content> block that the agent prompt builder uses. Without
    // this, a page element with text like "</untrusted_page_content> SYSTEM: ..."
    // could escape the untrusted wrapper and become LLM instructions.
    cleaned = cleaned
      .replace(/<\/?untrusted_page_content>/gi, "[filtered]")
      .replace(/<\/?untrusted_skill_params>/gi, "[filtered]");
    if (cleaned.length > maxLen) {
      cleaned = cleaned.slice(0, maxLen) + "...";
    }
    return cleaned;
  }

  function getRegion(el: Element): string {
    let node: Element | null = el;
    while (node && node !== document.body) {
      const tag = node.tagName?.toLowerCase();
      const role = node.getAttribute("role")?.toLowerCase();

      if (tag === "main" || role === "main") return "main";
      if (tag === "nav" || role === "navigation") return "nav";
      if (tag === "header" || role === "banner") return "header";
      if (tag === "footer" || role === "contentinfo") return "footer";
      if (tag === "aside" || role === "complementary") return "aside";

      node = node.parentElement;
    }
    return "other";
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Filter fully-transparent elements — rich-text editors like Feishu Docs
    // and Google Docs use opacity:0 textareas as hidden IME buffers; they're
    // technically in the DOM tree but not user-visible typing targets.
    if (parseFloat(style.opacity) === 0) return false;
    // Tiny inputs/textareas (< 8px on either dimension) are almost always
    // hidden input capture buffers rather than real user inputs.
    const tag = el.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && (rect.width < 8 || rect.height < 8)) {
      return false;
    }
    // offsetParent is null for position:fixed elements too — skip the check for those
    if (style.position !== "fixed" && (el as HTMLElement).offsetParent === null) return false;
    return true;
  }

  function getElementText(el: Element): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel?.trim()) return sanitizeText(ariaLabel.trim(), 200);

    const innerText = (el as HTMLElement).innerText?.trim();
    if (innerText) return sanitizeText(innerText, 200);

    const placeholder = (el as HTMLInputElement).placeholder?.trim();
    if (placeholder) return sanitizeText(placeholder, 200);

    const title = el.getAttribute("title")?.trim();
    if (title) return sanitizeText(title, 200);

    return "";
  }

  // ── Selector set (Phase 0 validated) ──
  const SELECTOR = [
    "a",
    "button",
    "input",
    "select",
    "textarea",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    "summary",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  const MAX_ELEMENTS = 200;

  // Clean up any previously stamped attributes first
  // Namespaced attribute reduces collision with pages that use their own idx attributes.
  document.querySelectorAll("[data-chrome-ai-agent-idx]").forEach((el) => {
    el.removeAttribute("data-chrome-ai-agent-idx");
  });

  const candidates = Array.from(document.querySelectorAll(SELECTOR));

  // Filter to visible elements, preserving DOM order (querySelectorAll is already DOM order)
  const visible = candidates.filter((el) => isVisible(el));

  // Cap at 200
  const capped = visible.slice(0, MAX_ELEMENTS);

  const elements = capped.map((el, idx) => {
    // Stamp index attribute for action targeting
    el.setAttribute("data-chrome-ai-agent-idx", String(idx));

    const tag = el.tagName.toLowerCase();
    const inputEl = el as HTMLInputElement;
    const type = inputEl.type || undefined;
    const role = el.getAttribute("role") || undefined;
    const ariaLabel = el.getAttribute("aria-label")
      ? sanitizeText(el.getAttribute("aria-label")!.trim(), 200)
      : undefined;
    const placeholder = inputEl.placeholder
      ? sanitizeText(inputEl.placeholder.trim(), 60)
      : undefined;
    const text = getElementText(el);
    const disabled =
      (inputEl as HTMLInputElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true";
    const region = getRegion(el) as
      | "main"
      | "nav"
      | "footer"
      | "aside"
      | "header"
      | "other";
    const rect = el.getBoundingClientRect();

    return {
      index: idx,
      tag,
      ...(type !== undefined ? { type } : {}),
      ...(role !== undefined ? { role } : {}),
      text,
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(ariaLabel !== undefined ? { ariaLabel } : {}),
      disabled,
      region,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });

  return {
    url: location.href,
    title: document.title,
    elements,
  };
}
