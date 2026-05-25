/**
 * Shadow-DOM-aware DOM walker. Yields elements in document order, descending
 * into open shadow roots. closed shadow roots are not traversable by spec.
 *
 * The walker yields `root` itself when it is an Element. Then descends via
 * TreeWalker (light tree). Open shadow roots encountered during traversal are
 * queued and walked after the current light-tree pass completes, preserving a
 * breadth-first shadow-slot order (light-DOM siblings before shadow children).
 */
export function* walkDeep(root: Node): IterableIterator<Element> {
  if (root instanceof Element) yield root;
  const doc = root.ownerDocument ?? document;
  const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const shadowRoots: ShadowRoot[] = [];
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
