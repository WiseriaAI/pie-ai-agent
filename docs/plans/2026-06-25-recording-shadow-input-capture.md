# Recording: shadow-DOM input/textarea capture via composed `input` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record `<input>`/`<textarea>` edits through the composed `input` event (which crosses shadow boundaries) instead of the non-composed `change` event, so shadow-DOM-encapsulated form inputs are captured.

**Architecture:** `capture.ts` currently records input/textarea values from the blur-time `change` event (`onChange`, non-composed → never crosses shadow). PR #218 added composed-`input` piercing but only for contenteditable. This change routes input/textarea through the same debounced `onInput`→`flushEdit` path (composed, shadow-piercing), and removes the input/textarea branch from `onChange` to avoid double-recording. `flushEdit` reads `.value` for form controls and `innerText` for contenteditable.

**Tech Stack:** TypeScript, self-contained injected function (no imports), vitest + happy-dom.

## Global Constraints

- `capture.ts` is a **self-contained injected function** — no outer imports, no closures over module scope. All helpers stay inline.
- Existing parity invariants unchanged: `buildLabelFor` wording must still match `selector.describeElement` (PARITY tests), and `WRAPPER_TAGS_LIST` / `EDITOR_SELECTOR` literals stay verbatim.
- Gates before PR: `pnpm test`, `pnpm typecheck`, `pnpm build` all green.

---

### Task 1: Route input/textarea through composed `onInput`, drop `onChange` input branch

**Files:**
- Modify: `src/lib/recording/capture.ts` (`onInput` ~L493-505, `flushEdit` ~L473-492, `onChange` ~L407-420, header/inline comments)
- Test: `src/lib/recording/capture.integration.test.ts`

**Interfaces:**
- Consumes: existing inline helpers `realTargetOf(e)`, `closestInPath(e, el, sel)`, `detectSensitiveInline(host)`, `sanitizeText(s, max)`, `buildLabelFor(host)`, `getRegion(host)`.
- Produces: no new exports. Behavior change: `type` actions for input/textarea now emitted from the debounced input path (flushed by the 500ms timer or the existing capture-phase `blur` listener).

- [ ] **Step 1: Update existing input/textarea tests to drive the new `input`+`blur` path (RED for regression surface)**

In `capture.integration.test.ts`, the three tests that dispatch only `change` on an input must dispatch `input` then `blur` (blur flushes synchronously via the existing `blur`→`flushEdit` listener). Replace:

`redacts password input value` body (the dispatch lines):
```ts
    input.value = "supersecret";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
```

`captures non-redacted text input value as literal`:
```ts
    input.value = "user@example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
```

`debounces consecutive input events on same element to single change-style emission` — replace the trailing `change` with `input`+`blur`:
```ts
    input.value = "h";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "he";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
```

PARITY test (`PARITY: capture.ts inline label matches selector.describeElement`) — `emailInput` and `pwd` dispatch `change`; change to `input`+`blur`. The two inputs must be flushed independently (blur after each) so order is preserved:
```ts
    const emailInput = document.querySelector("input[name='email']") as HTMLInputElement;
    emailInput.value = "u@x.com";
    emailInput.dispatchEvent(new Event("input", { bubbles: true }));
    emailInput.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    const pwd = document.querySelector("input[type='password']") as HTMLInputElement;
    pwd.value = "secret";
    pwd.dispatchEvent(new Event("input", { bubbles: true }));
    pwd.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
```

- [ ] **Step 2: Add new tests for shadow-DOM input/textarea + double-record guard (RED for the feature)**

