export interface SearchMatch {
  /** Nearest interactive ancestor's data-pie-idx, or null for plain text. */
  pieIdx: number | null;
  /** Lowercased tag name of the element directly containing the matched text. */
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  contenteditable?: boolean;
  /** The matched term (substring mode) or the matched text (regex mode). */
  matched: string;
  /** up to ~80 chars of context on each side of the hit. */
  snippet: string;
}

export interface SearchPageResult {
  matches: SearchMatch[];
  /** Total hit elements found (before maxResults truncation). */
  total: number;
  /** True if the time-budget guard tripped mid-walk. */
  timedOut: boolean;
  /** Non-null = a regex term failed to compile; matches will be empty. */
  invalidRegex: string | null;
  /** Non-null = an attribute search term was malformed or unsupported. */
  invalidAttribute: string | null;
}

export interface SearchPageParams {
  queries: string[];
  regex: boolean;
  mode: "all" | "interactive" | "text";
  maxResults: number;
  searchBy: "text" | "role" | "tag" | "attribute";
}

/**
 * Self-contained injected function. Runs via chrome.scripting.executeScript.
 * NO imports, NO outer-scope closures — all helpers nested inside. Interface
 * type annotations are erased at compile time, so referencing them here does
 * NOT break self-containment (same pattern as page-snapshot.ts).
 *
 * The stamp logic (walkDeep / isVisible / INTERACTIVE_SELECTOR / clear+stamp)
 * is copied VERBATIM from page-snapshot.ts Step C so that data-pie-idx matches
 * read_page exactly. A cross-layer test (search-page idx-parity) guards drift.
 */
export function searchPageInjected(params: SearchPageParams): SearchPageResult {
  const { queries, regex, mode, maxResults } = params;
  const searchBy = params.searchBy ?? "text";

  const SNIPPET_CONTEXT = 80;
  const TIME_BUDGET_MS = 1500;
  const MATCHED_MAX_LEN = 80;
  const MATCH_SCAN_LIMIT = 50_000;
  const SUMMARY_TEXT_MAX = 120;
  const TEXT_SNIPPET_MAX_LEN = SNIPPET_CONTEXT * 2 + MATCHED_MAX_LEN + 2;

  // VERBATIM copy of _shared/interactive.ts INTERACTIVE_SELECTOR (single string
  // literal). interactive-parity.test.ts guards this against drift.
  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';

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
  ];
  const WRAPPER_TAG_RE = new RegExp(
    `<\\/?(?:${WRAPPER_TAGS_LIST.join("|")})[^>]*>`,
    "gi",
  );

  // eslint-disable-next-line no-control-regex
  const CONTROL_CHAR_RE = new RegExp(
    "[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028-\u202f\ufeff]",
    "g",
  );
  const SUMMARY_MARKUP_RE = /<\/?[a-z][a-z0-9_-]*(?:\s[^>]*)?>/gi;
  const ATTRIBUTE_SEARCH_ALLOWLIST = new Set([
    "contenteditable",
    "aria-label",
    "placeholder",
    "name",
    "type",
    "role",
  ]);

  // ── walkDeep — copied verbatim from page-snapshot.ts ──
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

  // ── isVisible — copied verbatim from page-snapshot.ts ──
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

  function isRescuableControl(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") return false;
    if (tag === "input" && (el as HTMLInputElement).type === "hidden") return false;
    return true;
  }

  function visibleLabelFor(el: Element): HTMLLabelElement | null {
    const labels = (el as HTMLInputElement).labels;
    if (!labels) return null;
    for (const l of labels) {
      if (isVisible(l)) return l;
    }
    return null;
  }

  // ── stamp data-pie-idx (copied from page-snapshot.ts Step C) ──
  const liveBodyElements = [...walkDeep(document.body)];
  for (const el of liveBodyElements) {
    if (el.hasAttribute("data-pie-idx")) el.removeAttribute("data-pie-idx");
  }
  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      el.setAttribute("data-pie-idx", String(stampIdx++));
    } else if (
      el.matches?.(INTERACTIVE_SELECTOR) &&
      isRescuableControl(el) &&
      !isVisible(el)
    ) {
      const label = visibleLabelFor(el);
      if (label && !label.hasAttribute("data-pie-idx")) {
        label.setAttribute("data-pie-idx", String(stampIdx++));
      }
    }
  }

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

  function sanitizeText(s: string): string {
    return s.replace(CONTROL_CHAR_RE, "");
  }

  function escapeWrapperMarkup(s: string): string {
    return s.replace(WRAPPER_TAG_RE, "[filtered]");
  }

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

  function sanitizeSearchText(s: string, maxLen: number): string {
    return sanitizeText(escapeWrapperMarkup(s))
      .replace(SUMMARY_MARKUP_RE, "[filtered]")
      .replace(/[<>]/g, "[filtered]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
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

    return { matches, total, timedOut, invalidRegex: null, invalidAttribute: null };
  }

  // ── compile regexes (gi) if needed ──
  let regexes: RegExp[] = [];
  if (regex) {
    try {
      regexes = queries.map((q) => new RegExp(q, "gi"));
    } catch (e) {
      return {
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

  return { matches, total, timedOut, invalidRegex: null, invalidAttribute: null };
}
