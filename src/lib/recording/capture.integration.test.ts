/**
 * Capture integration test — runs in happy-dom (vite.config.ts test.environment).
 * 验证注入函数在真实 DOM 树上能正确捕获 click / input / submit 事件并构造
 * CapturedActionPayload。
 *
 * 注：注入函数是 self-contained 的（无外部 import / 无闭包），但在测试里我们直接
 * 调用它（不走 chrome.scripting.executeScript），mock 掉 chrome.runtime.sendMessage。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installCaptureListener } from "./capture";
import { detectSensitive } from "./redact";
import type { CapturedActionPayload } from "./types";

describe("capture.installCaptureListener", () => {
  let captured: Array<{ type: string; payload: CapturedActionPayload }>;
  let uninstall: () => void;

  beforeEach(() => {
    document.body.innerHTML = "";
    captured = [];
    // Reset idempotent install flag so each test starts clean.
    (window as Window & { __pieRecordingInstalled?: boolean }).__pieRecordingInstalled = false;
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn((msg: unknown) => {
          captured.push(msg as { type: string; payload: CapturedActionPayload });
        }),
      },
    };
  });

  it("captures button click with aria-label as label", () => {
    document.body.innerHTML = `<main><button aria-label="Submit form">Submit</button></main>`;
    uninstall = installCaptureListener();
    const btn = document.querySelector("button")!;
    btn.click();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe("recording-action");
    expect(captured[0]!.payload.type).toBe("click");
    expect(captured[0]!.payload.label).toContain("Submit form");
    expect(captured[0]!.payload.region).toBe("main");
    uninstall();
  });

  it("redacts password input value", () => {
    document.body.innerHTML = `<main><input type="password" name="pwd" /></main>`;
    uninstall = installCaptureListener();
    const input = document.querySelector("input")!;
    input.value = "supersecret";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.type).toBe("type");
    expect(captured[0]!.payload.redacted).toBe(true);
    expect(captured[0]!.payload.placeholderName).toBe("password");
    expect(captured[0]!.payload.value).not.toContain("supersecret");
    uninstall();
  });

  it("captures non-redacted text input value as literal", () => {
    document.body.innerHTML = `<main><input type="text" name="email" /></main>`;
    uninstall = installCaptureListener();
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "user@example.com";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.value).toBe("user@example.com");
    expect(captured[0]!.payload.redacted).toBeFalsy();
    uninstall();
  });

  it("captures select change", () => {
    document.body.innerHTML = `<main><select name="country"><option value="cn">China</option><option value="us">US</option></select></main>`;
    uninstall = installCaptureListener();
    const sel = document.querySelector("select") as HTMLSelectElement;
    sel.value = "us";
    sel.dispatchEvent(new Event("change", { bubbles: true }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.type).toBe("select");
    expect(captured[0]!.payload.value).toBe("us");
    uninstall();
  });

  it("captures form submit as submit action", () => {
    document.body.innerHTML = `<main><form><button type="submit">Go</button></form></main>`;
    uninstall = installCaptureListener();
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(captured.find((c) => c.payload.type === "submit")).toBeDefined();
    uninstall();
  });

  it("debounces consecutive input events on same element to single change-style emission", () => {
    document.body.innerHTML = `<main><input type="text" name="search" /></main>`;
    uninstall = installCaptureListener();
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "h";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "he";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "hello";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const typeActions = captured.filter((c) => c.payload.type === "type");
    expect(typeActions).toHaveLength(1);
    expect(typeActions[0]!.payload.value).toBe("hello");
    uninstall();
  });

  it("uninstall removes listeners (no further events captured)", () => {
    document.body.innerHTML = `<main><button>X</button></main>`;
    uninstall = installCaptureListener();
    uninstall();
    document.querySelector("button")!.click();
    expect(captured).toHaveLength(0);
  });

  it("PARITY: capture.ts inline label matches selector.describeElement on same element", async () => {
    const { describeElement } = await import("./selector");

    document.body.innerHTML = `
      <main>
        <button aria-label="Submit form" data-testid="submit-btn">Submit</button>
        <input type="email" name="email" placeholder="you@example.com" />
        <input type="password" id="pwd" />
      </main>
    `;
    uninstall = installCaptureListener();

    const btn = document.querySelector("button") as HTMLButtonElement;
    btn.click();
    const emailInput = document.querySelector("input[name='email']") as HTMLInputElement;
    emailInput.value = "u@x.com";
    emailInput.dispatchEvent(new Event("change", { bubbles: true }));
    const pwd = document.querySelector("input[type='password']") as HTMLInputElement;
    pwd.value = "secret";
    pwd.dispatchEvent(new Event("change", { bubbles: true }));

    expect(captured.length).toBeGreaterThanOrEqual(3);
    const elements = [btn, emailInput, pwd];
    elements.forEach((el, idx) => {
      const captureLabel = captured[idx]!.payload.label;
      const captureHint = captured[idx]!.payload.selectorHint;
      const captureUnstable = captured[idx]!.payload.unstable;
      const region: string = el.closest("main") ? "main" : "other";
      // Mirror capture.ts's getRegion + querySelectorAll logic for nth fallback.
      const regionRoot =
        region === "main" ? document.querySelector("main") :
        region === "nav" ? document.querySelector("nav") :
        region === "header" ? document.querySelector("header") :
        region === "footer" ? document.querySelector("footer") :
        region === "aside" ? document.querySelector("aside") :
        document.body;
      const sibs = Array.from(regionRoot?.querySelectorAll(el.tagName.toLowerCase()) ?? []);
      const regionSiblingIndex = sibs.indexOf(el);
      const regionSiblingCount = sibs.length;
      const ref = describeElement({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? undefined,
        ariaLabel: el.getAttribute("aria-label") ?? undefined,
        text: (el as HTMLElement).innerText ?? "",
        placeholder: (el as HTMLInputElement).placeholder || undefined,
        name: (el as HTMLInputElement).name || undefined,
        id: el.id || undefined,
        dataTestId: el.getAttribute("data-testid") ?? undefined,
        autocomplete: (el as HTMLInputElement).autocomplete || undefined,
        region,
        regionSiblingIndex,
        regionSiblingCount,
        isSensitive: (el as HTMLInputElement).type === "password",
      });
      expect(captureLabel).toBe(ref.label);
      expect(captureHint).toBe(ref.selectorHint);
      expect(Boolean(captureUnstable)).toBe(ref.unstable);

      // I1: assert redact parity vs Unit 1's canonical detectSensitive.
      // capture.ts duplicates the redact logic for self-containment; without
      // this, a future widening of redact.ts could drift unnoticed.
      const inputEl = el as HTMLInputElement;
      // Resolve associated <label for=id> text the same way capture.ts does.
      let labelText = "";
      if (inputEl.id) {
        const lbl = document.querySelector<HTMLLabelElement>(`label[for="${inputEl.id}"]`);
        if (lbl?.textContent) labelText = lbl.textContent;
      }
      const refRedact = detectSensitive({
        type: inputEl.type,
        autocomplete: inputEl.autocomplete,
        ariaLabel: el.getAttribute("aria-label") ?? undefined,
        name: inputEl.name || undefined,
        placeholder: inputEl.placeholder || undefined,
        labelText: labelText || undefined,
      });
      expect(Boolean(captured[idx]!.payload.redacted)).toBe(refRedact.redacted);
      expect(captured[idx]!.payload.placeholderName).toBe(refRedact.placeholderName);
    });
    uninstall();
  });

  it("idempotent install: a second installCaptureListener() does not double-attach listeners", () => {
    document.body.innerHTML = `<main><button>X</button></main>`;
    const uninstall1 = installCaptureListener();
    const uninstall2 = installCaptureListener(); // second install
    document.querySelector("button")!.click();
    expect(captured).toHaveLength(1); // would be 2 if double-attached
    uninstall2(); // no-op uninstall returned by second call
    document.querySelector("button")!.click();
    expect(captured).toHaveLength(2); // still receiving (first install still alive)
    uninstall1(); // tears down for real
    document.querySelector("button")!.click();
    expect(captured).toHaveLength(2); // no further capture
  });
});
