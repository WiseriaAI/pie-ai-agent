import { describe, expect, it, beforeEach } from "vitest";
import { pageSnapshotInjected } from "./page-snapshot";

// happy-dom 不算布局，isVisible 依赖 getBoundingClientRect — 给编辑器宿主打可见尺寸。
function makeVisible(el: HTMLElement) {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ width: 600, height: 300, top: 0, left: 0, right: 600, bottom: 300 }),
    configurable: true,
  });
}

describe("read_page editor detection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.querySelectorAll("[data-pie-idx]").forEach((el) => el.removeAttribute("data-pie-idx"));
  });

  it("registers a Monaco host as a role=editor interactive element with engine+usage name", () => {
    document.body.innerHTML = `
      <div class="monaco-editor">
        <textarea class="inputarea"></textarea>
        <div class="view-lines"><div class="view-line">SELECT 1</div></div>
      </div>`;
    const host = document.querySelector(".monaco-editor") as HTMLElement;
    makeVisible(host);

    const snap = pageSnapshotInjected();
    const editor = snap.interactiveElements.find((el) => el.role === "editor");

    expect(editor).toBeDefined();
    expect(editor!.name).toContain("Monaco");
    expect(editor!.name).toContain("read_editor");
    expect(editor!.name).toContain("idx");
    expect(host.getAttribute("data-pie-idx")).toBe(String(editor!.pieIdx));
  });

  it("suppresses interactive descendants inside the editor host (no inputarea idx)", () => {
    document.body.innerHTML = `
      <div class="monaco-editor"><textarea class="inputarea"></textarea></div>`;
    const host = document.querySelector(".monaco-editor") as HTMLElement;
    const inner = document.querySelector(".inputarea") as HTMLElement;
    makeVisible(host);
    makeVisible(inner);

    const snap = pageSnapshotInjected();
    expect(snap.interactiveElements.filter((e) => e.role === "editor")).toHaveLength(1);
    expect(inner.hasAttribute("data-pie-idx")).toBe(false);
  });

  it("labels CodeMirror 6 (.cm-editor) and 5 (.CodeMirror) hosts", () => {
    document.body.innerHTML = `
      <div class="cm-editor"><div class="cm-content"></div></div>
      <div class="CodeMirror"><div class="CodeMirror-lines"></div></div>`;
    const cm6 = document.querySelector(".cm-editor") as HTMLElement;
    const cm5 = document.querySelector(".CodeMirror") as HTMLElement;
    makeVisible(cm6);
    makeVisible(cm5);

    const snap = pageSnapshotInjected();
    const names = snap.interactiveElements.filter((e) => e.role === "editor").map((e) => e.name);
    expect(names.some((n) => n.includes("CodeMirror"))).toBe(true);
    expect(names.filter((n) => n.includes("CodeMirror"))).toHaveLength(2);
  });

  it("registers a TinyMCE v5/6 host (.tox-tinymce) as a role=editor element", () => {
    document.body.innerHTML = `
      <div class="tox tox-tinymce">
        <div class="tox-editor-container">
          <button class="tox-tbtn">Bold</button>
          <iframe class="tox-edit-area__iframe"></iframe>
        </div>
      </div>`;
    const host = document.querySelector(".tox-tinymce") as HTMLElement;
    makeVisible(host);

    const snap = pageSnapshotInjected();
    const editor = snap.interactiveElements.find((el) => el.role === "editor");

    expect(editor).toBeDefined();
    expect(editor!.name).toContain("TinyMCE");
    expect(editor!.name).toContain("read_editor");
    expect(editor!.name).toContain("set_editor_value");
    expect(host.getAttribute("data-pie-idx")).toBe(String(editor!.pieIdx));
  });

  it("suppresses the toolbar button inside the TinyMCE host (single handle)", () => {
    document.body.innerHTML = `
      <div class="tox tox-tinymce">
        <button class="tox-tbtn">Bold</button>
      </div>`;
    const host = document.querySelector(".tox-tinymce") as HTMLElement;
    const btn = document.querySelector(".tox-tbtn") as HTMLElement;
    makeVisible(host);
    makeVisible(btn);

    const snap = pageSnapshotInjected();
    expect(snap.interactiveElements.filter((e) => e.role === "editor")).toHaveLength(1);
    expect(btn.hasAttribute("data-pie-idx")).toBe(false);
  });

  it("registers a TinyMCE v4 host (.mce-tinymce) as a role=editor element", () => {
    document.body.innerHTML = `<div class="mce-tinymce mce-container"></div>`;
    const host = document.querySelector(".mce-tinymce") as HTMLElement;
    makeVisible(host);

    const snap = pageSnapshotInjected();
    const editor = snap.interactiveElements.find((el) => el.role === "editor");
    expect(editor).toBeDefined();
    expect(editor!.name).toContain("TinyMCE");
    expect(editor!.name).toContain("read_editor");
    expect(editor!.name).toContain("set_editor_value");
  });
});
