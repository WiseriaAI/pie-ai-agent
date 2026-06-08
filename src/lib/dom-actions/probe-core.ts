import type { InteractiveElementSummary } from "./interactive-summary";

export interface ScrollableHint {
  region: string;
  pieIdx: number | null;
  visibleCount: number;
  estimatedTotal: number;
}

export interface SearchMatch {
  pieIdx: number | null;
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  contenteditable?: boolean;
  matched: string;
  snippet: string;
}

export interface AtlasProbeControl {
  id: string;
  pieIdx: number;
  type: string;
  label: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface AtlasProbeForm {
  id: string;
  label: string;
  fields: string[];
  submitControlId?: string;
}

export interface AtlasProbeFieldGuess {
  name: string;
  confidence: "high" | "medium" | "low";
}

export interface AtlasProbeRecord {
  id: string;
  fields: Record<string, string>;
  text: string;
  evidence: string;
}

export interface AtlasProbeTarget {
  id: string;
  type: "collection" | "table" | "detail_region" | "region";
  label: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  fieldGuesses?: AtlasProbeFieldGuess[];
  columns?: string[];
  records?: AtlasProbeRecord[];
  visibleCount?: number;
  estimatedTotal?: number;
}

export interface AtlasProbeFingerprint {
  url: string;
  title: string;
  bodyTextLengthBucket: number;
  interactiveCountBucket: number;
  topSectionCount: number;
}

export type ProbeParams =
  | { op: "snapshot" }
  | { op: "atlas" }
  | {
      op: "search";
      queries: string[];
      regex: boolean;
      mode: "all" | "interactive" | "text";
      maxResults: number;
      searchBy: "text" | "role" | "tag" | "attribute";
    };

export type ProbeResult =
  | {
      op: "snapshot";
      html: string;
      interactiveElements: InteractiveElementSummary[];
      scrollableHints: ScrollableHint[];
    }
  | {
      op: "atlas";
      controls: AtlasProbeControl[];
      forms: AtlasProbeForm[];
      targets: AtlasProbeTarget[];
      fingerprint: AtlasProbeFingerprint;
    }
  | {
      op: "search";
      matches: SearchMatch[];
      total: number;
      timedOut: boolean;
      invalidRegex: string | null;
      invalidAttribute: string | null;
    };

/**
 * Self-contained injected function. Runs via chrome.scripting.executeScript.
 * NO imports, NO outer-scope closures. All helpers nested inside.
 *
 * Unifies pageSnapshotInjected (op:"snapshot") and searchPageInjected
 * (op:"search") behind a single op-dispatched entry. The snapshot branch is a
 * verbatim port of page-snapshot.ts (Step A→E). The shared nested helpers
 * (walkDeep / isVisible / sanitize / normalizeSpace / inferredRole /
 * accessibleName / editorEngineOf / cssEscape / stampLiveDom etc.) are written
 * ONCE here and reused by the search branch (Task 3).
 *
 * Duplication of walkDeep / strip logic from dom-walk.ts and html-strip.ts is
 * intentional — executeScript serializes the function body, so all helpers must
 * be nested inside with no external references. All constants are inlined as
 * VERBATIM copies of _shared/interactive.ts; parity tests guard against drift.
 */
export function probePageInjected(params: ProbeParams): ProbeResult {
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
    "untrusted_pdf_match",
    "untrusted_pdf_outline_entry",
    "untrusted_page_match",
    "untrusted_local_file",
    "untrusted_editor_content",
    "untrusted_scratchpad_preview",
  ];
  const WRAPPER_TAGS = new Set(WRAPPER_TAGS_LIST);

  // Pre-compiled regex applied to innerHTML AFTER DOM processing — handles
  // end-only tags that HTML parsers strip before they reach the DOM.
  const WRAPPER_TAG_RE = new RegExp(
    `<\\/?(?:${WRAPPER_TAGS_LIST.join("|")})[^>]*>`,
    "gi",
  );

  // VERBATIM copy of _shared/interactive.ts INTERACTIVE_SELECTOR (single string
  // literal). interactive-parity.test.ts guards this against drift.
  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';

