/**
 * Shadow-DOM-aware DOM walker. Yields elements descending into open shadow
 * roots; closed shadow roots are not traversable by spec.
 *
 * Traversal order: light-DOM traversal first (document order via TreeWalker),
 * then queued shadow roots processed in encounter order with the same
 * light-first-then-shadow rule applied recursively. This ensures
 * `deepQuerySelectorAll` returns light-DOM matches before shadow-DOM matches.
 *
 * The walker yields `root` itself when it is an Element. If `root` is an
 * Element that has its own open shadow root, that shadow root is also walked
 * (queued before any shadow roots discovered during the light-tree pass).
 */
export function* walkDeep(root: Node): IterableIterator<Element> {
  if (root instanceof Element) yield root;
  const doc = root.ownerDocument ?? document;
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

export function deepQuerySelectorAll(root: Node, selector: string): Element[] {
  const out: Element[] = [];
  for (const el of walkDeep(root)) {
    if (el.matches?.(selector)) out.push(el);
  }
  return out;
}

/**
 * Visibility check tolerant to position:fixed and excluding IME-buffer
 * hidden inputs (opacity:0 or <8px). Mirrors snapshot.ts logic.
 */
export function isVisibleDeep(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = (el.ownerDocument?.defaultView ?? window).getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
  const tag = el.tagName.toLowerCase();
  if ((tag === "input" || tag === "textarea") && (rect.width < 8 || rect.height < 8)) {
    return false;
  }
  if (style.position !== "fixed" && (el as HTMLElement).offsetParent === null) {
    return false;
  }
  return true;
}
