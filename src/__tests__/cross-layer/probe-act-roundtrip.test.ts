/**
 * probe-act-roundtrip.test.ts — cross-layer behavioral parity tests.
 *
 * Part B: Every pieIdx stamped by probePageInjected (snapshot) is locatable by
 *   actByIdxInjected(op:"rect") — including shadow-DOM elements and editor hosts.
 *
 * Part B (editor parity): Each editor host appears as exactly ONE role="editor"
 *   in the snapshot, and search(searchBy:"role", queries:["editor"]) returns the
 *   same pieIdx set.
 *
 * Part C: For each shadow-internal stamped element, both actByIdxInjected and
 *   LOCATE_BY_IDX_FRAGMENT (via new Function) resolve to the same element.
 *
 * Part D: in_subframe sentinel behavioral test — LOCATE_BY_IDX_FRAGMENT reports
 *   _locatorReason === "in_subframe" when the element lives in a faked subframe
 *   document rather than the top-level document.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { probePageInjected } from "../../lib/dom-actions/probe-core";
import { actByIdxInjected } from "../../lib/dom-actions/act-core";
import { LOCATE_BY_IDX_FRAGMENT } from "../../lib/dom-actions/_shared/locate";

// Helper: mock getBoundingClientRect to return a real-sized rect so isVisible
// returns true in happy-dom (which defaults all rects to 0×0).
function makeVisible(el: HTMLElement, w = 400, h = 200): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h }),
    configurable: true,
  });
}

// Helper: evaluate a LOCATE_BY_IDX_FRAGMENT substituted for a given idx.
// Returns { found: boolean; reason: string | null; tagName?: string; className?: string }
function evalLocateFragment(idx: number): {
  found: boolean;
  reason: string | null;
  tagName?: string;
  className?: string;
} {
  const fragment = LOCATE_BY_IDX_FRAGMENT.replace(/\$\{idx\}/g, String(idx));
  const fn = new Function(`
    ${fragment}
    return {
      found: !!el,
      reason: _locatorReason,
      tagName: el ? el.tagName.toLowerCase() : undefined,
      className: el ? el.className : undefined,
    };
  `);
  return fn() as ReturnType<typeof evalLocateFragment>;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.querySelectorAll("[data-pie-idx]").forEach((el) => el.removeAttribute("data-pie-idx"));
  // Clean up any lingering window.tinymce / window.monaco fakes from editor tests.
  delete (window as unknown as Record<string, unknown>).tinymce;
  delete (window as unknown as Record<string, unknown>).monaco;
});

// ── Part B: round-trip — every stamped idx is locatable ───────────────────────

describe("Part B: probe→act round-trip (all stamped idxs are locatable by actByIdxInjected)", () => {
  it("plain button + shadow button + editor hosts: every pieIdx resolves via op:rect", async () => {
    // Plain button
    const plainBtn = document.createElement("button");
    plainBtn.textContent = "Plain button";
    document.body.appendChild(plainBtn);

    // Button inside an open shadow root
    const shadowHost = document.createElement("div");
    document.body.appendChild(shadowHost);
    const sr = shadowHost.attachShadow({ mode: "open" });
    const shadowBtn = document.createElement("button");
    shadowBtn.textContent = "Shadow button";
    sr.appendChild(shadowBtn);

    // Monaco editor host
    const monacoHost = document.createElement("div");
    monacoHost.className = "monaco-editor";
    document.body.appendChild(monacoHost);
    makeVisible(monacoHost);

    // CodeMirror 6 editor host
    const cmHost = document.createElement("div");
    cmHost.className = "cm-editor";
    document.body.appendChild(cmHost);
    makeVisible(cmHost);

    // TinyMCE editor host
    const tinyHost = document.createElement("div");
    tinyHost.className = "tox-tinymce";
    document.body.appendChild(tinyHost);
    makeVisible(tinyHost);

    const snap = probePageInjected({ op: "snapshot" });
    if (snap.op !== "snapshot") throw new Error("Expected snapshot");

    expect(snap.interactiveElements.length).toBeGreaterThanOrEqual(4);

    // Every stamped idx must be locatable via actByIdxInjected op:rect
    for (const e of snap.interactiveElements) {
      const result = await actByIdxInjected({ op: "rect", idx: e.pieIdx });
      expect(result.ok, `idx ${e.pieIdx} (tag=${e.tag}, role=${e.role}) must be locatable`).toBe(true);
    }
  });

  it("shadow-internal button is stamped and locatable", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.textContent = "in-shadow";
    sr.appendChild(btn);

    const snap = probePageInjected({ op: "snapshot" });
    if (snap.op !== "snapshot") throw new Error("Expected snapshot");

    const shadowEntry = snap.interactiveElements.find((e) => e.tag === "button");
    expect(shadowEntry).toBeDefined();

    const res = await actByIdxInjected({ op: "rect", idx: shadowEntry!.pieIdx });
    expect(res.ok).toBe(true);
  });
});

// ── Part B (editor parity): each editor host → exactly one role=editor entry ──

describe("Part B: editor host parity (snapshot ↔ search idx agreement)", () => {
  it("each editor type appears as exactly one role=editor in snapshot, matching searchBy:role", () => {
    // Set up one of each editor type
    const editorClasses = [
      { cls: "monaco-editor", label: "Monaco" },
      { cls: "cm-editor", label: "CM6" },
      { cls: "tox-tinymce", label: "TinyMCE" },
    ];

    const hosts: HTMLElement[] = [];
    for (const { cls } of editorClasses) {
      const el = document.createElement("div");
      el.className = cls;
      document.body.appendChild(el);
      makeVisible(el);
      hosts.push(el);
    }

    const snap = probePageInjected({ op: "snapshot" });
    if (snap.op !== "snapshot") throw new Error("Expected snapshot");

    const snapshotEditors = snap.interactiveElements.filter((e) => e.role === "editor");
    // Exactly one entry per unique host (Monaco + CM6 + TinyMCE = 3)
    expect(snapshotEditors).toHaveLength(3);

    // Search for role=editor — should return the same pieIdx set
    const searchResult = probePageInjected({
      op: "search",
      queries: ["editor"],
      regex: false,
      mode: "all",
      maxResults: 20,
      searchBy: "role",
    });
    if (searchResult.op !== "search") throw new Error("Expected search");

    const searchEditorIdxs = new Set(searchResult.matches.map((m) => m.pieIdx));
    const snapEditorIdxs = new Set(snapshotEditors.map((e) => e.pieIdx));

    // snapshot pieIdx set must equal search pieIdx set
    expect(searchEditorIdxs).toEqual(snapEditorIdxs);
  });

  it("editor host's internal interactive elements (e.g. textarea) are NOT stamped separately", () => {
    // Monaco nests a .inputarea <textarea> — that must NOT appear as a separate entry
    const monacoHost = document.createElement("div");
    monacoHost.className = "monaco-editor";
    const innerTextarea = document.createElement("textarea");
    innerTextarea.className = "inputarea";
    monacoHost.appendChild(innerTextarea);
    document.body.appendChild(monacoHost);
    makeVisible(monacoHost);

    const snap = probePageInjected({ op: "snapshot" });
    if (snap.op !== "snapshot") throw new Error("Expected snapshot");

    // Should be exactly 1 editor entry — the host
    const editorEntries = snap.interactiveElements.filter((e) => e.role === "editor");
    expect(editorEntries).toHaveLength(1);

    // The textarea inside should NOT have its own entry
    const textareaEntries = snap.interactiveElements.filter((e) => e.tag === "textarea");
    expect(textareaEntries).toHaveLength(0);
  });
});

// ── Part C: locate.ts ↔ findByIdxDeep behavioral parity ─────────────────────

describe("Part C: LOCATE_BY_IDX_FRAGMENT ↔ findByIdxDeep (actByIdxInjected) shadow parity", () => {
  it("shadow-internal stamped element: both actByIdxInjected(op:rect) and LOCATE_BY_IDX_FRAGMENT resolve to the same element", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const targetBtn = document.createElement("button");
    targetBtn.className = "target-shadow-btn";
    targetBtn.textContent = "shadow target";
    sr.appendChild(targetBtn);

    // Also add a plain button so idx 0 is taken and shadow button gets a distinct idx
    const plainBtn = document.createElement("button");
    plainBtn.textContent = "plain";
    document.body.prepend(plainBtn);

    const snap = probePageInjected({ op: "snapshot" });
    if (snap.op !== "snapshot") throw new Error("Expected snapshot");

    // Find the shadow button entry
    const shadowEntry = snap.interactiveElements.find(
      (e) => e.tag === "button" && e.name === "shadow target",
    );
    expect(shadowEntry).toBeDefined();
    const idx = shadowEntry!.pieIdx;

    // (a) actByIdxInjected — locates via findByIdxDeep → ok:true
    const actResult = await actByIdxInjected({ op: "rect", idx });
    expect(actResult.ok).toBe(true);

    // (b) LOCATE_BY_IDX_FRAGMENT via new Function — same element
    const fragResult = evalLocateFragment(idx);
    expect(fragResult.found).toBe(true);
    expect(fragResult.reason).toBeNull();
    // Both should resolve to the same tagName/class
    expect(fragResult.tagName).toBe("button");
    expect(fragResult.className).toContain("target-shadow-btn");
  });

  it("top-level element: both paths resolve; neither reports in_subframe", async () => {
    const btn = document.createElement("button");
    btn.id = "toplevel-btn";
    btn.textContent = "top";
    document.body.appendChild(btn);

    const snap = probePageInjected({ op: "snapshot" });
    if (snap.op !== "snapshot") throw new Error("Expected snapshot");

    const entry = snap.interactiveElements.find((e) => e.tag === "button");
    expect(entry).toBeDefined();
    const idx = entry!.pieIdx;

    const actResult = await actByIdxInjected({ op: "rect", idx });
    expect(actResult.ok).toBe(true);

    const fragResult = evalLocateFragment(idx);
    expect(fragResult.found).toBe(true);
    expect(fragResult.reason).toBeNull();
    expect(fragResult.tagName).toBe("button");
  });

  it("missing idx: LOCATE_BY_IDX_FRAGMENT reports not_found; actByIdxInjected returns ok:false", async () => {
    document.body.innerHTML = `<p>nothing interactive</p>`;

    const actResult = await actByIdxInjected({ op: "rect", idx: 99 });
    expect(actResult.ok).toBe(false);

    const fragResult = evalLocateFragment(99);
    expect(fragResult.found).toBe(false);
    expect(fragResult.reason).toBe("not_found");
  });
});

// ── Part D: in_subframe sentinel behavioral test ──────────────────────────────

describe("Part D: LOCATE_BY_IDX_FRAGMENT in_subframe sentinel", () => {
  it.skip(
    // 真机回归 — happy-dom does not support window.frames iteration or cross-frame
    // document access (fs[i].document throws or returns empty). The in_subframe
    // branch requires a real browser environment where window.frames[i].document
    // is accessible from the top frame for same-origin iframes. Verified by
    // manual inspection that the branch is correct in locate.ts code path.
    // To test in a real browser: stamp a [data-pie-idx] inside a same-origin
    // <iframe>, remove it from the top-level document, run LOCATE_BY_IDX_FRAGMENT
    // via CDP Runtime.evaluate, and assert _locatorReason === "in_subframe".
    "LOCATE_BY_IDX_FRAGMENT reports in_subframe when element lives only in a subframe",
    () => {
      // Would fake window.frames with a mock frame whose document contains
      // `[data-pie-idx="X"]`, while the top document does not. Then assert
      // _locatorReason === "in_subframe". Infeasible in happy-dom because
      // window.frames is read-only and fs[i].document throws cross-origin-style
      // errors in the jsdom/happy-dom security model.
    },
  );

  // Partial behavioral coverage: we CAN verify the fragment returns "not_found"
  // (not "in_subframe") when frames is empty and element is absent from top doc.
  it("LOCATE_BY_IDX_FRAGMENT returns not_found (not in_subframe) when frames is empty and element absent", () => {
    document.body.innerHTML = `<p>no interactive</p>`;
    const fragResult = evalLocateFragment(42);
    expect(fragResult.found).toBe(false);
    // In happy-dom, window.frames.length === 0, so inSubframe() returns false → "not_found"
    expect(fragResult.reason).toBe("not_found");
  });
});
