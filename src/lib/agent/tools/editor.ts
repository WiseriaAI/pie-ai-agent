// Editor tools — read_editor / set_editor_value. CDP Runtime.evaluate in the
// top frame's MAIN context drives Monaco / CodeMirror model APIs (getValue /
// setValue) so the agent can read off-screen virtualized lines and write large
// content in one shot. A same-origin frame walk inside the expression reaches
// editors in same-origin iframes; cross-origin frames throw on .document and
// are skipped (OOPIF — degraded to keyboard/vision).
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
  pinnedOrigin: string;
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

// Shared same-origin element locator (string fragment injected into both
// expressions). Returns { el, win } for the matched element or null.
function locatorFragment(idx: number): string {
  return `
    const SEL = '[data-pie-idx="${idx}"]';
    // Walk same-origin frames recursively. Cross-origin OOPIFs throw on .document
    // and are skipped. Top-level walk starts at window.frames.
    function findHit(doc, frames, win) {
      const el = doc.querySelector(SEL);
      if (el) return { el: el, win: win };
      for (let i = 0; i < frames.length; i++) {
        try {
          const hit = findHit(frames[i].document, frames[i].frames, frames[i]);
          if (hit) return hit;
        } catch (e) { /* cross-origin OOPIF — skip */ }
      }
      return null;
    }
    const hit = findHit(document, window.frames, window);
  `;
}

// Engine-resolution fragment: given `hit` ({el, win}) sets `ed` to a small
// adapter { engine, get(), set(text) } or leaves it null.
function adapterFragment(): string {
  return `
    let ed = null;
    if (hit) {
      const el = hit.el, win = hit.win;
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
          const EV = win.EditorView || (win.CM && win.CM.EditorView);
          const view = EV && EV.findFromDOM ? EV.findFromDOM(h6) : null;
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
    if (!hit) return { ok: false, reason: "not_found" };
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
    if (!hit) return { ok: false, reason: "not_found" };
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
    // set_editor_value added in Task 5
  ];
}

// MAX_SET_TEXT_LENGTH and buildSetEditorExpression are exported for Task 5
export { MAX_SET_TEXT_LENGTH };
