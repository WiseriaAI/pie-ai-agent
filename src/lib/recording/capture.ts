/**
 * Recording v1 — capture-phase DOM event listener.
 *
 * **Self-contained 注入函数**（与 dom-actions/* 同一模式）：无外部 import、无闭包、
 * 无 outer-scope 引用。被 chrome.scripting.executeScript 序列化后注入目标 tab。
 *
 * **职责**：在 capture phase 监听 click / change / submit 事件；提取 element meta；
 * 调内联 detect-sensitive；构造 CapturedActionPayload；用 chrome.runtime.sendMessage
 * 单次发回 SW（**不**用 port，因为 capture 上下文里访问不到 useSession 的 port）。
 *
 * 已知限制：
 *   - 不监听 'input' 事件（只 'change' / blur）—— 按键级流水会爆量
 *   - 不监听 mouse/key down/up（只 click / change / submit 这种语义事件）
 *   - 不处理 shadow DOM 内部元素（v1 不在范围）
 *
 * **buildLabelFor parity invariant** — wording must match selector.ts's
 * describeElement output character-for-character so the parity test passes
 * AND so users see the same label whether the action came through capture
 * (recording-time) or describeElement (a future re-serialize path). Notably:
 *   - nth-in-region fallback uses `${regionCn} 第 N 个${kind}` (with SPACE, no 区)
 *   - placeholder fallback uses `${kind} (placeholder='...')`
 *   - name fallback uses `${kind} (name='...')`
 *   - aria-label / text uses `${kind} '...'`
 */

import type { CapturedActionPayload } from "./types";

