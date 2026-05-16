import { extractElementQuotePayload } from "./bbox-extractor";
import { safeSendMessage } from "./safe-send-message";

const HOST_ATTR = "data-pie-quote-picker";

let picking = false;
let host: HTMLElement | null = null;
let outline: HTMLDivElement | null = null;
let labelEl: HTMLDivElement | null = null;
let lastTarget: Element | null = null;

function ensureOverlay(): void {
  if (host) return;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
      .o {
        position: absolute;
        border: 2px solid #6bd49f;
        box-shadow: 0 0 0 3px rgba(107,212,159,0.18);
        background: transparent;
        pointer-events: none;
        transition: none;
      }
      .l {
        position: absolute;
        background: #6bd49f;
        color: #0b1f15;
        font: 600 10.5px/1 ui-monospace, "SF Mono", monospace;
        padding: 2px 8px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
      }
    </style>
    <div class="o" hidden></div>
    <div class="l" hidden></div>
  `;
  outline = shadow.querySelector<HTMLDivElement>(".o");
  labelEl = shadow.querySelector<HTMLDivElement>(".l");
  document.documentElement.appendChild(host);
}

function destroyOverlay(): void {
  host?.remove();
  host = null;
  outline = null;
  labelEl = null;
  lastTarget = null;
}

function onMouseMove(e: MouseEvent): void {
  if (!picking || !outline || !labelEl) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target === lastTarget) return;
  lastTarget = target;
  const r = target.getBoundingClientRect();
  outline.style.top = `${r.top}px`;
  outline.style.left = `${r.left}px`;
  outline.style.width = `${r.width}px`;
  outline.style.height = `${r.height}px`;
  outline.hidden = false;
  const role = (target.getAttribute("role") || target.tagName.toLowerCase());
  const name = (target.getAttribute("aria-label") || target.textContent?.trim().slice(0, 40) || "");
  labelEl.textContent = `<${role}>${name ? " · " + JSON.stringify(name) : ""}`;
  labelEl.style.top = `${Math.max(0, r.top - 22)}px`;
  labelEl.style.left = `${r.left}px`;
  labelEl.hidden = false;
}

function onClickCapture(e: MouseEvent): void {
  if (!picking) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  const payload = extractElementQuotePayload(target, location.href);
  safeSendMessage({ type: "quote-element-captured", payload });
  exitPicker();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") exitPicker();
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  exitPicker();
}

export function enterPicker(): void {
  if (picking) return;
  picking = true;
  ensureOverlay();
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("contextmenu", onContextMenu, true);
}

export function exitPicker(): void {
  if (!picking) return;
  picking = false;
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("click", onClickCapture, true);
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("contextmenu", onContextMenu, true);
  destroyOverlay();
}

export function __test__isPicking(): boolean {
  return picking;
}
