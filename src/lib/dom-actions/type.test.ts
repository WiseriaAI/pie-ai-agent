import { afterEach, describe, expect, it } from "vitest";

import { typeByIndex } from "./type";

// typeByIndex is the self-contained function injected into the page. These
// tests exercise it directly against a happy-dom DOM.

function mountMonacoTextarea(): HTMLTextAreaElement {
  document.body.innerHTML = `
    <div class="monaco-editor">
      <div class="overflow-guard">
        <textarea class="inputarea" data-pie-idx="8"></textarea>
      </div>
    </div>`;
  const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
  // Monaco's .inputarea is full-size and opaque — it slips past any
  // size<24 / opacity<0.2 heuristic. Force a non-trivial box so the test
  // reproduces the real Monaco geometry rather than happy-dom's 0×0 default.
  ta.getBoundingClientRect = () =>
    ({ width: 300, height: 120, top: 0, left: 0, right: 300, bottom: 120, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return ta;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("typeByIndex — editor input buffers route to CDP", () => {
  it("refuses a full-size Monaco textarea (input buffer) and points to dispatch_keyboard_input", async () => {
    mountMonacoTextarea();

    const result = await typeByIndex(8, 'console.log("HelloPie");', false);

    // Even though the textarea retains the value, type must NOT claim success:
    // Monaco's model doesn't consume a DOM write reliably.
    expect(result.success).toBe(false);
    expect(result.error).toContain("dispatch_keyboard_input");
    expect(result.error).toContain("Monaco");
  });

  it("still types into an ordinary textarea (no editor host)", async () => {
    document.body.innerHTML = `<textarea data-pie-idx="3"></textarea>`;
    const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.getBoundingClientRect = () =>
      ({ width: 300, height: 120, top: 0, left: 0, right: 300, bottom: 120, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const result = await typeByIndex(3, "hello world", false);

    expect(result.success).toBe(true);
    expect(ta.value).toBe("hello world");
  });
});
