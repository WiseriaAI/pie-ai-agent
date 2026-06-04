import type { ActionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Types text into an input, textarea, or contenteditable element.
 *
 * Multi-strategy approach:
 *  - input/textarea: uses React-compatible native value setter so controlled
 *    components actually update their state
 *  - contenteditable: tries document.execCommand('insertText') first (most
 *    compatible with rich-text editors like Slate/Quill/ProseMirror), then
 *    falls back to an InputEvent with inputType: "insertText"
 *
 * Async post-check (80ms) verifies the text was actually retained, catching
 * rich-text editors that accept the event but reconcile their internal model
 * back over our DOM write (canvas-based editors like new Feishu Docs / Google
 * Docs fall in this category and will correctly fail the check).
 *
 * All helper functions are nested for executeScript self-containment.
 * Diagnostic logs are emitted to the target page's console for debugging.
 *
 * @param index - The index stamped by read_page (pageSnapshotInjected)
 * @param text  - Text to type
 * @param clear - If true, clear existing content before typing
 */
export async function typeByIndex(
  index: number,
  text: string,
  clear: boolean,
): Promise<ActionResult> {
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
    if (inputEl.id) return inputEl.id;
    if (inputEl.id) {
      const label = document.querySelector<HTMLLabelElement>(
        `label[for="${inputEl.id}"]`,
      );
      if (label?.textContent?.trim()) {
        return label.textContent.trim().slice(0, 60);
      }
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

  // ── Locate target ──
  const el = document.querySelector(`[data-pie-idx="${index}"]`);
  if (!el) {
    return {
      success: false,
      error: `Element not found at index ${index}. The page may have changed; try snapshotting again.`,
    };
  }

  const tag = el.tagName.toLowerCase();
  const isContentEditable =
    (el as HTMLElement).contentEditable === "true" ||
    el.getAttribute("contenteditable") === "true";
  const isInputOrTextarea = tag === "input" || tag === "textarea";

  if (!isInputOrTextarea && !isContentEditable) {
    return {
      success: false,
      error: `Element [${index}] is a <${tag}> which is not typeable (expected input, textarea, or contenteditable).`,
    };
  }

  const inputEl = el as HTMLInputElement;

  if (inputEl.disabled) {
    return {
      success: false,
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
    setNativeValue(inputEl as HTMLInputElement | HTMLTextAreaElement, newValue);
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
      success: false,
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
      success: false,
      error: `Typed into element [${index}] but the text was not retained${editorHint}. Strategies tried: ${strategies.join(", ")}.${recoveryHint}`,
    };
  }

  if (sensitive) {
    return {
      success: true,
      observation: `Typed into ${getFieldName(el)} (value redacted)`,
    };
  }

  const editorSuffix = editorType ? ` (${editorType})` : "";
  return {
    success: true,
    observation: `Typed "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" into element [${index}]${editorSuffix}`,
  };
}
