// Editor tools — read_editor / set_editor_value. CDP Runtime.evaluate in the
// top frame's MAIN context drives Monaco / CodeMirror model APIs (getValue /
// setValue) so the agent can read off-screen virtualized lines and write large
// content in one shot.
//
// v1 scope: TOP-FRAME editors only. Same-origin iframe editors are DETECTED
// (detection-only subframe walk) but degrade with "in_subframe" — a precise
// error guiding the user to keyboard/vision. Cross-origin OOPIFs throw on
// .document and are silently skipped (also degrade).
//
// Security: CDP runs in the page's own JS context (page can hook getValue), so
// returned text is UNTRUSTED — wrapped in <untrusted_editor_content> and never
// placed in the system role.
//
// Spec: docs/specs/2026-06-05-canvas-editor-cdp-support.md

import type { CdpSession } from "../../../background/cdp-session";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";
import { requireCdpInput } from "./mouse";
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";

export interface EditorToolDeps {
  acquireSession: (tabId: number) => Promise<CdpSession>;
  requestConsent: (sessionId: string) => Promise<boolean>;
  sessionId: string;
}

interface BridgeResult {
  ok: boolean;
  engine?: string;
  value?: string;
  verified?: boolean;
  reason?: string;
}

const MAX_SET_TEXT_LENGTH = 500_000;

// Top-frame locator fragment. Queries ONLY the top document.
// If the element is not found in the top frame, runs a DETECTION-ONLY
// recursive same-origin walk to check whether the idx exists in a subframe
// (so we can return "in_subframe" instead of "not_found"). Cross-origin
// OOPIFs throw on .document and are silently skipped.
// Returns: { el, win } if found in top frame; or the string reason
// "in_subframe" / "not_found" as a sentinel (checked by callers before use).
function locatorFragment(idx: number): string {
  return `
    const SEL = '[data-pie-idx="${idx}"]';
    const el = document.querySelector(SEL);
    const win = window;
    // Detection-only subframe walk — MUST NOT act on the element, only test existence.
    function inSubframe(w) {
      const fs = w.frames;
      for (let i = 0; i < fs.length; i++) {
        try {
          if (fs[i].document.querySelector(SEL)) return true;
          if (inSubframe(fs[i])) return true;
        } catch (e) { /* cross-origin OOPIF — skip */ }
      }
      return false;
    }
    const _locatorReason = el ? null : (inSubframe(window) ? "in_subframe" : "not_found");
  `;
}

// Engine-resolution fragment: given `el` and `win` (already resolved by the
// locator — only called when el is non-null), sets `ed` to a small
// adapter { engine, get(), set(text) } or leaves it null.
function adapterFragment(): string {
  return `
    let ed = null;
    if (el) {
      try {
        if (win.monaco && win.monaco.editor && win.monaco.editor.getEditors) {
          const m = win.monaco.editor.getEditors().find(function (e) {
            const c = e.getContainerDomNode && e.getContainerDomNode();
            return c && (el.contains(c) || c.contains(el));
          });
          if (m) ed = { engine: "monaco", get: function () { return m.getValue(); }, set: function (t) { m.setValue(t); } };
        }
      } catch (e) {}
      if (!ed) try {
        const h5 = el.closest(".CodeMirror");
        if (h5 && h5.CodeMirror) ed = { engine: "cm5", get: function () { return h5.CodeMirror.getValue(); }, set: function (t) { h5.CodeMirror.setValue(t); } };
      } catch (e) {}
      if (!ed) try {
        const h6 = el.closest(".cm-editor");
        if (h6) {
          // CM6 has no global registry. The EditorView is reachable via an
          // expando CM6 attaches to a managed host node — but the property
          // name is version-dependent (cmView / cmTile / ...). Instead of
          // hardcoding it, duck-type: scan own-props of the few candidate
          // host nodes for anything that IS an EditorView (.state.doc) or
          // wraps one (.view / .rootView.view). Falls back to the global
          // EditorView.findFromDOM if the page happens to expose the class.
          const isView = function (o) {
            return o && typeof o === "object" && o.state && o.state.doc &&
              typeof o.state.doc.toString === "function";
          };
          let view = null;
          const cands = [h6.querySelector(".cm-content"), h6.querySelector(".cm-scroller"), h6];
          for (let ci = 0; ci < cands.length && !view; ci++) {
            const n = cands[ci];
            if (!n) continue;
            const keys = Object.getOwnPropertyNames(n);
            for (let ki = 0; ki < keys.length; ki++) {
              let v;
              try { v = n[keys[ki]]; } catch (e) { continue; }
              if (isView(v)) { view = v; break; }
              if (v && typeof v === "object") {
                if (isView(v.view)) { view = v.view; break; }
                if (v.rootView && isView(v.rootView.view)) { view = v.rootView.view; break; }
              }
            }
          }
          if (!view) {
            const EV = win.EditorView || (win.CM && win.CM.EditorView);
            if (EV && EV.findFromDOM) view = EV.findFromDOM(h6);
          }
          if (view) ed = {
            engine: "cm6",
            get: function () { return view.state.doc.toString(); },
            set: function (t) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }); },
          };
          else ed = { engine: "cm6", get: null, set: null }; // host found, view unreachable
        }
      } catch (e) {}
    }
  `;
}

export function buildReadEditorExpression(idx: number): string {
  return `(function () {
    ${locatorFragment(idx)}
    if (_locatorReason) return { ok: false, reason: _locatorReason };
    ${adapterFragment()}
    if (!ed) return { ok: false, reason: "no_engine" };
    if (!ed.get) return { ok: false, reason: "cm6_no_view" };
    return { ok: true, engine: ed.engine, value: String(ed.get()) };
  })()`;
}

