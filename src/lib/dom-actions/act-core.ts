/**
 * act-core.ts — Shadow-aware element locator + op-dispatched DOM actions.
 *
 * Self-contained constraint: `actByIdxInjected` is injected via
 * chrome.scripting.executeScript — no imports may be used inside the function
 * body at runtime. All helpers are nested inside the exported function.
 *
 * All five ops implemented: rect, type, select, focusClick, click.
 */

export type ActParams =
  | { op: "rect"; idx: number }
  | { op: "focusClick"; idx: number }
  | { op: "click"; idx: number }
  | { op: "type"; idx: number; text: string; clear: boolean }
  | { op: "select"; idx: number; value: string };

export type ActResult =
  | { ok: true; op: "rect"; rect: { x: number; y: number; w: number; h: number } }
  | { ok: true; op: "type"; observation: string }
  | { ok: true; op: "select"; observation: string }
  | { ok: true; op: "focusClick"; observation: string }
  | { ok: true; op: "click"; observation: string }
  | { ok: false; error: string };

export async function actByIdxInjected(params: ActParams): Promise<ActResult> {
  // Shadow-DOM-aware locator: walks open shadow roots recursively.
  // document.querySelector('[data-pie-idx=N]') does NOT pierce shadow roots,
  // but probe-core.ts stamps elements inside shadow trees — this closes the gap.
  function findByIdxDeep(idx: number): Element | null {
    const sel = `[data-pie-idx="${idx}"]`;

    function search(root: Document | ShadowRoot): Element | null {
      const direct = root.querySelector(sel);
      if (direct) return direct;

      const all = root.querySelectorAll("*");
      for (const el of all) {
        const sr = el.shadowRoot;
        if (sr && sr.mode === "open") {
          const found = search(sr);
          if (found) return found;
        }
      }
      return null;
    }

    return search(document);
  }

  const el = findByIdxDeep(params.idx);
  if (!el) {
    return {
      ok: false,
      error: `Element not found at index ${params.idx}. The page may have changed; try snapshotting again.`,
    };
  }

  if (params.op === "rect") {
    // Scroll element into view before reading geometry so CDP clicks land correctly.
    (el as unknown as { scrollIntoViewIfNeeded?: (a: unknown) => void }).scrollIntoViewIfNeeded?.({
      block: "center",
    });
    const r = (el as HTMLElement).getBoundingClientRect();
    return { ok: true, op: "rect", rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }

  if (params.op === "type") {
    // ── Ported verbatim from typeByIndex (src/lib/dom-actions/type.ts).
    // Changes: (a) uses already-resolved `el` instead of own querySelector;
    // (b) editor markers sourced from authoritative TYPE_EDITOR_MARKERS
    // (inlined verbatim for executeScript self-containment); (c) returns
    // wrapped in the ActResult shape; (d) getFieldName: label[for] lookup
    // now active (id is fallback).
    const { idx: index, text, clear } = params;

    // ── Inline sensitivity detection ──
    function isSensitive(el: Element): boolean {
      const inputEl = el as HTMLInputElement;

      if (inputEl.type === "password") return true;

      const autocomplete = inputEl.autocomplete || "";
      if (/cc-(number|cvc|exp|csc)/i.test(autocomplete)) return true;

      const sensitivePattern =
        /password|密码|cvv|cvc|otp|验证码|card.*number|card.*code/i;
      if (inputEl.name && sensitivePattern.test(inputEl.name)) return true;
      if (inputEl.id && sensitivePattern.test(inputEl.id)) return true;

      let label: HTMLLabelElement | null = null;
      if (inputEl.id) {
        label = document.querySelector<HTMLLabelElement>(
          `label[for="${inputEl.id}"]`,
        );
      }
      if (!label) {
        let node: Element | null = el.parentElement;
        while (node) {
          if (node.tagName?.toLowerCase() === "label") {
            label = node as HTMLLabelElement;
            break;
          }
          node = node.parentElement;
        }
      }
      if (label?.textContent && sensitivePattern.test(label.textContent)) {
        return true;
      }

      return false;
    }

    function getFieldName(el: Element): string {
      const inputEl = el as HTMLInputElement;
      if (inputEl.name) return inputEl.name;
      if (inputEl.id) {
        const label = document.querySelector<HTMLLabelElement>(
          `label[for="${inputEl.id}"]`,
        );
        if (label?.textContent?.trim()) {
          return label.textContent.trim().slice(0, 60);
        }
        return inputEl.id;
      }
      if (el.getAttribute("aria-label")) {
        return el.getAttribute("aria-label")!.trim().slice(0, 60);
      }
      if (inputEl.placeholder) {
        return inputEl.placeholder.trim().slice(0, 60);
      }
      return "field";
    }

    // ── Editor fingerprint for diagnostic ──
    // Markers are a verbatim copy of TYPE_EDITOR_MARKERS
    // (src/lib/dom-actions/_shared/interactive.ts), inlined for
    // executeScript self-containment.
    function detectEditor(el: Element): string | null {
      const markers: Array<[string, string]> = [
        ['[data-slate-editor="true"]', "Slate"],
        [".ProseMirror", "ProseMirror"],
        [".ql-editor", "Quill"],
        ['[data-lexical-editor="true"]', "Lexical"],
        [".monaco-editor", "Monaco"],
        [".cm-editor, .CodeMirror", "CodeMirror"],
        [
          '.suite-editor-container, .docx-root, [class*="lark-"], [class*="docx-"]',
          "Feishu Docs",
        ],
        [".notion-page-content", "Notion"],
        [".kix-documentview-content", "Google Docs"],
      ];
      for (const [selector, name] of markers) {
        try {
          if (el.closest(selector)) return name;
        } catch {
          // skip invalid selector
        }
      }
      return null;
    }

    // ── Native value setter (React-compatible) ──
    function setNativeValue(
      element: HTMLInputElement | HTMLTextAreaElement,
      value: string,
    ): void {
      const proto =
        element.tagName.toLowerCase() === "textarea"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        // Fallback to direct assignment (may not fire React's onChange)
        element.value = value;
      }
    }

    // ── Target is already resolved by findByIdxDeep (the not-found case is
    // handled before the op branches). ──

    const tag = el.tagName.toLowerCase();
    const isContentEditable =
      (el as HTMLElement).contentEditable === "true" ||
      el.getAttribute("contenteditable") === "true";
    const isInputOrTextarea = tag === "input" || tag === "textarea";

    if (!isInputOrTextarea && !isContentEditable) {
      if (tag === "canvas") {
        return {
          ok: false,
          error: `Element [${index}] is a <canvas> — canvas surfaces have no DOM text, so 'type' can't work. Read it via screenshot + vision, and write via dispatch_keyboard_input after clicking to focus.`,
        };
      }
      const surfaceEditor = detectEditor(el);
      if (surfaceEditor) {
        return {
          ok: false,
          error: `Element [${index}] is a <${tag}> inside a ${surfaceEditor} editor surface, which is not directly typeable. For code editors (Monaco / CodeMirror) use read_editor / set_editor_value; otherwise use dispatch_keyboard_input — do not use 'type' here.`,
        };
      }
      return {
        ok: false,
        error: `Element [${index}] is a <${tag}> which is not typeable (expected input, textarea, or contenteditable).`,
      };
    }

    const inputEl = el as HTMLInputElement;

    if (inputEl.disabled) {
      return {
        ok: false,
        error: `Element [${index}] is disabled.`,
      };
    }

    const sensitive = isSensitive(el);
    const editorType = detectEditor(el);
    const strategies: string[] = [];

    console.log("[Pie agent] type start:", {
      index,
      tag,
      isInputOrTextarea,
      isContentEditable,
      editor: editorType,
      textLength: text.length,
      clear,
      sensitive,
    });

    // ── Focus the element (editors often gate on focus) ──
    try {
      (el as HTMLElement).focus();
    } catch (e) {
      console.warn("[Pie agent] focus threw:", e);
    }

    // ── Execute typing strategy ──
    if (isInputOrTextarea) {
      strategies.push("native-value-setter");
      const newValue = (clear ? "" : inputEl.value || "") + text;
      setNativeValue(
        inputEl as HTMLInputElement | HTMLTextAreaElement,
        newValue,
      );
      inputEl.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: text,
          bubbles: true,
        }),
      );
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // contenteditable — setup selection first
      const selection = window.getSelection();

      if (clear) {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          selection?.removeAllRanges();
          selection?.addRange(range);
          strategies.push("execCommand-delete");
          document.execCommand("delete", false);
        } catch (e) {
          console.warn("[Pie agent] clear via execCommand failed:", e);
        }
      } else {
        // Move caret to end so insertions append
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        } catch (e) {
          console.warn("[Pie agent] collapse caret failed:", e);
        }
      }

      // Strategy 1: execCommand('insertText') — best for most rich editors
      let inserted = false;
      try {
        strategies.push("execCommand-insertText");
        inserted = document.execCommand("insertText", false, text);
        console.log(
          "[Pie agent] execCommand insertText returned:",
          inserted,
        );
      } catch (e) {
        console.warn("[Pie agent] execCommand insertText threw:", e);
      }

      // Strategy 2: InputEvent + textContent fallback
      if (!inserted) {
        strategies.push("beforeinput-event");
        try {
          const beforeEvent = new InputEvent("beforeinput", {
            inputType: "insertText",
            data: text,
            bubbles: true,
            cancelable: true,
          });
          const defaultAllowed = el.dispatchEvent(beforeEvent);
          console.log(
            "[Pie agent] beforeinput defaultAllowed:",
            defaultAllowed,
          );

          if (defaultAllowed) {
            // Editor didn't preventDefault — we need to do the insertion ourselves
            strategies.push("textContent-fallback");
            if (clear) (el as HTMLElement).textContent = "";
            (el as HTMLElement).textContent =
              ((el as HTMLElement).textContent || "") + text;
          }

          el.dispatchEvent(
            new InputEvent("input", {
              inputType: "insertText",
              data: text,
              bubbles: true,
            }),
          );
        } catch (e) {
          console.warn("[Pie agent] InputEvent strategy threw:", e);
        }
      }
    }

    // ── Async post-check: let the editor reconcile, then verify ──
    await new Promise((resolve) => setTimeout(resolve, 80));

    const actualValue = isInputOrTextarea
      ? inputEl.value || ""
      : (el as HTMLElement).innerText ||
        (el as HTMLElement).textContent ||
        "";
    const retained = actualValue.includes(text);

    // IME-buffer heuristic: rich-text editors like Feishu Docs, Google Docs use
    // hidden <textarea>/<input> elements as keyboard capture buffers. We can
    // successfully write to their `.value` (so `retained` is true), but the
    // editor never consumes them into the visible document. Signal: element is
    // inside a detected editor AND has trivially small bounding box or low opacity.
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    // An <input>/<textarea> nested inside a detected rich/code/canvas editor is
    // that editor's input / IME buffer, NOT its content surface. Writing to its
    // `.value` makes `retained` true, but the editor reconciles its own model and
    // the text never reliably lands — Monaco's `.inputarea` is the canonical case,
    // and it is full-size + opaque so the old size<24 || opacity<0.2 heuristic
    // missed it (type then falsely reported success). Treat ANY input/textarea
    // inside a detected editor as the buffer and hand off to the CDP keyboard
    // tools, which send real key events the editor actually consumes.
    const looksLikeIMEBuffer = isInputOrTextarea && editorType !== null;

    const diagnostic = {
      editor: editorType,
      strategies,
      expected: text.slice(0, 60) + (text.length > 60 ? "..." : ""),
      actualSample:
        actualValue.slice(0, 120) + (actualValue.length > 120 ? "..." : ""),
      retained,
      looksLikeIMEBuffer,
      elementSize: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      opacity: style.opacity,
    };
    console.log("[Pie agent] type post-check:", diagnostic);

    if (looksLikeIMEBuffer) {
      return {
        ok: false,
        error: `Element [${index}] is the input / IME buffer of ${editorType} (size: ${diagnostic.elementSize}, opacity: ${diagnostic.opacity}), not its content surface. Writing reached the buffer's value but ${editorType} won't render it — this editor only consumes real keyboard events, so 'type' can't work here. Switch to dispatch_keyboard_input to enter text (it sends isTrusted CDP key events). To REPLACE existing content first, press_key(key:"A", modifiers:["mod"]) to select-all, then dispatch_keyboard_input with the new text. Do not fail the task — these keyboard tools are the supported path for this editor.`,
      };
    }

    if (!retained) {
      const editorHint = editorType ? ` (editor: ${editorType})` : "";
      // type (DOM injection) lost the text. For known editors this almost always
      // means the editor only accepts real keyboard events — route to the CDP
      // keyboard tools rather than giving up (see Keyboard Simulation guidance).
      const recoveryHint = editorType
        ? ` ${editorType} only consumes real keyboard events — switch to dispatch_keyboard_input to type (to replace existing content, press_key(key:"A", modifiers:["mod"]) to select-all first, then dispatch_keyboard_input).`
        : " If this is a rich-text or code editor, try dispatch_keyboard_input (sends real CDP key events) instead of type.";
      return {
        ok: false,
        error: `Typed into element [${index}] but the text was not retained${editorHint}. Strategies tried: ${strategies.join(", ")}.${recoveryHint}`,
      };
    }

    if (sensitive) {
      return {
        ok: true,
        op: "type",
        observation: `Typed into ${getFieldName(el)} (value redacted)`,
      };
    }

    const editorSuffix = editorType ? ` (${editorType})` : "";
    return {
      ok: true,
      op: "type",
      observation: `Typed "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" into element [${index}]${editorSuffix}`,
    };
  }

  if (params.op === "select") {
    // ── Ported verbatim from selectByIndex (src/lib/dom-actions/select.ts).
    // Changes: uses already-resolved `el` instead of own querySelector;
    // returns wrapped in the ActResult shape.
    const { idx: index, value } = params;

    if (el.tagName.toLowerCase() !== "select") {
      return {
        ok: false,
        error: `Element [${index}] is a <${el.tagName.toLowerCase()}>, not a <select>.`,
      };
    }

    const selectEl = el as HTMLSelectElement;

    const optionExists = Array.from(selectEl.options).some(
      (opt) => opt.value === value,
    );

    if (!optionExists) {
      const availableValues = Array.from(selectEl.options)
        .map((o) => `"${o.value}"`)
        .join(", ");
      return {
        ok: false,
        error: `Option value "${value}" not found in select [${index}]. Available values: ${availableValues}`,
      };
    }

    selectEl.value = value;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));

    const selectedOption = Array.from(selectEl.options).find(
      (opt) => opt.value === value,
    );
    const label = selectedOption?.text?.trim() || value;

    return {
      ok: true,
      op: "select",
      observation: `Selected option "${label}" (value="${value}") in element [${index}]`,
    };
  }

  if (params.op === "focusClick") {
    // ── Ported verbatim from focusClickByIndex (src/lib/agent/tools/keyboard.ts).
    // Changes: uses already-resolved `el` instead of own querySelector;
    // returns wrapped in the ActResult shape.
    (el as HTMLElement).click();
    return {
      ok: true,
      op: "focusClick",
      observation: `Focus-clicked element [${params.idx}]`,
    };
  }

  if (params.op === "click") {
    // Synthetic in-frame click — used for subframe elements where real CDP
    // mouse input is unavailable. Full pointer/mouse sequence approximates a
    // user click for standard handlers; isTrusted stays false by nature of
    // synthetic events.
    if ((el as HTMLInputElement).disabled) {
      return {
        ok: false,
        error: `Element [${params.idx}] is disabled; clicking it has no effect.`,
      };
    }
    (el as unknown as { scrollIntoViewIfNeeded?: (a: unknown) => void }).scrollIntoViewIfNeeded?.({
      block: "center",
    });
    const r = (el as HTMLElement).getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      button: 0,
    };
    // happy-dom / older runtimes may lack PointerEvent — MouseEvent carries
    // the same type string and listeners on "pointer*" still fire.
    const PointerCtor: typeof MouseEvent =
      typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
    el.dispatchEvent(new PointerCtor("pointerover", init));
    el.dispatchEvent(new MouseEvent("mouseover", init));
    el.dispatchEvent(new PointerCtor("pointerdown", init));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    (el as HTMLElement).focus?.();
    el.dispatchEvent(new PointerCtor("pointerup", init));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    (el as HTMLElement).click();
    const canvasNote =
      el.tagName === "CANVAS"
        ? ` (Note: this is a <canvas> — its content isn't standard DOM; if nothing happened, read it via screenshot + vision and interact via the keyboard tools.)`
        : "";
    return { ok: true, op: "click", observation: `Clicked element [${params.idx}]${canvasNote}` };
  }

  // Unreachable: all five ActParams ops are handled above. `satisfies never`
  // makes a future unhandled op a compile error (exhaustiveness guard).
  params satisfies never;
  return { ok: false, error: "unknown op" };
}
