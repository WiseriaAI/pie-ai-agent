import type { QuoteElementCapturedMessage } from "@/types";

type Payload = QuoteElementCapturedMessage["payload"];

function getRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  return el.tagName.toLowerCase();
}

function getAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ref = el.ownerDocument?.getElementById(labelledBy);
    if (ref?.textContent) return ref.textContent.trim();
  }

  const id = el.id;
  if (id) {
    const label = el.ownerDocument?.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) return label.textContent.trim();
  }

  const ancestorLabel = el.closest("label");
  if (ancestorLabel?.textContent) return ancestorLabel.textContent.trim();

  return (el.textContent ?? "").trim().split("\n")[0] ?? "";
}

export function extractElementQuotePayload(el: Element, sourceUrl: string): Payload {
  const rect = el.getBoundingClientRect();
  const text = (el.textContent ?? "").slice(0, 500);
  const outerHTML = (el as HTMLElement).outerHTML ?? "";
  return {
    bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    devicePixelRatio: window.devicePixelRatio,
    role: getRole(el),
    accessibleName: getAccessibleName(el),
    textContent: text,
    outerHTMLTruncated: outerHTML.slice(0, 1000),
    sourceUrl,
  };
}
