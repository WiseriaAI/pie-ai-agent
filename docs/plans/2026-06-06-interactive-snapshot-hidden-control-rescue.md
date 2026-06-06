# Label-Rescue for Hidden Form Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a hidden form control (e.g. a 1×1 toggle checkbox) reachable by the agent by stamping a `pie_idx` on its visible associated `<label>`, with the snapshot entry enriched to read like the control itself.

**Architecture:** In `page-snapshot.ts` Step C, when a form control matches `INTERACTIVE_SELECTOR` but fails `isVisible`, stamp its visible associated label instead (the label has real geometry, so the CDP coordinate `click` can hit it; clicking the label drives the native label→input toggle + framework binding — verified on live Magento). `interactiveSummary` derives semantic fields from `label.control` so the agent sees a `checkbox` with its `checked` state. The same stamp logic is mirrored verbatim into `search-page.ts` per the interactive-parity invariant.

**Tech Stack:** TypeScript, injected DOM functions (self-contained, no closures over module scope), vitest + happy-dom.

**Spec:** `docs/specs/2026-06-06-interactive-snapshot-hidden-control-rescue.md` · **Issue:** [#141](https://github.com/WiseriaAI/pie-ai-agent/issues/141)

---

## Environment notes (verified, not assumptions)

- happy-dom returns a **default `getBoundingClientRect` of `{width:100, height:20}`** for every element. To simulate a hidden 1×1 input in a test, stub it: `Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }), configurable: true })`.
- happy-dom's `offsetParent` is `undefined` (not `null`), so `isVisible`'s `offsetParent === null` check does not fire in tests — elements are visible by default.
- happy-dom supports `HTMLInputElement.labels` (NodeList) and `HTMLLabelElement.control` natively — both used directly, no fallback needed.
- `pageSnapshotInjected()` returns `{ html, interactiveElements, scrollableHints }`. Tests assert on `result.html` (carries `data-pie-idx`) and `result.interactiveElements` (array of `InteractiveElementSummary`).
- `isVisible` is at `page-snapshot.ts:117`; the `<8px input` filter is L124-126; Step C stamp loop is L351-359; `interactiveSummary` is L242-262.

---

## File Structure

- **Modify** `src/lib/dom-actions/page-snapshot.ts`
  - Add two inline helpers (`isRescuableControl`, `visibleLabelFor`) inside `pageSnapshotInjected`.
  - Extend the Step C stamp loop (L351-359) with a rescue branch + a local `stamp(el)` helper.
  - Extend `interactiveSummary` (L242-262) to derive semantic fields from `label.control` for a rescued label.
- **Modify** `src/lib/dom-actions/search-page.ts`
  - Mirror the same rescue branch + helpers into its verbatim stamp copy (L131-141).
- **Test** `src/lib/dom-actions/page-snapshot.test.ts` — rescue stamping + summary enrichment + no-regression cases.
- **Test** `src/lib/dom-actions/search-page.test.ts` — search parity finds the rescued control.

No new files. No type changes (`InteractiveElementSummary` already has `role`/`type`/`checked`/`name`).

---

## Task 1: Rescue stamping in page-snapshot.ts

**Files:**
- Modify: `src/lib/dom-actions/page-snapshot.ts:351-359` (Step C stamp loop) + add helpers near `isVisible` (after L128)
- Test: `src/lib/dom-actions/page-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/dom-actions/page-snapshot.test.ts` inside the top-level `describe`:

```ts
describe("hidden form control label-rescue", () => {
  it("stamps the visible label, not the hidden 1×1 input", () => {
    document.body.innerHTML = `
      <div class="switch">
        <input type="checkbox" id="st" name="product[status]" checked>
        <label class="lbl" for="st">Toggle</label>
      </div>`;
    const cb = document.getElementById("st") as HTMLInputElement;
    // Simulate the 1×1 hidden real input (Magento toggle).
    Object.defineProperty(cb, "getBoundingClientRect", {
      value: () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }),
      configurable: true,
    });

    const result = pageSnapshotInjected();

    // The label is stamped; the hidden input is not.
    expect(result.html).toMatch(/<label class="lbl" for="st" data-pie-idx="0">/);
    expect(result.html).not.toMatch(/<input[^>]*name="product\[status\]"[^>]*data-pie-idx/);
  });

  it("does NOT rescue when the input itself is visible (no double handle)", () => {
    document.body.innerHTML = `
      <input type="checkbox" id="v" name="ok">
      <label for="v">Vis</label>`;
    const result = pageSnapshotInjected();
    // Visible input is stamped normally; label is NOT stamped.
    expect(result.html).toMatch(/<input type="checkbox" id="v" name="ok" data-pie-idx="0">/);
    expect(result.html).not.toMatch(/<label[^>]*data-pie-idx/);
  });

  it("does NOT rescue when the label is also hidden (genuinely unreachable)", () => {
    document.body.innerHTML = `
      <input type="checkbox" id="h" name="hh">
      <label class="hl" for="h">Hidden</label>`;
    const cb = document.getElementById("h") as HTMLInputElement;
    const lbl = document.querySelector("label.hl") as HTMLLabelElement;
    const tiny = { value: () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }), configurable: true };
    Object.defineProperty(cb, "getBoundingClientRect", tiny);
    Object.defineProperty(lbl, "getBoundingClientRect", { value: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }), configurable: true });
    const result = pageSnapshotInjected();
    expect(result.html).not.toMatch(/data-pie-idx/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/dom-actions/page-snapshot.test.ts -t "label-rescue"`
Expected: FAIL — first test fails because the label is NOT stamped (no `data-pie-idx` on `<label>`); the hidden input is correctly skipped already.

- [ ] **Step 3: Add the helpers**

In `src/lib/dom-actions/page-snapshot.ts`, immediately after the `isVisible` function (after L128, before `sanitizeText`), add:

```ts
  function isRescuableControl(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") return false;
    if (tag === "input" && (el as HTMLInputElement).type === "hidden") return false;
    return true;
  }

  // A form control filtered out by isVisible (e.g. a 1×1 framework toggle) is
  // still reachable if it has a VISIBLE associated <label>: clicking the label
  // drives the native label→control toggle plus any framework binding. Return
  // that label so Step C can stamp it as the control's proxy handle.
  function visibleLabelFor(el: Element): HTMLLabelElement | null {
    const labels = (el as HTMLInputElement).labels;
    if (!labels) return null;
    for (const l of Array.from(labels)) {
      if (isVisible(l)) return l;
    }
    return null;
  }
```

- [ ] **Step 4: Extend the Step C stamp loop**

Replace the stamp loop at `src/lib/dom-actions/page-snapshot.ts:351-359`:

```ts
  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      const idxStr = String(stampIdx++);
      el.setAttribute("data-pie-idx", idxStr);
      const cloneEl = liveToCloneMap.get(el);
      if (cloneEl) cloneEl.setAttribute("data-pie-idx", idxStr);
    }
  }
```

with:

```ts
  let stampIdx = 0;
  const stamp = (el: Element): void => {
    const idxStr = String(stampIdx++);
    el.setAttribute("data-pie-idx", idxStr);
    const cloneEl = liveToCloneMap.get(el);
    if (cloneEl) cloneEl.setAttribute("data-pie-idx", idxStr);
  };

  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      stamp(el);
    } else if (
      el.matches?.(INTERACTIVE_SELECTOR) &&
      isRescuableControl(el) &&
      !isVisible(el)
    ) {
      const label = visibleLabelFor(el);
      if (label && !label.hasAttribute("data-pie-idx")) {
        stamp(label);
      }
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -s test src/lib/dom-actions/page-snapshot.test.ts -t "label-rescue"`
Expected: PASS (all three cases).

- [ ] **Step 6: Run the full file to check no regression**

Run: `pnpm -s test src/lib/dom-actions/page-snapshot.test.ts`
Expected: PASS (existing cases unaffected — the rescue branch only fires for invisible rescuable controls).

- [ ] **Step 7: Commit**

```bash
git add src/lib/dom-actions/page-snapshot.ts src/lib/dom-actions/page-snapshot.test.ts
git commit -m "feat(snapshot): rescue hidden form controls via visible label (#141)"
```

---

## Task 2: Enrich the rescued label's summary from its control

**Files:**
- Modify: `src/lib/dom-actions/page-snapshot.ts:242-262` (`interactiveSummary`)
- Test: `src/lib/dom-actions/page-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `"hidden form control label-rescue"` describe block:

```ts
  it("the rescued entry reads as a checkbox with the control's state", () => {
    document.body.innerHTML = `
      <div class="switch">
        <input type="checkbox" id="st2" name="product[status]" checked>
        <label class="lbl" for="st2">Enable</label>
      </div>`;
    const cb = document.getElementById("st2") as HTMLInputElement;
    Object.defineProperty(cb, "getBoundingClientRect", {
      value: () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }),
      configurable: true,
    });

    const entry = pageSnapshotInjected().interactiveElements.find((e) => e.pieIdx === 0);

    expect(entry).toBeDefined();
    expect(entry!.role).toBe("checkbox");      // from the control, not the <label>
    expect(entry!.type).toBe("checkbox");
    expect(entry!.checked).toBe(true);          // reflects input.checked
    expect(entry!.name).toBe("product[status]"); // identifies the control
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/dom-actions/page-snapshot.test.ts -t "reads as a checkbox"`
Expected: FAIL — the stamped element is the `<label>`, so `role` is `""` and `type`/`checked`/`name` reflect the label, not the checkbox.

- [ ] **Step 3: Implement the enrichment**

Replace `interactiveSummary` at `src/lib/dom-actions/page-snapshot.ts:242-262`:

```ts
  function interactiveSummary(el: Element): InteractiveElementSummary {
    // A rescued <label> stands in for its hidden control: derive all semantic
    // fields from the control so the agent sees the checkbox/select it operates,
    // while pieIdx stays on the label (whose geometry the CDP click targets).
    const rescuedControl =
      el.tagName.toLowerCase() === "label"
        ? (el as HTMLLabelElement).control
        : null;
    const target = rescuedControl ?? el;
    const tag = target.tagName.toLowerCase();
    const input = target instanceof HTMLInputElement ? target : null;
    const option = target instanceof HTMLOptionElement ? target : null;
    const pieIdx = Number(el.getAttribute("data-pie-idx") ?? "-1");
    return {
      pieIdx,
      tag,
      role: inferredRole(target),
      name: accessibleName(target),
      text: directText(target),
      placeholder: normalizeSpace(target.getAttribute("placeholder") ?? ""),
      label: labelFor(target),
      section: nearestSection(target),
      type: input ? input.type.toLowerCase() : normalizeSpace(target.getAttribute("type") ?? ""),
      contenteditable: target.getAttribute("contenteditable") === "true",
      disabled: target.hasAttribute("disabled"),
      checked: input ? input.checked : target.hasAttribute("checked"),
      selected: option ? option.selected : target.hasAttribute("selected"),
    };
  }
```

Only change vs. current: compute `target` (control for a rescued label, else `el`), read all semantic fields off `target`, but keep `pieIdx` from `el`. Non-label elements are unaffected (`rescuedControl` is null → `target === el`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s test src/lib/dom-actions/page-snapshot.test.ts -t "reads as a checkbox"`
Expected: PASS.

- [ ] **Step 5: Run the full file**

Run: `pnpm -s test src/lib/dom-actions/page-snapshot.test.ts`
Expected: PASS (existing summary cases unaffected — non-label elements take the `target === el` path).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dom-actions/page-snapshot.ts src/lib/dom-actions/page-snapshot.test.ts
git commit -m "feat(snapshot): enrich rescued label entry from its control (#141)"
```

---

## Task 3: Mirror rescue into search-page.ts (parity)

**Files:**
- Modify: `src/lib/dom-actions/search-page.ts:116-141` (verbatim isVisible + stamp copy)
- Test: `src/lib/dom-actions/search-page.test.ts`

- [ ] **Step 1: Write the failing test**

`search-page.test.ts` already defines a `run(overrides: Partial<SearchPageParams>)` helper (top of file) that calls `searchPageInjected({ queries: [], regex: false, mode: "all", maxResults: 10, searchBy: "text", ...overrides })` and returns a `SearchPageResult` whose `.matches[i]` have `.pieIdx` / `.matched` / `.snippet` / `.tag`. Add:

```ts
describe("search finds label-rescued hidden controls", () => {
  it("returns the rescued label's pie_idx for a hidden toggle", () => {
    document.body.innerHTML = `
      <div class="switch">
        <input type="checkbox" id="st" name="product[status]" checked>
        <label class="lbl" for="st">Enable Product</label>
      </div>`;
    const cb = document.getElementById("st") as HTMLInputElement;
    Object.defineProperty(cb, "getBoundingClientRect", {
      value: () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }),
      configurable: true,
    });

    const r = run({ queries: ["Enable Product"], mode: "all" });
    const hit = r.matches.find((m) => /Enable Product/i.test(m.snippet));
    expect(hit).toBeDefined();
    expect(hit!.pieIdx).toBe(0); // the rescued label carries pie_idx 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s test src/lib/dom-actions/search-page.test.ts -t "label-rescued"`
Expected: FAIL — the hidden input has no pie_idx and the label was never stamped, so the match (if any) has `pieIdx: null`.

- [ ] **Step 3: Mirror the helpers + rescue branch**

In `src/lib/dom-actions/search-page.ts`, after the verbatim `isVisible` (ends L129), add the same two helpers as Task 1 Step 3 (`isRescuableControl`, `visibleLabelFor`) — paste them verbatim. Then replace the exact stamp loop at L136-141:

```ts
  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      el.setAttribute("data-pie-idx", String(stampIdx++));
    }
  }
```

with:

```ts
  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      el.setAttribute("data-pie-idx", String(stampIdx++));
    } else if (
      el.matches?.(INTERACTIVE_SELECTOR) &&
      isRescuableControl(el) &&
      !isVisible(el)
    ) {
      const label = visibleLabelFor(el);
      if (label && !label.hasAttribute("data-pie-idx")) {
        label.setAttribute("data-pie-idx", String(stampIdx++));
      }
    }
  }
```

> `search-page.ts` stamps only the live element (no clone mirroring) and iterates the materialized `liveBodyElements = [...walkDeep(document.body)]` (L132). Keep that shape — set `data-pie-idx` directly; do not introduce the clone `stamp()` helper here.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s test src/lib/dom-actions/search-page.test.ts -t "label-rescued"`
Expected: PASS.

- [ ] **Step 5: Run parity + full file**

Run: `pnpm -s test src/lib/dom-actions/search-page.test.ts src/lib/dom-actions/interactive-parity.test.ts`
Expected: PASS — `interactive-parity` still green (the `INTERACTIVE_SELECTOR` string literal is unchanged; the rescue is added logic, not a selector edit).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dom-actions/search-page.ts src/lib/dom-actions/search-page.test.ts
git commit -m "feat(search-page): mirror hidden-control label-rescue for read_page parity (#141)"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all green, no new failures.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. (Repo is at 0; any new error is a real regression. Common pitfalls: `(el as HTMLLabelElement).control` and `(el as HTMLInputElement).labels` casts — these are valid DOM types.)

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: success (build-time invariants in `tool-names.ts` / `tools.ts` pass — this change touches neither).

- [ ] **Step 4: Manual smoke (optional, recommended before PR)**

On the live WebArena Magento product edit page (`localhost:7780/admin/catalog/product/edit/id/478/`, admin/admin1234) with the dev build loaded: `read_page` should now list the "Enable Product" toggle as a `checkbox … checked` entry; `click` on its pie_idx should flip it to unchecked (re-`read_page` to confirm). Restore without saving.

- [ ] **Step 5: Commit any final touch-ups**

If Steps 1-3 surfaced fixes, commit them. Otherwise nothing to do.

---

## Self-Review notes (already folded in)

- **Spec coverage:** §4.1 stamp rescue → Task 1; §4.2 summary enrichment → Task 2; §4.3 search-page parity → Task 3; §7 test cases → covered across Tasks 1-3 (stamp, no-double-stamp, unreachable, enrichment, search parity); wrapping-label case is exercised by `.labels`/`.control` resolving for `for=`-association (the dominant Magento form), with wrapping deferred as a follow-up assertion if needed.
- **Out of scope (per spec §8):** Gap 2 (framework-bound menu items), main-world injection interface, #142.
- **Type consistency:** helper names `isRescuableControl` / `visibleLabelFor` and the `target`/`rescuedControl` locals are used identically in Tasks 1-3.