export function buildSetEditorExpression(idx: number, text: string): string {
  return `(function () {
    const TEXT = ${JSON.stringify(text)};
    ${locatorFragment(idx)}
    if (_locatorReason) return { ok: false, reason: _locatorReason };
    ${adapterFragment()}
    if (!ed) return { ok: false, reason: "no_engine" };
    if (!ed.set) return { ok: false, reason: "cm6_no_view" };
    ed.set(TEXT);
    const after = String(ed.get());
    return { ok: true, engine: ed.engine, verified: after === TEXT };
  })()`;
}

function reasonToError(reason: string | undefined): string {
  switch (reason) {
    case "not_found":
      return "Editor element not found — the page may have changed. Call read_page again for fresh indices.";
    case "in_subframe":
      return "Editor is inside an iframe — iframe editors aren't supported yet. Click the editor to focus, then use dispatch_keyboard_input (write) or screenshot + vision (read).";
    case "no_engine":
      return "No supported editor (Monaco/CodeMirror) at this index. If it's a canvas editor (e.g. Google Docs), read via screenshot + vision, or write via dispatch_keyboard_input after clicking to focus.";
    case "cm6_no_view":
      return "CodeMirror 6 instance not reachable (no exposed EditorView). Read via screenshot + vision, or write via dispatch_keyboard_input after clicking to focus.";
    default:
      return `Editor operation failed (${reason ?? "unknown"}).`;
  }
}

async function evaluate(session: CdpSession, expression: string): Promise<BridgeResult | { evalError: string }> {
  const res = (await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { result?: { value?: BridgeResult }; exceptionDetails?: { text?: string } };
  if (res.exceptionDetails) {
    return { evalError: res.exceptionDetails.text ?? "evaluation error" };
  }
  return res.result?.value ?? { ok: false, reason: "no_engine" };
}

async function acquire(
  deps: EditorToolDeps,
  ctx: ToolHandlerContext,
): Promise<{ session: CdpSession } | { error: string }> {
  const gate = await requireCdpInput({ sessionId: deps.sessionId, requestConsent: deps.requestConsent });
  if (!gate.ok) return { error: gate.error };
  try {
    return { session: await deps.acquireSession(ctx.tabId) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Another debugger|conflict/i.test(msg)) {
      return { error: "CDP attach failed: another debugger is attached to this tab (DevTools or another agent task). Close it and retry." };
    }
    return { error: `CDP attach failed: ${msg}` };
  }
}

export function buildEditorTools(deps: EditorToolDeps): Tool[] {
  return [
    {
      name: "read_editor",
      description:
        "Read the FULL content of a code editor (Monaco / CodeMirror) by its data-pie-idx from read_page's <interactive_index> (role=\"editor\"). Returns the entire document via the editor's model API — including lines scrolled off-screen that read_page cannot see. Use this instead of read_page when you need the complete editor text. For canvas editors (e.g. Google Docs) it returns an error; read those via screenshot + vision.",
      parameters: {
        type: "object",
        properties: {
          elementIndex: {
            type: "number",
            description: "data-pie-idx of the editor host (role=\"editor\") from the latest read_page.",
          },
        },
        required: ["elementIndex"],
        additionalProperties: false,
      },
      handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
        const a = args as { elementIndex: number };
        const acq = await acquire(deps, ctx);
        if ("error" in acq) return { success: false, error: acq.error };
        const out = await evaluate(acq.session, buildReadEditorExpression(a.elementIndex));
        if ("evalError" in out) return { success: false, error: `read_editor failed: ${out.evalError}` };
        if (!out.ok) return { success: false, error: reasonToError(out.reason) };
        const wrapped =
          `<untrusted_editor_content engine="${out.engine}" idx="${a.elementIndex}">\n` +
          `${escapeUntrustedWrappers(String(out.value ?? ""))}\n` +
          `</untrusted_editor_content>`;
        return { success: true, observation: wrapped };
      },
    },
    {
      name: "set_editor_value",
      description:
        "Replace the ENTIRE content of a code editor (Monaco / CodeMirror) by its data-pie-idx from read_page (role=\"editor\"). Writes via the editor's model API in one shot — no per-character typing, no IME issues, no length truncation. Use this to fill editors with large code/SQL. Reads back to verify. For canvas editors (e.g. Google Docs) it errors; write those via dispatch_keyboard_input after clicking to focus.",
      parameters: {
        type: "object",
        properties: {
          elementIndex: {
            type: "number",
            description: "data-pie-idx of the editor host (role=\"editor\") from the latest read_page.",
          },
          text: {
            type: "string",
            description: `Full replacement content. Max ${MAX_SET_TEXT_LENGTH} characters.`,
          },
        },
        required: ["elementIndex", "text"],
        additionalProperties: false,
      },
      handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
        const a = args as { elementIndex: number; text: string };
        if (a.text.length > MAX_SET_TEXT_LENGTH) {
          return { success: false, error: `text length ${a.text.length} exceeds ${MAX_SET_TEXT_LENGTH} character cap` };
        }
        const acq = await acquire(deps, ctx);
        if ("error" in acq) return { success: false, error: acq.error };
        const out = await evaluate(acq.session, buildSetEditorExpression(a.elementIndex, a.text));
        if ("evalError" in out) return { success: false, error: `set_editor_value failed: ${out.evalError}` };
        if (!out.ok) return { success: false, error: reasonToError(out.reason) };
        if (!out.verified) {
          return { success: false, error: "set_editor_value wrote but read-back did not match — the page may intercept input or use a controlled component that rolled back. Try dispatch_keyboard_input after clicking to focus." };
        }
        return { success: true, observation: `Set ${a.text.length} chars into ${out.engine} editor [${a.elementIndex}] (verified).` };
      },
    },
  ];
}

export { MAX_SET_TEXT_LENGTH };