Append inside the top-level `describe`:
```ts
  it("captures a shadow-DOM <input> via composed input event", () => {
    document.body.innerHTML = `<main><div id="hostwrap"></div></main>`;
    const wrap = document.getElementById("hostwrap")!;
    const sr = wrap.attachShadow({ mode: "open" });
    sr.innerHTML = `<input type="text" name="city" placeholder="City" />`;
    uninstall = installCaptureListener();
    const input = sr.querySelector("input") as HTMLInputElement;
    input.value = "Berlin";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));

    const types = captured.filter((c) => c.payload.type === "type");
    expect(types).toHaveLength(1);
    expect(types[0]!.payload.value).toBe("Berlin");
    expect(types[0]!.payload.label).toMatch(/City|city/);
    uninstall();
  });

  it("captures a shadow-DOM <textarea> via composed input event", () => {
    document.body.innerHTML = `<main><div id="taw"></div></main>`;
    const wrap = document.getElementById("taw")!;
    const sr = wrap.attachShadow({ mode: "open" });
    sr.innerHTML = `<textarea name="note"></textarea>`;
    uninstall = installCaptureListener();
    const ta = sr.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "hello world";
    ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    ta.dispatchEvent(new FocusEvent("blur", { bubbles: false }));

    const types = captured.filter((c) => c.payload.type === "type");
    expect(types).toHaveLength(1);
    expect(types[0]!.payload.value).toBe("hello world");
    uninstall();
  });

  it("light-DOM input via input+blur emits exactly one type (no double-record)", () => {
    document.body.innerHTML = `<main><input type="text" name="q" /></main>`;
    uninstall = installCaptureListener();
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    // a real browser also fires change after blur — must NOT add a second type
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const types = captured.filter((c) => c.payload.type === "type");
    expect(types).toHaveLength(1);
    expect(types[0]!.payload.value).toBe("abc");
    uninstall();
  });

  it("native checkbox input event does not emit a type action", () => {
    document.body.innerHTML = `<main><input type="checkbox" name="agree" /></main>`;
    uninstall = installCaptureListener();
    const cb = document.querySelector("input") as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event("input", { bubbles: true }));
    cb.dispatchEvent(new Event("change", { bubbles: true }));

    expect(captured.some((c) => c.payload.type === "type")).toBe(false);
    const clicks = captured.filter((c) => c.payload.type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload.checked).toBe(true);
    uninstall();
  });
```

- [ ] **Step 3: Run tests to verify the new/updated ones FAIL**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: the four new tests fail (shadow input → 0 type actions; checkbox → maybe extra type) and the updated change→input tests fail (0 captures, because `onChange` still owns input/textarea but no `change` is dispatched). This proves the tests exercise the new path.

- [ ] **Step 4: Implement — make `onInput` handle input/textarea, split `flushEdit` value source, drop `onChange` input branch**

In `capture.ts`, replace the `flushEdit` value read. Change:
```ts
    const sens = detectSensitiveInline(host);
    const raw = host.innerText ?? host.textContent ?? "";
    const value = sens.redacted ? sens.placeholderName! : sanitizeText(raw, 200);
```
to:
```ts
    const sens = detectSensitiveInline(host);
    const tag = host.tagName;
    const raw =
      tag === "INPUT" || tag === "TEXTAREA"
        ? (host as HTMLInputElement).value
        : host.innerText ?? host.textContent ?? "";
    const value = sens.redacted ? sens.placeholderName! : sanitizeText(raw, 200);
```

Replace the `onInput` body. Change:
```ts
  const onInput = (e: Event) => {
    const t = realTargetOf(e);
    const host = t ? closestInPath(e, t, '[contenteditable="true"]') : null;
    if (!host) return; // 非 contenteditable（如 input/textarea）忽略，交给 onChange
    editTarget = host;
    if (editTimer !== null) clearTimeout(editTimer);
    editTimer = setTimeout(flushEdit, 500);
  };
```
to:
```ts
  const onInput = (e: Event) => {
    // input IS composed (crosses shadow boundaries) — resolve the real target via
    // composedPath. Two value-bearing hosts ride this debounced path: form controls
    // (<input>/<textarea>, value read from .value) and contenteditable (innerText).
    // change/submit are non-composed and never reach a document listener from inside
    // a shadow root, so input is the only path that captures shadow-encapsulated edits.
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
```

Remove the input/textarea branch from `onChange` (the `if (tag === "input" || tag === "textarea") { ... }` block, ~L407-420) entirely, and update the stale `onChange` top comment about input/textarea being out of scope to note they now ride `onInput`.

- [ ] **Step 5: Update stale comments**

Update the file header "已知限制" bullet ("不监听 'input' 事件") and the `flushEdit`/`onInput` preamble comment (~L469-470: "input/textarea 的 input 事件不在此处理…仍由 onChange") to reflect that input/textarea now ride the debounced composed-input path; contenteditable + form controls share `flushEdit`.

- [ ] **Step 6: Run the capture test file to verify GREEN**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: PASS (all updated + new tests). In particular contenteditable tests (`coalesces contenteditable typing`, both PARITY-contenteditable) still pass — `flushEdit`'s non-INPUT/TEXTAREA branch is unchanged for them.

- [ ] **Step 7: Full gates**

Run: `pnpm test` then `pnpm typecheck` then `pnpm build`
Expected: all green (build-time invariants in `tool-names.ts`/`tools.ts` unaffected — no tool changes).

- [ ] **Step 8: Commit**

```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.integration.test.ts docs/plans/2026-06-25-recording-shadow-input-capture.md
git commit -m "fix(recording): capture shadow-DOM input/textarea via composed input event (#223)"
```