  // Code editors render virtualized DOM (off-screen lines absent) and aren't
  // matched by INTERACTIVE_SELECTOR. We register the HOST so the agent can
  // discover it, click-focus it, and target read_editor / set_editor_value.
  const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";

  function editorEngineOf(el: Element): string | null {
    if (el.matches?.(".monaco-editor")) return "Monaco";
    if (el.matches?.(".cm-editor")) return "CodeMirror"; // CM6
    if (el.matches?.(".CodeMirror")) return "CodeMirror"; // CM5
    if (el.matches?.(".tox-tinymce")) return "TinyMCE";   // v5 / v6
    if (el.matches?.(".mce-tinymce")) return "TinyMCE";   // v4
    return null;
  }

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

  // ── Shared nested helpers (reused by both snapshot + search branches) ──

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

  // Rescue only checkbox/radio: a single CDP click on the label natively toggles
  // the control, which is the COMPLETE interaction. select/textarea/text inputs
  // would stamp the label but select_option/type reject a <label> target, so they
  // would be discoverable-but-not-operable — excluded to avoid misleading entries.
  function isRescuableControl(el: Element): boolean {
    if (el.tagName.toLowerCase() !== "input") return false;
    const type = (el as HTMLInputElement).type.toLowerCase();
    return type === "checkbox" || type === "radio";
  }

  // A form control filtered out by isVisible (e.g. a 1×1 framework toggle) is
  // still reachable if it has a VISIBLE associated <label>: clicking the label
  // drives the native label→control toggle plus any framework binding. Return
  // that label so the stamp pass can mark it as the control's proxy handle.
  function visibleLabelFor(el: Element): HTMLLabelElement | null {
    const labels = (el as HTMLInputElement).labels;
    if (!labels) return null;
    for (const l of labels) {
      if (isVisible(l)) return l;
    }
    return null;
  }

  function sanitizeText(s: string): string {
    return s.replace(CONTROL_CHAR_RE, "");
  }

  function escapeWrapperMarkup(s: string): string {
    return s.replace(WRAPPER_TAG_RE, "[filtered]");
  }

  const SUMMARY_TEXT_MAX = 120;
  const SUMMARY_MARKUP_RE = /<\/?[a-z][a-z0-9_-]*(?:\s[^>]*)?>/gi;

