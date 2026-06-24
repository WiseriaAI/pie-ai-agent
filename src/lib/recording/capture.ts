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
 *   - input/textarea/contenteditable 的逐键 'input' 事件经 500ms 防抖合并为一条
 *     type（按键级流水会爆量）；其余只监听 click / change / submit 这种语义事件
 *   - 不监听 mouse/key down/up
 *   - shadow DOM：经 composedPath() 穿透取真实目标 + 跨边界找交互祖先（input 事件
 *     是 composed，故 shadow 内表单输入也能录到；change 非 composed 则不行）
 *   - editor 宿主（Monaco/CodeMirror/TinyMCE）经 EDITOR_SELECTOR 识别（inline + parity）
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
  // Idempotent install: if a previous capture is already attached to this
  // page, don't double-attach. The orchestrator (Unit 5) re-injects after
  // hard navigation; in some race conditions (e.g. SW restart while page
  // navigates) the same install function could be called twice. Without
  // this guard, every user event would be sent to the SW twice.
  type WindowWithRecordingFlag = Window & { __pieRecordingInstalled?: boolean };
  const w = window as WindowWithRecordingFlag;
  if (w.__pieRecordingInstalled) {
    return () => {
      // Caller already has a previous uninstall reference; second-install
      // returns a no-op so the caller doesn't accidentally clear the flag
      // mid-recording.
    };
  }
  w.__pieRecordingInstalled = true;

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

  // VERBATIM copy of WRAPPER_TAGS_LIST from src/lib/dom-actions/_shared/interactive.ts
  // (same order). Cannot import at runtime — executeScript serializes function bodies.
  // untrusted-wrappers.test.ts dual-list lock-step guards this list against drift.
  const WRAPPER_TAGS_LIST = [
    "untrusted_page_content",
    "untrusted_skill_params",
    "untrusted_tab_metadata",
    "untrusted_user_message",
    "untrusted_prior_task_summary",
    "untrusted_continuity_marker",
    "untrusted_page_quote",
    "untrusted_page_element",
    "untrusted_skill_content",
    "untrusted_compacted_steps",
    "untrusted_search_result",
    "untrusted_pdf_page",
    "untrusted_pdf_match",
    "untrusted_pdf_outline_entry",
    "untrusted_page_match",
    "untrusted_local_file",
    "untrusted_editor_content",
    "untrusted_scratchpad_preview",
  ];
  const WRAPPER_TAGS_RE = new RegExp(
    `<\\/?(?:${WRAPPER_TAGS_LIST.join("|")})[^>]*>`,
    "gi",
  );

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

  // VERBATIM copy of EDITOR_SELECTOR / EDITOR_ENGINE_MAP from
  // src/lib/dom-actions/_shared/interactive.ts. Cannot import at runtime
  // (executeScript serializes function bodies). interactive-parity.test.ts
  // guards these literals against drift.
  const EDITOR_SELECTOR =
    ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";
  const EDITOR_ENGINE_MAP: Array<[string, string]> = [
    [".monaco-editor", "Monaco"],
    [".cm-editor", "CodeMirror"],
    [".CodeMirror", "CodeMirror"],
    [".tox-tinymce", "TinyMCE"],
    [".mce-tinymce", "TinyMCE"],
  ];
  function editorEngineOf(el: Element): string | null {
    const host = el.closest(EDITOR_SELECTOR);
    if (!host) return null;
    for (const [cls, engine] of EDITOR_ENGINE_MAP) {
      if (host.matches(cls)) return engine;
    }
    return "editor";
  }

  function buildLabelFor(el: HTMLElement): {
    label: string;
    selectorHint?: string;
    unstable: boolean;
  } {
    const editorEngine = editorEngineOf(el);
    if (editorEngine) {
      return { label: `${editorEngine} 编辑器`, unstable: false };
    }
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

  // Shadow-piercing event target resolution. composedPath() crosses shadow
  // boundaries (the page-context Event API; no import needed). Falls back to
  // e.target on engines without composedPath.
  function realTargetOf(e: Event): HTMLElement | null {
    const path = (e.composedPath?.() ?? []) as EventTarget[];
    const first = path[0];
    if (first instanceof HTMLElement) return first;
    const t = e.target;
    return t instanceof HTMLElement ? t : null;
  }
  function closestInPath(e: Event, el: HTMLElement, selector: string): HTMLElement | null {
    const path = (e.composedPath?.() ?? []) as EventTarget[];
    for (const n of path) {
      if (n instanceof HTMLElement && n.matches?.(selector)) return n;
    }
    return el.closest(selector) as HTMLElement | null;
  }

  const onClick = (e: Event) => {
    const target = realTargetOf(e);
    if (!target?.tagName) return;
    // VERBATIM copy of _shared/interactive.ts INTERACTIVE_SELECTOR.
    // interactive-parity.test.ts guards this literal against drift.
    const INTERACTIVE_SELECTOR =
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';
    const interactive = closestInPath(e, target, INTERACTIVE_SELECTOR);
    // 仅丢弃真正空的纯布局点击。带文本的容器/div 自定义按钮一律保留 ——
    // recorder 宁可多录也不漏录真实动作（漏录比噪声更糟）。
    if (!interactive && !(target.innerText?.trim())) return;
    // 点击绑定原生 checkbox/radio 的 <label>（文本或 for=）：浏览器会再合成一次
    // 对该 control 的 click，交给 onChange 记录带 checked 的那条；这里跳过，
    // 否则会双记，且回放时 label 点击 + 勾选两次 toggle 会把最终态弄反。
    if (!interactive) {
      const labelEl = target.closest("label") as HTMLLabelElement | null;
      const labelControl = (labelEl?.control ?? null) as HTMLInputElement | null;
      const lcType = labelControl?.type?.toLowerCase?.();
      if (labelControl && (lcType === "checkbox" || lcType === "radio")) {
        return;
      }
    }
    const el = interactive ?? target;
    // 原生 checkbox/radio 交给 onChange（它能同步拿到翻转后的 checked），
    // onClick 跳过以免双记。
    const tagLower = el.tagName.toLowerCase();
    const inputType = (el as HTMLInputElement).type?.toLowerCase?.();
    if (tagLower === "input" && (inputType === "checkbox" || inputType === "radio")) {
      return;
    }
    // 自定义可勾选元素（role=checkbox/radio/switch）：状态由页面 bubble handler
    // 翻转，capture-phase 此刻读到的是旧值，延迟到下一 tick 再读 aria-checked。
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const meta = buildLabelFor(el);
      const region = getRegion(el);
      setTimeout(() => {
        send({
          type: "click",
          label: meta.label,
          ...(meta.selectorHint ? { selectorHint: meta.selectorHint } : {}),
          checked: el.getAttribute("aria-checked") === "true",
          url: location.href,
          region,
          ...(meta.unstable ? { unstable: meta.unstable } : {}),
        });
      }, 0);
      return;
    }
    const { label, selectorHint, unstable } = buildLabelFor(el);
    // 落在弹出菜单/下拉里的项（role=menu/listbox/menuitem/option…）：回放时这些项
    // 往往要先悬停/点击触发器才能露出来。打个 fromPopup 标记，serialize 据此提示 LLM。
    let fromPopup = false;
    {
      let node: Element | null = el;
      let depth = 0;
      while (node && node !== document.body && depth < 12) {
        const r = (node.getAttribute?.("role") || "").toLowerCase();
        if (
          r === "menu" || r === "listbox" || r === "menuitem" ||
          r === "menuitemcheckbox" || r === "menuitemradio" || r === "option"
        ) {
          fromPopup = true;
          break;
        }
        node = node.parentElement;
        depth++;
      }
    }
    send({
      type: "click",
      label,
      ...(selectorHint ? { selectorHint } : {}),
      url: location.href,
      region: getRegion(el),
      ...(unstable ? { unstable } : {}),
      ...(fromPopup ? { fromPopup: true } : {}),
    });
  };

  const onChange = (e: Event) => {
    // change is NON-composed — it does not cross shadow boundaries. So this
    // listener only handles the toggle/select semantics that the composed input
    // path can't: native checkbox/radio (final checked state) and <select>
    // (chosen value). Free-text <input>/<textarea> values ride onInput→flushEdit
    // (composed, shadow-piercing); recording them here too would double-record.
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    const inputEl = target as HTMLInputElement;
    const { label, selectorHint, unstable } = buildLabelFor(target);

    // 原生 checkbox/radio：记成 click + 最终 checked 态（onClick 已跳过它们）。
    const inputTypeChange = inputEl.type?.toLowerCase?.();
    if (tag === "input" && (inputTypeChange === "checkbox" || inputTypeChange === "radio")) {
      send({
        type: "click",
        label,
        ...(selectorHint ? { selectorHint } : {}),
        checked: inputEl.checked,
        url: location.href,
        region: getRegion(target),
        ...(unstable ? { unstable } : {}),
      });
      return;
    }

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

  // Scroll capture — fires on user scroll on document (also catches programmatic
  // scroll triggered by user-typed Enter on a search box etc.). Debounced 500ms
  // because scroll fires every pixel — we only want one action per "scroll
  // gesture". Records the final scrollY position; replay reuses the existing
  // scroll tool which scrolls by amount, so the LLM derives the right call from
  // the natural-language label "向下滚动 / 向上滚动".
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEmittedScrollY = window.scrollY;
  const onScroll = () => {
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const currentY = window.scrollY;
      const delta = currentY - lastEmittedScrollY;
      // Skip noise — ignore tiny scroll bursts (e.g. focus jumps that move
      // by < 30px). User-intended scroll is typically multiple hundred px.
      if (Math.abs(delta) < 30) {
        scrollTimer = null;
        return;
      }
      const direction = delta > 0 ? "向下滚动" : "向上滚动";
      send({
        type: "scroll",
        label: direction,
        value: String(Math.abs(Math.round(delta))),
        url: location.href,
        region: "other",
      });
      lastEmittedScrollY = currentY;
      scrollTimer = null;
    }, 500);
  };

  // 文本输入（input/textarea 读 .value、contenteditable 读 innerText）—— 逐键
  // input 事件经 500ms 防抖合并为一条 type；500ms 内无新输入或失焦即落一条。
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editTarget: HTMLElement | null = null;
  const flushEdit = () => {
    if (!editTarget) return;
    const host = editTarget;
    editTarget = null;
    editTimer = null;
    const sens = detectSensitiveInline(host);
    const tag = host.tagName;
    const raw =
      tag === "INPUT" || tag === "TEXTAREA"
        ? (host as HTMLInputElement).value
        : host.innerText ?? host.textContent ?? "";
    const value = sens.redacted ? sens.placeholderName! : sanitizeText(raw, 200);
    const { label, selectorHint, unstable } = buildLabelFor(host);
    send({
      type: "type",
      label,
      ...(selectorHint ? { selectorHint } : {}),
      value,
      ...(sens.redacted ? { redacted: true, placeholderName: sens.placeholderName } : {}),
      url: location.href,
      region: getRegion(host),
      ...(unstable ? { unstable } : {}),
    });
  };
  const onInput = (e: Event) => {
    // input IS a composed event (crosses shadow boundaries), so resolve the real
    // target via composedPath — mirrors onClick. Two value-bearing host kinds ride
    // this debounced path: form controls (<input>/<textarea>, value read from
    // `.value`) and contenteditable (innerText). change/submit are non-composed and
    // never reach this document-level listener from inside a shadow root, so input
    // is the only path that captures shadow-encapsulated form edits.
    const t = realTargetOf(e);
    if (!t) return;
    const tag = t.tagName?.toLowerCase();
    let host: HTMLElement | null;
    if (tag === "input" || tag === "textarea") {
      // checkbox/radio toggles also fire input — they're recorded as click+checked
      // via onChange; skip here so we don't emit a bogus type action for them.
      const ty = (t as HTMLInputElement).type?.toLowerCase?.();
      if (ty === "checkbox" || ty === "radio") return;
      host = t;
    } else {
      host = closestInPath(e, t, '[contenteditable="true"]');
    }
    if (!host) return;
    editTarget = host;
    if (editTimer !== null) clearTimeout(editTimer);
    editTimer = setTimeout(flushEdit, 500);
  };

  // 键盘最小集：只记 Enter + 显式修饰组合键；纯字符/Tab/方向键/单独修饰键忽略。
  const onKeydown = (e: KeyboardEvent) => {
    if (e.isComposing) return; // IME 组合中，交给 contenteditable input 路径
    const k = e.key;
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    const isPlainChar = k.length === 1 && !hasMod;
    if (isPlainChar) return;
    if (k === "Shift" || k === "Control" || k === "Meta" || k === "Alt") return;
    // 注意：contenteditable 里也照记 Enter —— 很多聊天框 Enter = 发送，
    // 抑制会让回放丢失发送动作；与防抖 type 的轻微冗余可接受。
    if (!hasMod && k !== "Enter") return; // 无修饰时只放行 Enter

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.metaKey) parts.push("Cmd");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(k.length === 1 ? k.toUpperCase() : k);
    // 注：组合键（Cmd+B 等）作为意图上下文记录；回放的 press_key 工具只执行单键，
    // 组合键对 distill/回放 LLM 是提示性上下文，非可直接执行的步骤。
    send({
      type: "keypress",
      label: "",
      value: parts.join("+"),
      url: location.href,
      region: "other",
    });
  };

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);
  // scroll bubbles only on the element scrolled, not document — but
  // window-level scroll catches the common page-scroll case. Attaching to
  // both window and document covers both.
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("input", onInput, true);
  document.addEventListener("blur", flushEdit, true); // 失焦立即落一条，避免漏尾
  document.addEventListener("keydown", onKeydown, true);

  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("scroll", onScroll);
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("blur", flushEdit, true);
    if (editTimer !== null) clearTimeout(editTimer);
    document.removeEventListener("keydown", onKeydown, true);
    w.__pieRecordingInstalled = false;
  };
}
