const HOST_ATTR = "data-pie-quote-bubble";
const BUBBLE_HEIGHT = 34;
const MARGIN = 6;

let host: HTMLElement | null = null;
let currentClick: (() => void) | null = null;

function ensureHost(): HTMLElement {
  if (host) return host;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .b {
        background: #ffb95a;
        color: #1c1d22;
        font: 600 12px/1 -apple-system, "Helvetica Neue", sans-serif;
        padding: 7px 11px 7px 9px;
        border-radius: 999px;
        border: 0;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0,0,0,0.35);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .b::before {
        content: "+";
        background: rgba(28,29,34,0.18);
        width: 14px; height: 14px;
        border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 11px;
      }
    </style>
    <button class="b" type="button">添加为引用</button>
  `;
  shadow.querySelector<HTMLButtonElement>("button")!.addEventListener("click", () => {
    const cb = currentClick;
    hideBubble();
    cb?.();
  });
  document.documentElement.appendChild(host);
  return host;
}

export function showBubble(args: { anchorTop: number; anchorLeft: number; onClick: () => void }): void {
  const h = ensureHost();
  currentClick = args.onClick;
  const above = args.anchorTop - BUBBLE_HEIGHT - MARGIN;
  const top = above >= 0 ? above : args.anchorTop + MARGIN;
  h.style.top = `${Math.round(top)}px`;
  h.style.left = `${Math.round(Math.max(8, args.anchorLeft))}px`;
}

export function hideBubble(): void {
  if (!host) return;
  host.remove();
  host = null;
  currentClick = null;
}

export function __test__isVisible(): boolean {
  return host !== null;
}