  function cssEscape(s: string): string {
    const css = window.CSS;
    if (css?.escape) return css.escape(s);
    return s.replace(/[\0-\x1f\x7f"'\\#.:,[\]()=<>+~*^$|!]/g, (ch) => `\\${ch}`);
  }

  function normalizeSpace(s: string): string {
    return sanitizeText(escapeWrapperMarkup(s))
      .replace(SUMMARY_MARKUP_RE, "[filtered]")
      .replace(/[<>]/g, "[filtered]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SUMMARY_TEXT_MAX);
  }

  function directText(el: Element): string {
    let s = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) s += child.nodeValue ?? "";
    }
    return normalizeSpace(s);
  }

  function descendantText(el: Element): string {
    return normalizeSpace(el.textContent ?? "");
  }

  function textById(id: string): string {
    const found = document.getElementById(id);
    return found ? normalizeSpace(found.textContent ?? "") : "";
  }

  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (label) return normalizeSpace(label.textContent ?? "");
    }
    const ancestorLabel = el.closest("label");
    if (ancestorLabel) return normalizeSpace(ancestorLabel.textContent ?? "");
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      return normalizeSpace(labelledBy.split(/\s+/).map(textById).filter(Boolean).join(" "));
    }
    return "";
  }

  function nearestSection(el: Element): string {
    let node: Element | null = el;
    while (node && node !== document.body) {
      const heading = node.querySelector?.("h1,h2,h3,[role='heading']");
      if (heading && heading !== el) {
        const text = normalizeSpace(heading.textContent ?? "");
        if (text) return text;
      }
      const aria = node.getAttribute?.("aria-label");
      const role = node.getAttribute?.("role");
      if (aria && role && /^(dialog|region|main|form|complementary|navigation)$/i.test(role)) {
        return normalizeSpace(aria);
      }
      node = node.parentElement;
    }
    return "";
  }

  function inferredRole(el: Element): string {
    if (editorEngineOf(el)) return "editor";
    const explicit = normalizeSpace(el.getAttribute("role") ?? "");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (el.getAttribute("contenteditable") === "true") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    return "";
  }

  function accessibleName(el: Element): string {
    const engine = editorEngineOf(el);
    if (engine) return `${engine} editor — use read_editor / set_editor_value (idx ${el.getAttribute("data-pie-idx") ?? "?"})`;
    const aria = normalizeSpace(el.getAttribute("aria-label") ?? "");
    if (aria) return aria;
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = normalizeSpace(labelled.split(/\s+/).map(textById).filter(Boolean).join(" "));
      if (text) return text;
    }
    const title = normalizeSpace(el.getAttribute("title") ?? "");
    if (title) return title;
    const name = normalizeSpace(el.getAttribute("name") ?? "");
    if (name) return name;
    return descendantText(el);
  }

  function interactiveSummary(el: Element): InteractiveElementSummary {
    // A rescued <label> stands in for its hidden control: derive all semantic
    // fields from the control so the agent sees the checkbox/select it operates,
    // while pieIdx stays on the label (whose geometry the CDP click targets).
    const rescuedControl =
      el.tagName.toLowerCase() === "label"
        ? (el as HTMLLabelElement).control
        : null;
    const target = rescuedControl ?? el;
    const tag = target.tagName.toLowerCase();
    const input = target instanceof HTMLInputElement ? target : null;
    const option = target instanceof HTMLOptionElement ? target : null;
    const pieIdx = Number(el.getAttribute("data-pie-idx") ?? "-1");
    return {
      pieIdx,
      tag,
      role: inferredRole(target),
      name: accessibleName(target),
      text: directText(target),
      placeholder: normalizeSpace(target.getAttribute("placeholder") ?? ""),
      label: labelFor(target),
      section: nearestSection(target),
      type: input ? input.type.toLowerCase() : normalizeSpace(target.getAttribute("type") ?? ""),
      contenteditable: target.getAttribute("contenteditable") === "true",
      disabled: target.hasAttribute("disabled"),
      checked: input ? input.checked : target.hasAttribute("checked"),
      selected: option ? option.selected : target.hasAttribute("selected"),
    };
  }

  function isAttrAllowed(name: string): boolean {
    if (ATTR_WHITELIST.has(name)) return true;
    if (name.startsWith("aria-")) return true;
    return false;
  }

  /**
   * Stamp data-pie-idx on visible interactive elements of the LIVE DOM and
   * (optionally) mirror onto corresponding clone elements via liveToCloneMap.
   * Clears any prior stamps first. Editor hosts are stamped as ONE entry; their
   * interactive descendants are skipped. Rescuable hidden controls have their
   * visible <label> stamped as a proxy handle.
   *
   * Returns the live element list (in walk order) so callers can build the
   * interactive-element summaries / search matches without re-walking.
   *
   * Shared between snapshot (passes liveToCloneMap to mirror into the clone)
   * and the future search branch (calls with an empty map — live-only stamps).
   */
  function stampLiveDom(
    liveBodyElements: Element[],
    liveToCloneMap: Map<Element, Element>,
  ): void {
    for (const el of liveBodyElements) {
      if (el.hasAttribute("data-pie-idx")) el.removeAttribute("data-pie-idx");
    }

    // Editor hosts: stamp the host itself and skip its interactive descendants
    // (e.g. Monaco's hidden .inputarea) so the editor surfaces as ONE entry.
    const editorHosts = liveBodyElements.filter(
      (el) => el.matches?.(EDITOR_SELECTOR) && isVisible(el),
    );

    let stampIdx = 0;
    const stamp = (el: Element): void => {
      const idxStr = String(stampIdx++);
      el.setAttribute("data-pie-idx", idxStr);
      const cloneEl = liveToCloneMap.get(el);
      if (cloneEl) cloneEl.setAttribute("data-pie-idx", idxStr);
    };

    for (const el of liveBodyElements) {
      const isEditorHost = editorHosts.includes(el);
      const insideEditor = !isEditorHost && editorHosts.some((h) => h.contains(el));
      if (insideEditor) continue;
      const isInteractive = isEditorHost || el.matches?.(INTERACTIVE_SELECTOR);
      if (isInteractive && isVisible(el) && !el.hasAttribute("data-pie-idx")) {
        stamp(el);
      } else if (isInteractive && isRescuableControl(el)) {
        const label = visibleLabelFor(el);
        if (label && !label.hasAttribute("data-pie-idx")) {
          stamp(label);
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // op:"snapshot" — verbatim port of pageSnapshotInjected Step A→E
  // ──────────────────────────────────────────────────────────────────────────
  if (params.op === "snapshot") {
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
      } else if (live instanceof HTMLTextAreaElement && live.value && isVisible(live)) {
        // Skip hidden textareas: a rich-text editor (TinyMCE etc.) keeps its
        // submit source in a display:none <textarea> whose value is serialized
        // HTML (e.g. "<p>…</p>"). Reflecting it would leak that markup into the
        // snapshot, misleading the LLM with content that diverges from what
        // read_editor returns. The editor surfaces as a role="editor" handle.
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
    const liveToCloneMap = new Map<Element, Element>();
    for (let i = 0; i < liveBodyElements.length && i < cloneBodyElements.length; i++) {
      liveToCloneMap.set(liveBodyElements[i], cloneBodyElements[i]);
    }

    stampLiveDom(liveBodyElements, liveToCloneMap);

    const interactiveElements: InteractiveElementSummary[] = [];
    for (const el of liveBodyElements) {
      if (el.hasAttribute("data-pie-idx")) {
        interactiveElements.push(interactiveSummary(el));
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

    return { op: "snapshot", html, interactiveElements, scrollableHints };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // op:"atlas" — compact page-world structure probe. This runs inside the page
  // and must stay self-contained, so it reuses only helpers nested above.
  // ──────────────────────────────────────────────────────────────────────────
  if (params.op === "atlas") {
    const liveBodyElements = [...walkDeep(document.body)];
    stampLiveDom(liveBodyElements, new Map<Element, Element>());

    function controlIdForPieIdx(pieIdx: number): string {
      return `ctrl_${pieIdx}`;
    }

    function atlasLabel(el: Element, fallback: string): string {
      return labelFor(el) || accessibleName(el) || nearestSection(el) || fallback;
    }

    function controlValue(el: Element): string | undefined {
      if (el instanceof HTMLInputElement) {
        if (el.type.toLowerCase() === "password") return undefined;
        return el.value || undefined;
      }
      if (el instanceof HTMLTextAreaElement) {
        return el.value || undefined;
      }
      if (el instanceof HTMLSelectElement) {
        return el.value || undefined;
      }
      return undefined;
    }

    function supportsDisabled(el: Element): boolean {
      const tag = el.tagName.toLowerCase();
      return tag === "button" || tag === "input" || tag === "select" ||
        tag === "textarea" || tag === "option" || tag === "fieldset";
    }

    function isAtlasVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
      return normalizeSpace(el.textContent ?? "") !== "";
    }

    function targetLabel(el: Element, fallback: string): string {
      return accessibleName(el) || nearestSection(el) || fallback;
    }

    function textFrom(el: Element | null | undefined): string {
      return el ? normalizeSpace(el.textContent ?? "") : "";
    }

    const controls: AtlasProbeControl[] = [];
    const controlByElement = new Map<Element, string>();
    for (const el of liveBodyElements) {
      if (!el.hasAttribute("data-pie-idx")) continue;
      const pieIdx = Number(el.getAttribute("data-pie-idx"));
      const tag = el.tagName.toLowerCase();
      const input = el instanceof HTMLInputElement ? el : null;
      const control: AtlasProbeControl = {
        id: controlIdForPieIdx(pieIdx),
        pieIdx,
        type: inferredRole(el) || tag,
        label: atlasLabel(el, tag),
      };
      if (supportsDisabled(el)) {
        control.disabled = el.hasAttribute("disabled");
      }
      if (input && (input.type.toLowerCase() === "checkbox" || input.type.toLowerCase() === "radio")) {
        control.checked = input.checked;
      }
      const value = controlValue(el);
      if (value !== undefined) control.value = value;
      controls.push(control);
      controlByElement.set(el, control.id);
    }

    const forms: AtlasProbeForm[] = [];
    const nativeForms = liveBodyElements.filter((el): el is HTMLFormElement => el instanceof HTMLFormElement);
    for (let i = 0; i < nativeForms.length; i++) {
      const form = nativeForms[i];
      const fields: string[] = [];
      const fieldEls = form.querySelectorAll("input,select,textarea");
      for (const field of fieldEls) {
        const id = controlByElement.get(field);
        if (id) fields.push(id);
      }

      const submit = form.querySelector("button,input[type='submit'],input[type='button']");
      const submitControlId = submit ? controlByElement.get(submit) : undefined;
      const atlasForm: AtlasProbeForm = {
        id: `form_f${i}`,
        label: accessibleName(form) || nearestSection(form) || `Form ${i + 1}`,
        fields,
      };
      if (submitControlId) atlasForm.submitControlId = submitControlId;
      forms.push(atlasForm);
    }

    const targets: AtlasProbeTarget[] = [];

    const tables = liveBodyElements.filter((el): el is HTMLTableElement => el instanceof HTMLTableElement);
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const headerCells = Array.from(table.querySelectorAll("thead th"));
      const firstRow = table.rows.item(0);
      const fallbackHeaderCells = headerCells.length > 0
        ? headerCells
        : Array.from(firstRow?.cells ?? []);
      const columns = fallbackHeaderCells
        .map((cell, idx) => textFrom(cell) || `Column ${idx + 1}`);

      const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
      const sourceRows = bodyRows.length > 0
        ? bodyRows
        : Array.from(table.rows).slice(headerCells.length > 0 ? 1 : 0);
      const visibleRows = sourceRows.filter((row) => isAtlasVisible(row));
      const records = visibleRows.slice(0, 25).map((row, rowIndex) => {
        const fields: Record<string, string> = {};
        const cellTexts: string[] = [];
        Array.from(row.cells).forEach((cell, idx) => {
          const key = columns[idx] || `Column ${idx + 1}`;
          const value = textFrom(cell);
          fields[key] = value;
          cellTexts.push(value);
        });
        return {
          id: `table_t${i}_r${rowIndex}`,
          fields,
          text: cellTexts.filter(Boolean).join(" "),
          evidence: "tr",
        };
      });

      targets.push({
        id: `table_t${i}`,
        type: "table",
        label: targetLabel(table, `Table ${i + 1}`),
        confidence: "high",
        summary: `${visibleRows.length} rows, ${columns.length} columns`,
        columns,
        records,
        visibleCount: visibleRows.length,
        estimatedTotal: visibleRows.length,
      });
    }

    function shapeKey(el: Element): string {
      const childTags = Array.from(el.children)
        .slice(0, 8)
        .map((child) => `${child.tagName.toLowerCase()}:${child.children.length}`)
        .join(",");
      const markers = [
        el.querySelector("a") ? "a" : "",
        el.querySelector("img") ? "img" : "",
        el.querySelector("h1,h2,h3,h4,h5,h6") ? "heading" : "",
        el.className && typeof el.className === "string" ? `class:${el.className.trim().split(/\s+/).sort().join(".")}` : "",
      ].filter(Boolean).join("|");
      return `${el.tagName.toLowerCase()}|${childTags}|${markers}`;
    }

    function fieldConfidence(name: string): "high" | "medium" | "low" {
      if (name === "title") return "high";
      if (name === "link") return "medium";
      return "low";
    }

    function fieldGuessesFromRecords(records: AtlasProbeRecord[]): AtlasProbeFieldGuess[] {
      const names = new Set<string>();
      for (const record of records) {
        for (const name of Object.keys(record.fields)) names.add(name);
      }
      return Array.from(names).map((name) => ({ name, confidence: fieldConfidence(name) }));
    }

    function collectionRecord(el: Element, id: string): AtlasProbeRecord {
      const link = el.querySelector("a[href]") as HTMLAnchorElement | null;
      const heading = el.querySelector("h1,h2,h3,h4,h5,h6");
      const fields: Record<string, string> = {};
      let evidence = "";
      if (link) {
        fields.title = normalizeSpace(link.textContent ?? "") || accessibleName(link);
        fields.link = link.getAttribute("href") || link.href;
        evidence = "a[href]";
      } else {
        const title = textFrom(heading) || directText(el) || descendantText(el);
        if (title) {
          fields.title = title;
          evidence = heading ? heading.tagName.toLowerCase() : el.tagName.toLowerCase();
        }
      }
      return {
        id,
        fields,
        text: descendantText(el),
        evidence: evidence || el.tagName.toLowerCase(),
      };
    }

    let collectionIndex = 0;
    const seenCollectionParents = new Set<Element>();
    for (const parent of liveBodyElements) {
      if (seenCollectionParents.has(parent)) continue;
      if (parent.closest("table")) continue;
      const visibleChildren = Array.from(parent.children).filter((child) => {
        if (child.closest("table")) return false;
        return isAtlasVisible(child);
      });
      if (visibleChildren.length < 3) continue;

      const groups = new Map<string, Element[]>();
      for (const child of visibleChildren) {
        const key = shapeKey(child);
        const group = groups.get(key) ?? [];
        group.push(child);
        groups.set(key, group);
      }

      for (const group of groups.values()) {
        if (group.length < 3) continue;
        seenCollectionParents.add(parent);
        const fallbackLabel = `Collection ${collectionIndex + 1}`;
        const collectionId = `collection_c${collectionIndex++}`;
        const records = group
          .slice(0, 20)
          .map((el, recordIndex) => collectionRecord(el, `${collectionId}_r${recordIndex}`));
        const label = targetLabel(parent, nearestSection(group[0]) || fallbackLabel);
        targets.push({
          id: collectionId,
          type: "collection",
          label,
          confidence: "medium",
          summary: `${group.length} repeated ${group[0].tagName.toLowerCase()} items`,
          fieldGuesses: fieldGuessesFromRecords(records),
          records,
          visibleCount: group.length,
          estimatedTotal: group.length,
        });
      }
    }

    function bucket(value: number, size: number): number {
      return Math.round(value / size) * size;
    }

    function fullTextLength(s: string): number {
      return sanitizeText(escapeWrapperMarkup(s))
        .replace(SUMMARY_MARKUP_RE, "[filtered]")
        .replace(/[<>]/g, "[filtered]")
        .replace(/\s+/g, " ")
        .trim()
        .length;
    }

    const fingerprint: AtlasProbeFingerprint = {
      url: window.location.href,
      title: document.title,
      bodyTextLengthBucket: bucket(fullTextLength(document.body.textContent ?? ""), 500),
      interactiveCountBucket: bucket(controls.length, 10),
      topSectionCount: document.querySelectorAll("main,section,article,nav,aside,header,footer").length,
    };

    return { op: "atlas", controls, forms, targets, fingerprint };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // op:"search" — ported from searchPageInjected, reusing the shared helpers
  // (walkDeep / isVisible / inferredRole [editor branch] / accessibleName /
  // normalizeSpace / labelFor / nearestSection / sanitizeText / cssEscape /
  // stampLiveDom) declared once above. Because inferredRole/accessibleName carry
  // the editor branch, searchBy=role "editor" now hits Monaco/CM/TinyMCE hosts.
  // ──────────────────────────────────────────────────────────────────────────
  const { queries, regex, mode, maxResults } = params;
  const searchBy = params.searchBy ?? "text";

  const SNIPPET_CONTEXT = 80;
  const TIME_BUDGET_MS = 1500;
  const MATCHED_MAX_LEN = 80;
  const MATCH_SCAN_LIMIT = 50_000;
  const TEXT_SNIPPET_MAX_LEN = SNIPPET_CONTEXT * 2 + MATCHED_MAX_LEN + 2;

  const ATTRIBUTE_SEARCH_ALLOWLIST = new Set([
    "contenteditable",
    "aria-label",
    "placeholder",
    "name",
    "type",
    "role",
  ]);

  // Stamp data-pie-idx on the live DOM with the SAME algorithm + helpers as the
  // snapshot branch (live-only — empty clone map). Guarantees idx parity with
  // read_page and gives editor hosts a single stamped entry.
  const liveBodyElements = [...walkDeep(document.body)];
  stampLiveDom(liveBodyElements, new Map<Element, Element>());

  // ── find nearest ancestor (incl. self) with data-pie-idx, crossing shadow ──
  function findPieIdx(start: Element): number | null {
    let node: Node | null = start;
    while (node) {
      if (node instanceof Element && node.hasAttribute("data-pie-idx")) {
        return Number(node.getAttribute("data-pie-idx"));
      }
      if (node instanceof ShadowRoot) {
        node = node.host;
      } else {
        node = node.parentNode;
      }
    }
    return null;
  }

  function sanitizeSearchText(s: string, maxLen: number): string {
    return sanitizeText(escapeWrapperMarkup(s))
      .replace(SUMMARY_MARKUP_RE, "[filtered]")
      .replace(/[<>]/g, "[filtered]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
  }

  function elementSnippet(el: Element): string {
    const role = inferredRole(el);
    const name = accessibleName(el);
    const label = labelFor(el);
    const placeholder = normalizeSpace(el.getAttribute("placeholder") ?? "");
    const text = directText(el);
    const section = nearestSection(el);
    return [
      el.tagName.toLowerCase(),
      role ? `role=${role}` : "",
      name ? `name=${name}` : "",
      label ? `label=${label}` : "",
      placeholder ? `placeholder=${placeholder}` : "",
      text ? `text=${text}` : "",
      section ? `section=${section}` : "",
    ].filter(Boolean).join(" ");
  }

  function buildElementMatch(el: Element, matched: string): SearchMatch {
    const input = el instanceof HTMLInputElement ? el : null;
    const pieIdx = findPieIdx(el);
    return {
      pieIdx,
      tag: el.tagName.toLowerCase(),
      role: inferredRole(el),
      name: accessibleName(el),
      label: labelFor(el),
      placeholder: normalizeSpace(el.getAttribute("placeholder") ?? ""),
      type: input ? input.type.toLowerCase() : normalizeSpace(el.getAttribute("type") ?? ""),
      contenteditable: el.getAttribute("contenteditable") === "true",
      matched,
      snippet: elementSnippet(el),
    };
  }

  function parseAttributeQuery(query: string): { name: string; value: string } | { error: string } {
    const eq = query.indexOf("=");
    if (eq <= 0) return { error: `invalid_attribute_query:${query}` };
    const name = query.slice(0, eq).trim().toLowerCase();
    const value = query.slice(eq + 1).trim().toLowerCase();
    if (!value) return { error: `invalid_attribute_query:${query}` };
    if (!ATTRIBUTE_SEARCH_ALLOWLIST.has(name)) return { error: `unsupported_attribute:${name}` };
    return { name, value };
  }

  function modeAllowsElement(el: Element): boolean {
    const pieIdx = findPieIdx(el);
    if (mode === "interactive" && pieIdx === null) return false;
    if (mode === "text" && pieIdx !== null) return false;
    return true;
  }

  function attrValue(el: Element, name: string): string {
    if (name === "role") return inferredRole(el).toLowerCase();
    if (name === "type" && el instanceof HTMLInputElement) return el.type.toLowerCase();
    return normalizeSpace(el.getAttribute(name) ?? "").toLowerCase();
  }

  // ── searchBy = role / tag / attribute (element-level, non-text) ──
  if (searchBy !== "text") {
    const startTime = performance.now();
    const matches: SearchMatch[] = [];
    let total = 0;
    let timedOut = false;

    const parsedAttributeQueries: ({ name: string; value: string } | { error: string })[] = [];
    if (searchBy === "attribute") {
      for (const q of queries) {
        const parsed = parseAttributeQuery(q);
        if ("error" in parsed) {
          return {
            op: "search",
            matches: [],
            total: 0,
            timedOut: false,
            invalidRegex: null,
            invalidAttribute: parsed.error,
          };
        }
        parsedAttributeQueries.push(parsed);
      }
    }

    for (const el of liveBodyElements) {
      if (performance.now() - startTime > TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }
      if (!modeAllowsElement(el)) continue;

      let matched = "";
      if (searchBy === "role") {
        const role = inferredRole(el).toLowerCase();
        for (const q of queries) {
          const needle = q.toLowerCase();
          if (needle && (role === needle || role.includes(needle))) {
            matched = role;
            break;
          }
        }
      } else if (searchBy === "tag") {
        const tag = el.tagName.toLowerCase();
        const virtualTags = el.getAttribute("contenteditable") === "true" ? ["contenteditable"] : [];
        for (const q of queries) {
          const needle = q.toLowerCase();
          if (needle && (tag === needle || virtualTags.includes(needle))) {
            matched = needle;
            break;
          }
        }
      } else if (searchBy === "attribute") {
        for (const q of parsedAttributeQueries) {
          if ("error" in q) continue;
          if (attrValue(el, q.name) === q.value) {
            matched = `${q.name}=${q.value}`;
            break;
          }
        }
      }

      if (!matched) continue;
      total++;
      if (matches.length < maxResults) {
        matches.push(buildElementMatch(el, matched));
      }
    }

    return { op: "search", matches, total, timedOut, invalidRegex: null, invalidAttribute: null };
  }

  // ── compile regexes (gi) if needed ──
  let regexes: RegExp[] = [];
  if (regex) {
    try {
      regexes = queries.map((q) => new RegExp(q, "gi"));
    } catch (e) {
      return {
        op: "search",
        matches: [],
        total: 0,
        timedOut: false,
        invalidRegex: e instanceof Error ? e.message : String(e),
        invalidAttribute: null,
      };
    }
  }

  function buildSnippet(text: string, offset: number, matchLen: number): string {
    const start = Math.max(0, offset - SNIPPET_CONTEXT);
    const end = Math.min(text.length, offset + matchLen + SNIPPET_CONTEXT);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + text.slice(start, end) + suffix;
  }

  // First hit within `scan`; returns {offset, matched, matchLen} or null. Only the FIRST
  // match per element — no while-loop over the node, so empty-match regexes
  // (e.g. a*) cannot infinite-loop.
  function firstMatch(scan: string): { offset: number; matched: string; matchLen: number } | null {
    let best: { offset: number; matched: string; matchLen: number } | null = null;
    if (regex) {
      for (const re of regexes) {
        re.lastIndex = 0;
        const m = re.exec(scan);
        if (m && m[0] && (best === null || m.index < best.offset)) {
          best = { offset: m.index, matched: m[0], matchLen: m[0].length };
        }
      }
    } else {
      const lower = scan.toLowerCase();
      for (const q of queries) {
        if (!q) continue;
        const idx = lower.indexOf(q.toLowerCase());
        if (idx !== -1 && (best === null || idx < best.offset)) {
          best = { offset: idx, matched: scan.slice(idx, idx + q.length), matchLen: q.length };
        }
      }
    }
    return best;
  }

  // ── searchBy = text (direct-text-node matching) ──
  const startTime = performance.now();
  const matches: SearchMatch[] = [];
  let total = 0;
  let timedOut = false;

  for (const el of liveBodyElements) {
    if (performance.now() - startTime > TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    // direct Text children only → attribute the hit to the closest element
    let direct = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) direct += child.nodeValue ?? "";
    }
    const text = direct.trim();
    if (!text) continue;

    const hit = firstMatch(text.slice(0, MATCH_SCAN_LIMIT));
    if (!hit) continue;

    const pieIdx = findPieIdx(el);
    if (mode === "interactive" && pieIdx === null) continue;
    if (mode === "text" && pieIdx !== null) continue;

    total++;
    if (matches.length < maxResults) {
      matches.push({
        pieIdx,
        tag: el.tagName.toLowerCase(),
        matched: sanitizeSearchText(hit.matched, MATCHED_MAX_LEN),
        snippet: sanitizeSearchText(
          buildSnippet(text, hit.offset, hit.matchLen),
          TEXT_SNIPPET_MAX_LEN,
        ),
      });
    }
  }

  return { op: "search", matches, total, timedOut, invalidRegex: null, invalidAttribute: null };
}