export function installCaptureListener(): () => void {
  // ── inline helpers (capture context — no outer imports) ──

  function getRegion(el: Element): string {
    let node: Element | null = el;
    while (node && node !== document.body) {
      const tag = node.tagName?.toLowerCase();
      const role = node.getAttribute("role")?.toLowerCase();
      if (tag === "main" || role === "main") return "main";
      if (tag === "nav" || role === "navigation") return "nav";
      if (tag === "header" || role === "banner") return "header";
      if (tag === "footer" || role === "contentinfo") return "footer";
      if (tag === "aside" || role === "complementary") return "aside";
      node = node.parentElement;
    }
    return "other";
  }

  // Strip C0 controls (U+0000-U+001F), DEL + C1 (U+007F-U+009F),
  // Arabic Letter Mark (U+061C), line/paragraph separators (U+2028-2029),
  // zero-width chars (U+200B-200F), bidi overrides (U+202A-202E),
  // Word Joiner (U+2060), directional isolates (U+2066-2069), BOM (U+FEFF).
  // Mirrors CONTROL_CHARS_RE in selector.ts.
  const CONTROL_CHARS_RE =
    /[\u0000-\u001f\u007f-\u009f\u061c\u2028-\u2029\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

  const WRAPPER_TAGS_RE =
    /<\/?(?:untrusted_page_content|untrusted_skill_params|untrusted_tab_metadata|untrusted_user_message|untrusted_prior_task_summary|untrusted_continuity_marker)>/gi;

  function sanitizeText(s: string, maxLen: number): string {
    if (!s) return "";
    let cleaned = s.replace(CONTROL_CHARS_RE, "");
    cleaned = cleaned.replace(WRAPPER_TAGS_RE, "[filtered]");
    if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen) + "...";
    return cleaned;
  }

  function detectSensitiveInline(el: HTMLElement): {
    redacted: boolean;
    placeholderName?: string;
  } {
    const inputEl = el as HTMLInputElement;
    if (inputEl.type === "password") return { redacted: true, placeholderName: "password" };
    const auto = (inputEl.autocomplete || "").toLowerCase();
    if (/^cc-(number|cvc|exp|csc)$/.test(auto)) {
      return { redacted: true, placeholderName: `cc_${auto.slice(3)}` };
    }
    if (/^(new-password|current-password)$/.test(auto)) {
      return { redacted: true, placeholderName: "password" };
    }
    const aria = el.getAttribute("aria-label") || "";
    const name = inputEl.name || "";
    const ph = inputEl.placeholder || "";
    let labelText = "";
    if (inputEl.id) {
      const lbl = document.querySelector<HTMLLabelElement>(`label[for="${inputEl.id}"]`);
      if (lbl?.textContent) labelText = lbl.textContent;
    }
    const re = /password|密码|secret|token|api[._\-\s]?key|\bauth(?:[._\-\s]|$)|cvv|cvc|otp|验证码/i;
    if (re.test(aria) || re.test(name) || re.test(ph) || re.test(labelText)) {
      const lower = (aria + " " + name + " " + ph + " " + labelText).toLowerCase();
      if (/password|密码/.test(lower)) return { redacted: true, placeholderName: "password" };
      if (/cvv|cvc/.test(lower)) return { redacted: true, placeholderName: "card_security_code" };
      if (/otp|验证码/.test(lower)) return { redacted: true, placeholderName: "verification_code" };
      if (/\bauth(?:[._\-\s]|$)/.test(lower)) return { redacted: true, placeholderName: "auth_value" };
      if (/token/.test(lower)) return { redacted: true, placeholderName: "token" };
      if (/api[._\-\s]?key/.test(lower)) return { redacted: true, placeholderName: "api_key" };
      if (/secret/.test(lower)) return { redacted: true, placeholderName: "secret" };
      return { redacted: true, placeholderName: "sensitive_value" };
    }
    return { redacted: false };
  }

  function elementKindCn(el: HTMLElement): string {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const map: Record<string, string> = {
      button: "按钮",
      link: "链接",
      tab: "标签页",
      checkbox: "复选框",
      radio: "单选框",
      switch: "开关",
      menuitem: "菜单项",
      option: "下拉选项",
    };
    if (role && map[role]) return map[role]!;
    const tag = el.tagName.toLowerCase();
    const tagMap: Record<string, string> = {
      a: "链接",
      button: "按钮",
      input: "输入框",
      textarea: "文本框",
      select: "下拉框",
      summary: "折叠标签",
    };
    return tagMap[tag] ?? "元素";
  }

  function buildLabelFor(el: HTMLElement): {
    label: string;
    selectorHint?: string;
    unstable: boolean;
  } {
    const aria = sanitizeText((el.getAttribute("aria-label") || "").trim(), 80);
    const text = sanitizeText((el as HTMLElement).innerText?.trim() ?? "", 80);
    const inputEl = el as HTMLInputElement;
    const placeholder = sanitizeText((inputEl.placeholder || "").trim(), 80);
    const name = sanitizeText((inputEl.name || "").trim(), 40);
    const id = inputEl.id?.trim();
    const dataTestId = el.getAttribute("data-testid")?.trim();
    const isSensitive = detectSensitiveInline(el).redacted;
    const kind = elementKindCn(el);

    let primary = "";
    let unstable = false;
    if (aria) primary = aria;
    else if (text) primary = text;
    else if (placeholder) primary = `(placeholder='${placeholder}')`;
    else if (name) primary = `(name='${name}')`;
    else {
      const region = getRegion(el);
      const regionRoot =
        region === "main" ? document.querySelector("main") :
        region === "nav" ? document.querySelector("nav") :
        region === "header" ? document.querySelector("header") :
        region === "footer" ? document.querySelector("footer") :
        region === "aside" ? document.querySelector("aside") :
        document.body;
      const sibs = Array.from(
        regionRoot?.querySelectorAll(el.tagName.toLowerCase()) ?? [],
      );
      const idx = sibs.indexOf(el) + 1;
      primary = `nth:${idx}`;
      unstable = true;
    }

    let label: string;
    if (primary.startsWith("(")) {
      label = `${kind} ${primary}`;
    } else if (primary.startsWith("nth:")) {
      // PARITY with selector.ts: `${regionCn} 第 N 个${kind}` (Unit 2 polish form).
      const region = getRegion(el);
      const regionCn = region === "other" ? "页面" : region;
      const idx = primary.slice(4);
      label = `${regionCn} 第 ${idx} 个${kind}`;
    } else {
      label = `${kind} '${primary}'`;
    }

    let selectorHint: string | undefined;
    if (!isSensitive) {
      if (dataTestId) {
        selectorHint = `[data-testid="${dataTestId.replace(/['"\\\n]/g, "\\$&")}"]`;
      } else if (id && !/password|secret|token|api|auth|pwd/i.test(id)) {
        selectorHint = `#${id.replace(/['"\\\n]/g, "\\$&")}`;
      } else if (name && !/password|secret|token|api|auth|pwd/i.test(name)) {
        // PARITY with selector.ts (Unit 2 polish): double-quoted attribute value.
        selectorHint = `${el.tagName.toLowerCase()}[name="${name.replace(/['"\\\n]/g, "\\$&")}"]`;
      }
    }

    return selectorHint !== undefined ? { label, selectorHint, unstable } : { label, unstable };
  }

  function send(payload: CapturedActionPayload) {
    try {
      window.chrome?.runtime?.sendMessage?.({ type: "recording-action", payload });
    } catch {
      // SW dead → recording aborted on reconnect; swallow here.
    }
  }

  // ── Listeners ──

  const onClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target?.tagName) return;
    const interactive = target.closest(
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], summary',
    ) as HTMLElement | null;
    const el = interactive ?? target;
    const { label, selectorHint, unstable } = buildLabelFor(el);
    send({
      type: "click",
      label,
      ...(selectorHint ? { selectorHint } : {}),
      url: location.href,
      region: getRegion(el),
      ...(unstable ? { unstable } : {}),
    });
  };

  const onChange = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    const inputEl = target as HTMLInputElement;
    const { label, selectorHint, unstable } = buildLabelFor(target);

    if (tag === "select") {
      send({
        type: "select",
        label,
        ...(selectorHint ? { selectorHint } : {}),
        value: inputEl.value,
        url: location.href,
        region: getRegion(target),
        ...(unstable ? { unstable } : {}),
      });
      return;
    }
    if (tag === "input" || tag === "textarea") {
      const sens = detectSensitiveInline(target);
      const value = sens.redacted ? sens.placeholderName! : inputEl.value;
      send({
        type: "type",
        label,
        ...(selectorHint ? { selectorHint } : {}),
        value,
        ...(sens.redacted ? { redacted: true, placeholderName: sens.placeholderName } : {}),
        url: location.href,
        region: getRegion(target),
        ...(unstable ? { unstable } : {}),
      });
    }
  };

  const onSubmit = (e: Event) => {
    const form = e.target as HTMLElement | null;
    if (!form) return;
    const { label, selectorHint, unstable } = buildLabelFor(form);
    send({
      type: "submit",
      label,
      ...(selectorHint ? { selectorHint } : {}),
      url: location.href,
      region: getRegion(form),
      ...(unstable ? { unstable } : {}),
    });
  };

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);

  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("submit", onSubmit, true);
  };
}
