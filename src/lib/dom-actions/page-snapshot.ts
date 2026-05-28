export interface ScrollableHint {
  region: string;
  pieIdx: number | null;
  visibleCount: number;
  estimatedTotal: number;
}

export interface PageSnapshotResult {
  html: string;
  scrollableHints: ScrollableHint[];
}

/**
 * Self-contained injected function. Runs via chrome.scripting.executeScript.
 * NO imports, NO outer-scope closures. All helpers nested inside.
 *
 * Returns the per-frame stripped HTML and detected scrollable region hints.
 *
 * Duplication of walkDeep / strip logic from dom-walk.ts and html-strip.ts is
 * intentional — executeScript serializes the function body, so all helpers must
 * be nested inside with no external references.
 */
export function pageSnapshotInjected(): PageSnapshotResult {
  // ── Constants ──
  const ATTR_WHITELIST = new Set([
    "href", "src", "alt", "role", "type", "value", "checked", "disabled",
    "placeholder", "for", "name", "id", "data-pie-idx", "data-pie-iframe-position",
    "lang", "dir", "open", "selected", "required", "title",
  ]);

  const TAG_WHITELIST = new Set([
    "a", "button", "input", "select", "option", "textarea", "label", "form",
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tr", "td", "th",
    "nav", "main", "header", "footer", "aside", "section", "article",
    "div", "span", "img", "figure", "figcaption", "code", "pre", "blockquote",
    "dialog", "details", "summary", "iframe", "hr", "br", "svg",
  ]);

  const TAG_DELETE = new Set(["script", "style", "noscript", "template"]);

  const UNSAFE_URL = /^\s*(javascript|data):/i;

  const WRAPPER_TAGS_LIST = [
    "untrusted_page_content", "untrusted_skill_params", "untrusted_tab_metadata",
    "untrusted_user_message", "untrusted_prior_task_summary",
    "untrusted_continuity_marker", "untrusted_page_quote", "untrusted_page_element",
    "untrusted_skill_content", "untrusted_compacted_steps", "untrusted_search_result",
    "untrusted_pdf_page",
  ];
  const WRAPPER_TAGS = new Set(WRAPPER_TAGS_LIST);

  // Pre-compiled regex applied to innerHTML AFTER DOM processing — handles
  // end-only tags that HTML parsers strip before they reach the DOM.
  const WRAPPER_TAG_RE = new RegExp(
    `<\\/?(?:${WRAPPER_TAGS_LIST.join("|")})[^>]*>`,
    "gi",
  );

  const INTERACTIVE_SELECTOR = [
    "a", "button", "input", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="menuitem"]', '[contenteditable="true"]',
    "summary", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  const SCROLL_RATIO_THRESHOLD = 1.2;

  // Control characters to strip from text nodes (ASCII-clean \uXXXX escapes).
  // Stripped ranges:
  //   U+0000-U+0008  C0 controls before HT
  //   U+000B-U+000C  VT, FF
  //   U+000E-U+001F  remaining C0 controls
  //   U+007F         DEL
  //   U+0080-U+009F  C1 controls
  //   U+200B-U+200F  zero-width space/ZWNJ/ZWJ/LRM/RLM
  //   U+2028-U+202F  line/para separators, narrow NBSP, directional marks
  //   U+FEFF         BOM / zero-width no-break space
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHAR_RE = new RegExp(
    "[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028-\u202f\ufeff]",
    "g",
  );

  // ── Nested helpers ──

  /**
   * Shadow-DOM-aware generator — deferred traversal: light DOM first via
   * TreeWalker, then queued shadow roots in encounter order. Matches
   * dom-walk.ts walkDeep exactly (deferred pattern, not inline recursion).
   */
  function* walkDeep(root: Node): IterableIterator<Element> {
    if (root instanceof Element) yield root;
    const doc = (root as Element).ownerDocument ?? document;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const shadowRoots: ShadowRoot[] = [];
    if (root instanceof Element && root.shadowRoot && root.shadowRoot.mode === "open") {
      shadowRoots.push(root.shadowRoot);
    }
    let node: Element | null;
    while ((node = tw.nextNode() as Element | null)) {
      yield node;
      if (node.shadowRoot && node.shadowRoot.mode === "open") {
        shadowRoots.push(node.shadowRoot);
      }
    }
    for (const sr of shadowRoots) {
      yield* walkDeep(sr);
    }
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    const tag = el.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && (rect.width < 8 || rect.height < 8)) {
      return false;
    }
    if (style.position !== "fixed" && (el as HTMLElement).offsetParent === null) return false;
    return true;
  }

  function sanitizeText(s: string): string {
    return s.replace(CONTROL_CHAR_RE, "");
  }

  function escapeWrapperMarkup(s: string): string {
    return s.replace(WRAPPER_TAG_RE, "[filtered]");
  }

  function isAttrAllowed(name: string): boolean {
    if (ATTR_WHITELIST.has(name)) return true;
    if (name.startsWith("aria-")) return true;
    return false;
  }

  // ── Step A: clone document.body (don't mutate live DOM for value/checked/open) ──
  const cloneRoot = document.body.cloneNode(true) as HTMLElement;

  // ── Step A1: inject open shadow root content into clone ──
  // cloneNode(true) does NOT copy shadow roots (by spec). Walk the live DOM and
  // for each element with an open shadow root, find its positional twin in the
  // clone and replace its content with the shadow root's serialized HTML. This
  // gives the LLM visibility into shadow DOM content.
  {
    const liveForShadow = [...walkDeep(document.body)];
    const cloneForShadow = [...walkDeep(cloneRoot)];
    for (let i = 0; i < liveForShadow.length && i < cloneForShadow.length; i++) {
      const livEl = liveForShadow[i];
      if (livEl.shadowRoot && livEl.shadowRoot.mode === "open") {
        // Overwrites clone host's light-DOM children; shadow content takes
        // precedence since that's what the user actually sees (slotted light
        // children render inside the shadow tree).
        try {
          // ShadowRoot.innerHTML serialization is the portable approach —
          // ShadowRoot.cloneNode() is required to throw NotSupportedError per
          // spec (Chrome currently returns empty fragment but may tighten).
          cloneForShadow[i].innerHTML = livEl.shadowRoot.innerHTML;
        } catch {
          // shadow content not serializable — leave clone host empty
        }
      }
    }
  }

  // ── Step B: IDL reflect on the LIVE DOM elements, mirrored into clone ──
  // We walk live and clone in parallel (same structure post-clone).
  // Reflection writes attrs onto the clone only — live DOM value attrs untouched.
  const liveBodyElements = [...walkDeep(document.body)];
  const cloneBodyElements = [...walkDeep(cloneRoot)];

  for (let i = 0; i < liveBodyElements.length && i < cloneBodyElements.length; i++) {
    const live = liveBodyElements[i];
    const clone = cloneBodyElements[i];

    if (live instanceof HTMLInputElement) {
      const t = (live.type ?? "").toLowerCase();
      const auto = (live.getAttribute("autocomplete") ?? "").toLowerCase();
      const isCredential = t === "password" || auto.includes("one-time-code");
      if (!isCredential && live.value) clone.setAttribute("value", live.value);
      if (live.checked) clone.setAttribute("checked", "");
    } else if (live instanceof HTMLTextAreaElement && live.value) {
      (clone as HTMLTextAreaElement).textContent = live.value;
    } else if (live instanceof HTMLOptionElement && live.selected) {
      clone.setAttribute("selected", "");
    } else if (live instanceof HTMLDetailsElement && live.open) {
      clone.setAttribute("open", "");
    }
  }

  // ── Step C0: stamp data-pie-iframe-position on each iframe in the clone ──
  // SW handler uses this to map to chrome frameId after webNavigation.getAllFrames.
  // Inner placeholder text gives the LLM a visual anchor.
  {
    let iframePos = 0;
    for (const el of cloneBodyElements) {
      if (el.tagName.toLowerCase() === "iframe") {
        el.setAttribute("data-pie-iframe-position", String(iframePos));
        el.textContent = "[iframe placeholder]";
        iframePos++;
      }
    }
  }

  // ── Step C: stamp data-pie-idx on visible interactive elements ──
  // Stamp on LIVE DOM (so click/type handlers can find elements by idx) AND
  // mirror to corresponding clone elements (so serialized HTML carries the attr).
  // Clear prior stamps first.
  for (const el of liveBodyElements) {
    if (el.hasAttribute("data-pie-idx")) el.removeAttribute("data-pie-idx");
  }

  const liveToCloneMap = new Map<Element, Element>();
  for (let i = 0; i < liveBodyElements.length && i < cloneBodyElements.length; i++) {
    liveToCloneMap.set(liveBodyElements[i], cloneBodyElements[i]);
  }

  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      const idxStr = String(stampIdx++);
      el.setAttribute("data-pie-idx", idxStr);
      const cloneEl = liveToCloneMap.get(el);
      if (cloneEl) cloneEl.setAttribute("data-pie-idx", idxStr);
    }
  }

  // ── Step D: strip clone (4-pass, mirrors html-strip.ts stripToWhitelist) ──

  // Pass 1: delete / collapse tags. Materialize the list upfront (we mutate the tree).
  const removed = new Set<Element>();
  for (const el of [...walkDeep(cloneRoot)]) {
    if (removed.has(el) || !el.parentNode) continue;
    const tag = el.tagName.toLowerCase();

    if (TAG_DELETE.has(tag)) {
      el.remove();
      removed.add(el);
      continue;
    }

    if (tag === "svg") {
      const titleEl = el.querySelector("title");
      const titleText = titleEl?.textContent?.trim();
      el.innerHTML = "";
      if (titleText) el.setAttribute("aria-label", sanitizeText(titleText));
      continue;
    }

    if (tag === "iframe") {
      el.removeAttribute("src");
      continue;
    }

    if (WRAPPER_TAGS.has(tag)) {
      // Wrapper tags are injection-escape sentinels — replace entirely with [filtered].
      const placeholder = el.ownerDocument!.createTextNode("[filtered]");
      el.replaceWith(placeholder);
      removed.add(el);
    } else if (!TAG_WHITELIST.has(tag)) {
      // Collapse to div: move children into a new div, replace the element.
      const div = el.ownerDocument!.createElement("div");
      while (el.firstChild) div.appendChild(el.firstChild);
      el.replaceWith(div);
      removed.add(el);
    }
  }

  // Pass 2: strip non-whitelisted attributes + unsafe URLs.
  for (const el of walkDeep(cloneRoot)) {
    const attrs = [...el.attributes];
    for (const a of attrs) {
      const name = a.name.toLowerCase();
      if (!isAttrAllowed(name)) {
        el.removeAttribute(a.name);
        continue;
      }
      if ((name === "href" || name === "src") && UNSAFE_URL.test(a.value)) {
        el.removeAttribute(a.name);
      }
    }
  }

  // Pass 3: strip control characters from text nodes.
  const textWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let tn: Text | null;
  while ((tn = textWalker.nextNode() as Text | null)) textNodes.push(tn);
  for (const textNode of textNodes) {
    textNode.nodeValue = sanitizeText(textNode.nodeValue ?? "");
  }

  // Pass 4: delete empty elements (no text, no attrs, no children). Bottom-up.
  const allCloneEls = [...walkDeep(cloneRoot)];
  for (let i = allCloneEls.length - 1; i >= 0; i--) {
    const el = allCloneEls[i];
    if (el === cloneRoot) continue;
    if (!el.parentNode) continue; // already removed
    const tag = el.tagName.toLowerCase();
    // Always keep void / embed elements even when "empty". svg exempt because
    // Pass 1 deliberately clears its children — the shell must survive without title.
    if (tag === "img" || tag === "input" || tag === "br" || tag === "hr" || tag === "iframe" || tag === "svg") continue;
    const hasText = (el.textContent?.trim() ?? "") !== "";
    const hasAttrs = el.attributes.length > 0;
    const hasChildren = el.children.length > 0;
    if (!hasText && !hasAttrs && !hasChildren) {
      el.remove();
    }
  }

  // Serialize and neutralize any wrapper-tag markup that survived HTML parsing
  // (e.g. open tags like <untrusted_page_content> that became DOM elements)
  // or that were re-introduced during serialization.
  const html = escapeWrapperMarkup(cloneRoot.innerHTML);

  // ── Step E: scrollable detection on LIVE DOM ──
  const scrollableHints: ScrollableHint[] = [];
  for (const el of liveBodyElements) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = window.getComputedStyle(el);
    const scrollable =
      cs.overflow === "auto" || cs.overflow === "scroll" ||
      cs.overflowY === "auto" || cs.overflowY === "scroll";
    if (!scrollable) continue;
    if (el.scrollHeight <= el.clientHeight * SCROLL_RATIO_THRESHOLD) continue;
    const role = el.getAttribute("role");
    const visibleChildren = Array.from(el.children).filter((c) => isVisible(c)).length;
    const ratio = el.scrollHeight / Math.max(el.clientHeight, 1);
    scrollableHints.push({
      region: role ?? el.tagName.toLowerCase(),
      pieIdx: el.hasAttribute("data-pie-idx") ? Number(el.getAttribute("data-pie-idx")) : null,
      visibleCount: visibleChildren,
      estimatedTotal: Math.round(visibleChildren * ratio),
    });
  }

  return { html, scrollableHints };
}
