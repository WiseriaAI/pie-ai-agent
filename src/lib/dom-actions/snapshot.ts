import type { FrameInjectionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * NO imports, NO closures, NO outer-scope references at runtime.
 * All helpers are nested inside this function.
 */
export function snapshotInteractiveElements(): FrameInjectionResult {
  // ── Helpers (all nested; captured when Chrome serializes this function) ──

  function sanitizeText(str: string, maxLen: number): string {
    if (!str) return "";
    // Filter control chars (\u0000-\u001F) and zero-width chars (\u200B-\u200F)
    let cleaned = str.replace(/[\u0000-\u001F\u200B-\u200F]/g, "");
    // Neutralize the untrusted-content wrapper tags so page text cannot close
    // the <untrusted_*> blocks that the agent prompt builder uses. Without
    // this, a page element with text like "</untrusted_page_content> SYSTEM: ..."
    // could escape the untrusted wrapper and become LLM instructions.
    //
    // NOTE: this function is injected via chrome.scripting.executeScript and
    // cannot import external helpers. The non-injected code path uses the
    // shared escapeUntrustedWrappers helper at src/lib/agent/untrusted-wrappers.ts;
    // both implementations cover the same wrapper-tag set (Phase 3 P3-O).
    // Keep this list in sync with UNTRUSTED_WRAPPER_TAGS in that helper.
    // M2-U3: added untrusted_user_message (R29 LLM title prompt wrapper).
    // U3: added untrusted_prior_task_summary (agent task synth wrapper).
    // A1 fix: added untrusted_continuity_marker (U4 sentinel stub wrapper).
    cleaned = cleaned
      .replace(/<\/?untrusted_page_content>/gi, "[filtered]")
      .replace(/<\/?untrusted_skill_params>/gi, "[filtered]")
      .replace(/<\/?untrusted_tab_metadata>/gi, "[filtered]")
      .replace(/<\/?untrusted_user_message>/gi, "[filtered]")
      .replace(/<\/?untrusted_prior_task_summary>/gi, "[filtered]")
      .replace(/<\/?untrusted_continuity_marker>/gi, "[filtered]")
      .replace(/<\/?untrusted_page_quote>/gi, "[filtered]")
      .replace(/<\/?untrusted_page_element>/gi, "[filtered]")
      .replace(/<\/?untrusted_skill_content>/gi, "[filtered]")
      .replace(/<\/?untrusted_compacted_steps>/gi, "[filtered]");
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

  // MUST stay in sync with MAX_ELEMENTS_PER_FRAME in ./types.ts. This injected
  // function is serialized via chrome.scripting.executeScript and cannot import
  // external constants — duplication is intentional, not a smell.
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

    // ── Element-level semantic resolution (#44 P0) ──

    // Helper: walk aria-labelledby / aria-describedby id list and concat
    // referenced nodes' innerText. Used by both label (labelledby) and
    // error (describedby).
    function resolveAriaIdRefs(idList: string): string {
      const ids = idList.split(/\s+/).filter(Boolean);
      const parts: string[] = [];
      for (const id of ids) {
        const ref = document.getElementById(id);
        if (!ref) continue;
        const txt = (ref as HTMLElement).innerText?.trim();
        if (txt) parts.push(txt);
      }
      return parts.join(" ");
    }

    // Form label fallback chain (W3C accessible-name aligned).
    // Priority: <label for> → aria-labelledby → ancestor <label>.
    // Dedupe against ariaLabel/placeholder (NOT against text — innerText is
    // a button's own text, not a label).
    let resolvedLabel: string | undefined;
    if (el.id) {
      try {
        const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const txt = (labelEl as HTMLElement | null)?.innerText?.trim();
        if (txt) resolvedLabel = txt;
      } catch {
        // CSS.escape should never throw on a valid string; guard for safety.
      }
    }
    if (!resolvedLabel) {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const txt = resolveAriaIdRefs(labelledBy);
        if (txt) resolvedLabel = txt;
      }
    }
    if (!resolvedLabel) {
      const ancestorLabel = el.closest("label");
      if (ancestorLabel) {
        // Clone and remove descendant form controls to get label text only.
        const clone = ancestorLabel.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("input, textarea, select, button").forEach((n) => n.remove());
        const txt = clone.innerText?.trim();
        if (txt) resolvedLabel = txt;
      }
    }

    let label: string | undefined;
    if (resolvedLabel) {
      const labelTrim = resolvedLabel.trim();
      const ariaLabelTrim = (ariaLabel ?? "").trim();
      const placeholderTrim = (placeholder ?? "").trim();
      const isDuplicate =
        (ariaLabelTrim && labelTrim === ariaLabelTrim) ||
        (placeholderTrim && labelTrim === placeholderTrim);
      if (!isDuplicate) {
        label = sanitizeText(labelTrim, 80);
      }
    }

    // Error: aria-invalid=true + aria-describedby refs.
    let error: string | undefined;
    if (el.getAttribute("aria-invalid") === "true") {
      const describedBy = el.getAttribute("aria-describedby");
      if (describedBy) {
        const txt = resolveAriaIdRefs(describedBy);
        if (txt) error = sanitizeText(txt, 120);
      }
    }

    return {
      index: idx,
      tag,
      ...(type !== undefined ? { type } : {}),
      ...(role !== undefined ? { role } : {}),
      text,
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(ariaLabel !== undefined ? { ariaLabel } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(error !== undefined ? { error } : {}),
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

  // ── Page-level semantic (#44 P0): headings / alerts / status ──

  // Helper: collect distinct visible elements matching `selector`, capped
  // at `max`, mapping each via `mapper` and skipping empty results.
  function collectSemanticTexts(
    selector: string,
    max: number,
    perItemCap: number,
  ): string[] {
    const out: string[] = [];
    const seen = new Set<Element>();
    const matches = document.querySelectorAll(selector);
    for (const el of Array.from(matches)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;
      const raw = (el as HTMLElement).innerText?.trim();
      if (!raw) continue;
      const text = sanitizeText(raw, perItemCap);
      if (!text) continue;
      out.push(text);
      if (out.length >= max) break;
    }
    return out;
  }

  function collectHeadings(): Array<{ level: 1 | 2 | 3; text: string }> {
    const HEADING_SELECTOR =
      'h1, h2, h3, [role="heading"][aria-level="1"], [role="heading"][aria-level="2"], [role="heading"][aria-level="3"]';
    const out: Array<{ level: 1 | 2 | 3; text: string }> = [];
    const matches = document.querySelectorAll(HEADING_SELECTOR);
    for (const el of Array.from(matches)) {
      if (!isVisible(el)) continue;
      const raw = (el as HTMLElement).innerText?.trim();
      if (!raw) continue;
      const text = sanitizeText(raw, 80);
      if (!text) continue;
      // Resolve level: prefer aria-level when role=heading, else tag.
      let level: 1 | 2 | 3;
      const ariaLevel = el.getAttribute("aria-level");
      if (ariaLevel === "1") level = 1;
      else if (ariaLevel === "2") level = 2;
      else if (ariaLevel === "3") level = 3;
      else {
        const tag = el.tagName.toLowerCase();
        if (tag === "h1") level = 1;
        else if (tag === "h2") level = 2;
        else level = 3;
      }
      out.push({ level, text });
      if (out.length >= 8) break;
    }
    return out;
  }

  const semantic = {
    headings: collectHeadings(),
    alerts: collectSemanticTexts(
      '[role="alert"], [aria-live="assertive"]',
      5,
      200,
    ),
    status: collectSemanticTexts(
      '[role="status"], [aria-live="polite"]',
      3,
      100,
    ),
  };

  return {
    url: location.href,
    title: document.title,
    elements,
    semantic,
  };
}
