export interface SearchMatch {
  /** Nearest interactive ancestor's data-pie-idx, or null for plain text. */
  pieIdx: number | null;
  /** Lowercased tag name of the element directly containing the matched text. */
  tag: string;
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
}

export interface SearchPageParams {
  queries: string[];
  regex: boolean;
  mode: "all" | "interactive" | "text";
  maxResults: number;
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

  const SNIPPET_CONTEXT = 80;
  const TIME_BUDGET_MS = 1500;
  const MATCHED_MAX_LEN = 80;
  const MATCH_SCAN_LIMIT = 50_000;

  // VERBATIM copy of _shared/interactive.ts INTERACTIVE_SELECTOR (single string
  // literal). interactive-parity.test.ts guards this against drift.
  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';

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

  // ── stamp data-pie-idx (copied from page-snapshot.ts Step C) ──
  const liveBodyElements = [...walkDeep(document.body)];
  for (const el of liveBodyElements) {
    if (el.hasAttribute("data-pie-idx")) el.removeAttribute("data-pie-idx");
  }
  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      el.setAttribute("data-pie-idx", String(stampIdx++));
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

  // First hit within `scan`; returns {offset, matched} or null. Only the FIRST
  // match per element — no while-loop over the node, so empty-match regexes
  // (e.g. a*) cannot infinite-loop.
  function firstMatch(scan: string): { offset: number; matched: string } | null {
    let best: { offset: number; matched: string } | null = null;
    if (regex) {
      for (const re of regexes) {
        re.lastIndex = 0;
        const m = re.exec(scan);
        if (m && m[0] && (best === null || m.index < best.offset)) {
          best = { offset: m.index, matched: m[0].slice(0, MATCHED_MAX_LEN) };
        }
      }
    } else {
      const lower = scan.toLowerCase();
      for (const q of queries) {
        if (!q) continue;
        const idx = lower.indexOf(q.toLowerCase());
        if (idx !== -1 && (best === null || idx < best.offset)) {
          best = { offset: idx, matched: scan.slice(idx, idx + q.length) };
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
        matched: hit.matched,
        snippet: buildSnippet(text, hit.offset, hit.matched.length),
      });
    }
  }

  return { matches, total, timedOut, invalidRegex: null };
}
