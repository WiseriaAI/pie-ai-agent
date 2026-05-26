import { walkDeep } from "./dom-walk";

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
];
const WRAPPER_TAGS = new Set(WRAPPER_TAGS_LIST);

// Pre-compile regex for all wrapper tags (open + close + self-closing variants).
// Applied to innerHTML output AFTER DOM processing, because HTML parsers strip
// unknown end-only tags before they reach the DOM (e.g. </untrusted_page_content>).
const WRAPPER_TAG_RE = new RegExp(
  `<\\/?(?:${WRAPPER_TAGS_LIST.join("|")})[^>]*>`,
  "gi",
);

function escapeWrapperMarkup(s: string): string {
  return s.replace(WRAPPER_TAG_RE, "[filtered]");
}

// Matches zero-width and invisible Unicode control characters. Uses new RegExp()
// with \uXXXX string escapes so the source stays ASCII-clean (invisible chars
// in regex literals cause parse errors in some JS toolchains).
//
// Stripped ranges:
//   U+0000-U+0008  C0 controls before HT
//   U+000B-U+000C  VT, FF
//   U+000E-U+001F  remaining C0 controls
//   U+007F         DEL
//   U+0080-U+009F  C1 controls
//   U+200B-U+200F  zero-width space/ZWNJ/ZWJ/LRM/RLM
//   U+2028-U+202F  line/para separators, narrow NBSP, directional marks
//   U+FEFF         BOM / zero-width no-break space
const CONTROL_CHAR_RE = new RegExp(
  "[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028-\u202f\ufeff]",
  "g",
);

function sanitizeText(s: string): string {
  return s.replace(CONTROL_CHAR_RE, "");
}

function isAttrAllowed(name: string): boolean {
  if (ATTR_WHITELIST.has(name)) return true;
  if (name.startsWith("aria-")) return true;
  return false;
}

/**
 * Strip an in-memory DOM subtree to an HTML string using a strict
 * attribute + tag whitelist. Caller is responsible for cloning the subtree
 * before passing (this function mutates).
 *
 * Note: wrapper-tag neutralization (e.g. </untrusted_page_content>) is applied
 * to the serialized innerHTML output rather than to DOM text nodes, because HTML
 * parsers discard unknown end-only tags before they reach the DOM.
 */
export function stripToWhitelist(root: Element): string {
  // Track elements removed in Pass 1 so we can skip their descendants.
  const removed = new Set<Element>();

  // Pass 1: delete fully-disallowed subtrees and collapse non-whitelisted tags.
  // Materialize the list upfront since we will be mutating the tree.
  for (const el of [...walkDeep(root)]) {
    // Skip if an ancestor was already removed (el.parentNode will be null/detached).
    if (removed.has(el) || !el.parentNode) continue;
    const tag = el.tagName.toLowerCase();

    if (TAG_DELETE.has(tag)) {
      el.remove();
      removed.add(el);
      continue;
    }

    // svg: keep shell + optionally aria-label from <title>, strip all children.
    if (tag === "svg") {
      const titleEl = el.querySelector("title");
      const titleText = titleEl?.textContent?.trim();
      el.innerHTML = "";
      if (titleText) el.setAttribute("aria-label", sanitizeText(titleText));
      continue;
    }

    // iframe: always drop src (cross-origin; frame content handled via frame_map).
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
  for (const el of walkDeep(root)) {
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
  const doc = root.ownerDocument ?? document;
  const textWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let textNode: Text | null;
  while ((textNode = textWalker.nextNode() as Text | null)) textNodes.push(textNode);
  for (const t of textNodes) {
    t.nodeValue = sanitizeText(t.nodeValue ?? "");
  }

  // Pass 4: delete empty elements (no text, no attrs, no children). Bottom-up.
  const all = [...walkDeep(root)];
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    if (el === root) continue;
    if (!el.parentNode) continue; // already removed
    const tag = el.tagName.toLowerCase();
    // Always keep void / embed elements even when "empty". svg is exempt because
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
  return escapeWrapperMarkup(root.innerHTML);
}
