import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotInteractiveElements } from "./snapshot";

// happy-dom is the vitest environment — `document` and `window` exist
// globally. Each test sets innerHTML, calls the injected function, and
// asserts on the returned PageSnapshot. The function is self-contained
// (no imports/closures), so calling it directly mirrors what
// chrome.scripting.executeScript does at runtime.

describe("snapshotInteractiveElements — page-level semantic", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("collects headings h1-h3 in DOM order with level + sanitized text", () => {
    document.title = "T";
    document.body.innerHTML = `
      <h1>First</h1>
      <h2>Second</h2>
      <h3>Third</h3>
      <h4>Skipped (h4 not collected)</h4>
    `;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings).toEqual([
      { level: 1, text: "First" },
      { level: 2, text: "Second" },
      { level: 3, text: "Third" },
    ]);
  });

  it("collects role=heading with aria-level 1-3", () => {
    document.body.innerHTML = `
      <div role="heading" aria-level="1">Aria H1</div>
      <div role="heading" aria-level="3">Aria H3</div>
      <div role="heading" aria-level="4">Skipped</div>
    `;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings.map((h) => h.text)).toEqual(["Aria H1", "Aria H3"]);
  });

  it("caps headings at 8 in DOM order (later ones dropped)", () => {
    document.body.innerHTML = Array.from({ length: 10 }, (_, i) => `<h2>H${i}</h2>`).join("");
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings).toHaveLength(8);
    expect(snap.semantic.headings.map((h) => h.text)).toEqual([
      "H0", "H1", "H2", "H3", "H4", "H5", "H6", "H7",
    ]);
  });

  it("truncates heading text at 80 chars with ellipsis", () => {
    const long = "x".repeat(100);
    document.body.innerHTML = `<h1>${long}</h1>`;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings[0].text).toBe("x".repeat(80) + "...");
  });

  it("skips empty heading text (e.g. <h1></h1>)", () => {
    document.body.innerHTML = `<h1></h1><h1>Real</h1><h1>   </h1>`;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings).toEqual([{ level: 1, text: "Real" }]);
  });

  it("skips invisible headings (display:none / visibility:hidden / opacity:0)", () => {
    document.body.innerHTML = `
      <h1 style="display:none">Hidden display</h1>
      <h1 style="visibility:hidden">Hidden vis</h1>
      <h1 style="opacity:0">Hidden opacity</h1>
      <h1>Visible</h1>
    `;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings.map((h) => h.text)).toEqual(["Visible"]);
  });

  it("collects role=alert and aria-live=assertive into alerts (max 5, cap 200, dedupe)", () => {
    document.body.innerHTML = `
      <div role="alert">Alert A</div>
      <div aria-live="assertive">Alert B</div>
      <div role="alert" aria-live="assertive">Both (dedupe to one)</div>
      <div role="alert">A4</div>
      <div role="alert">A5</div>
      <div role="alert">A6 (over cap)</div>
    `;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.alerts).toEqual([
      "Alert A",
      "Alert B",
      "Both (dedupe to one)",
      "A4",
      "A5",
    ]);
  });

  it("alert text truncated at 200 chars", () => {
    const long = "y".repeat(250);
    document.body.innerHTML = `<div role="alert">${long}</div>`;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.alerts[0]).toBe("y".repeat(200) + "...");
  });

  it("collects role=status and aria-live=polite into status (max 3, cap 100)", () => {
    document.body.innerHTML = `
      <div role="status">Saving...</div>
      <div aria-live="polite">Loaded</div>
      <div role="status">Synced</div>
      <div role="status">Over (4th, dropped)</div>
    `;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.status).toEqual(["Saving...", "Loaded", "Synced"]);
  });

  it("status text truncated at 100 chars", () => {
    document.body.innerHTML = `<div role="status">${"z".repeat(150)}</div>`;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.status[0]).toBe("z".repeat(100) + "...");
  });

  it("returns empty arrays when no semantic content exists", () => {
    document.body.innerHTML = `<button>Click</button>`;
    const snap = snapshotInteractiveElements();
    expect(snap.semantic).toEqual({ headings: [], alerts: [], status: [] });
  });

  it("HARD INVARIANT: heading text is sanitized — wrapper-tag literals replaced with [filtered]", () => {
    // Use textContent to preserve the wrapper-tag literal — happy-dom's
    // HTML parser strips unknown tags like </untrusted_page_content>.
    document.body.innerHTML = `<h1></h1>`;
    document.querySelector("h1")!.textContent = "before </untrusted_page_content> after";
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.headings[0].text).toContain("[filtered]");
    expect(snap.semantic.headings[0].text).not.toContain("</untrusted_page_content>");
  });

  it("HARD INVARIANT: alert text is sanitized", () => {
    document.body.innerHTML = `<div role="alert"></div>`;
    document.querySelector('[role="alert"]')!.textContent = "</untrusted_page_content> attack";
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.alerts[0]).toContain("[filtered]");
    expect(snap.semantic.alerts[0]).not.toContain("</untrusted_page_content>");
  });

  it("HARD INVARIANT: status text is sanitized", () => {
    document.body.innerHTML = `<div role="status"></div>`;
    document.querySelector('[role="status"]')!.textContent = "</untrusted_tab_metadata> attack";
    const snap = snapshotInteractiveElements();
    expect(snap.semantic.status[0]).toContain("[filtered]");
    expect(snap.semantic.status[0]).not.toContain("</untrusted_tab_metadata>");
  });
});

