const HOST_ATTR = "data-pie-quote-bubble";
const BUBBLE_HEIGHT = 28;
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
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.06);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 80ms ease;
      }
      .b:hover { transform: translateY(-1px); }
      .b:active { transform: translateY(0); }
      .b svg { display: block; }
    </style>
    <button class="b" type="button" aria-label="添加为引用" title="添加为引用">
      <svg width="28" height="28" viewBox="0 0 128 128" aria-hidden="true">
        <rect width="128" height="128" rx="26" fill="#14181D"/>
        <circle cx="64" cy="64" r="44" fill="#FAFBFC"/>
        <circle cx="98" cy="30" r="22" fill="#14181D"/>
      </svg>
    </button>
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