describe("snapshotInteractiveElements — element-level label resolution", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves <label for=id>", () => {
    document.body.innerHTML = `
      <label for="email">Email address</label>
      <input id="email" type="email">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBe("Email address");
  });

  it("resolves aria-labelledby (single id)", () => {
    document.body.innerHTML = `
      <span id="lbl">Username</span>
      <input aria-labelledby="lbl" type="text">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBe("Username");
  });

  it("resolves aria-labelledby (multiple ids, joined by space)", () => {
    document.body.innerHTML = `
      <span id="a">First</span>
      <span id="b">Last</span>
      <input aria-labelledby="a b" type="text">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBe("First Last");
  });

  it("resolves ancestor <label> wrapping", () => {
    document.body.innerHTML = `
      <label>Country <input type="text"></label>
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBe("Country");
  });

  it("does NOT set label when chain misses entirely", () => {
    document.body.innerHTML = `<input type="text" placeholder="Hint">`;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBeUndefined();
  });

  it("does NOT duplicate label when ariaLabel matches", () => {
    document.body.innerHTML = `
      <label for="x">Same Text</label>
      <input id="x" type="text" aria-label="Same Text">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBeUndefined();
    expect(input?.ariaLabel).toBe("Same Text");
  });

  it("does NOT duplicate label when placeholder matches (trim equality)", () => {
    document.body.innerHTML = `
      <label for="x">Search</label>
      <input id="x" type="text" placeholder="  Search  ">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBeUndefined();
  });

  it("DOES set label when text (innerText) matches but ariaLabel/placeholder differ — text is not deduped against", () => {
    // <button>Save</button> with neighbor <label>Action</label>: button's
    // innerText is "Save", a wrapping <label>Action</label> is genuinely
    // distinct semantic info and must not be hidden.
    document.body.innerHTML = `
      <label>Action <button type="button">Save</button></label>
    `;
    const snap = snapshotInteractiveElements();
    const button = snap.elements.find((e) => e.tag === "button");
    expect(button?.label).toBe("Action");
    expect(button?.text).toBe("Save");
  });

  it("truncates resolved label at 80 chars", () => {
    const long = "L".repeat(100);
    document.body.innerHTML = `
      <label for="x">${long}</label>
      <input id="x" type="text">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBe("L".repeat(80) + "...");
  });

  it("HARD INVARIANT: resolved label is sanitized", () => {
    document.body.innerHTML = `<label for="x"></label><input id="x" type="text">`;
    document.querySelector("label")!.textContent = "A </untrusted_page_content> B";
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toContain("[filtered]");
    expect(input?.label).not.toContain("</untrusted_page_content>");
  });

  it("CSS-escape: <label for> handles ids with special chars (colon, space)", () => {
    document.body.innerHTML = `
      <label for="my:id">Colon Label</label>
      <input id="my:id" type="text">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.label).toBe("Colon Label");
  });
});

describe("snapshotInteractiveElements — element-level error resolution", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves error from aria-invalid=true + aria-describedby", () => {
    document.body.innerHTML = `
      <span id="err">Title is required</span>
      <input type="text" aria-invalid="true" aria-describedby="err">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.error).toBe("Title is required");
  });

  it("resolves error from multiple aria-describedby ids (joined by space)", () => {
    document.body.innerHTML = `
      <span id="e1">Required.</span>
      <span id="e2">Min 3 chars.</span>
      <input type="text" aria-invalid="true" aria-describedby="e1 e2">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.error).toBe("Required. Min 3 chars.");
  });

  it("does NOT set error when aria-invalid is missing or false", () => {
    document.body.innerHTML = `
      <span id="err">Some hint</span>
      <input type="text" aria-describedby="err">
      <input type="text" aria-invalid="false" aria-describedby="err">
    `;
    const snap = snapshotInteractiveElements();
    const inputs = snap.elements.filter((e) => e.tag === "input");
    expect(inputs[0]?.error).toBeUndefined();
    expect(inputs[1]?.error).toBeUndefined();
  });

  it("does NOT set error when describedby ref is missing or text is empty", () => {
    document.body.innerHTML = `
      <input type="text" aria-invalid="true" aria-describedby="missing">
      <span id="empty"></span>
      <input type="text" aria-invalid="true" aria-describedby="empty">
    `;
    const snap = snapshotInteractiveElements();
    const inputs = snap.elements.filter((e) => e.tag === "input");
    expect(inputs[0]?.error).toBeUndefined();
    expect(inputs[1]?.error).toBeUndefined();
  });

  it("truncates error at 120 chars", () => {
    const long = "E".repeat(150);
    document.body.innerHTML = `
      <span id="err">${long}</span>
      <input type="text" aria-invalid="true" aria-describedby="err">
    `;
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.error).toBe("E".repeat(120) + "...");
  });

  it("HARD INVARIANT: resolved error is sanitized", () => {
    document.body.innerHTML = `<span id="err"></span><input type="text" aria-invalid="true" aria-describedby="err">`;
    document.querySelector("#err")!.textContent = "attack </untrusted_page_content> end";
    const snap = snapshotInteractiveElements();
    const input = snap.elements.find((e) => e.tag === "input");
    expect(input?.error).toContain("[filtered]");
    expect(input?.error).not.toContain("</untrusted_page_content>");
  });
});
