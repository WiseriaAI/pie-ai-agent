/**
 * Guards that the self-contained injected functions inline the SAME
 * INTERACTIVE_SELECTOR string literal as the canonical _shared source. They
 * cannot import it (executeScript serializes their bodies), so drift is caught
 * here via source-text inspection of Function.prototype.toString().
 * Both injected functions (probePageInjected, installCaptureListener) are
 * guarded here.
 *
 * Implementation note: esbuild compiles single-quoted strings with interior
 * double-quotes to double-quoted strings with escaped interior double-quotes
 * (e.g. `'[role="button"]'` → `"[role=\"button\"]"` in the compiled output).
 * fn.toString() reflects the *compiled* source, so we compare against the
 * JSON-escape form: JSON.stringify(INTERACTIVE_SELECTOR).slice(1,-1) strips the
 * outer quotes, leaving the escaped content that esbuild emits verbatim.
 *
 * Part A (Task 11) also guards:
 *  - EDITOR_SELECTOR inlined into probePageInjected
 *  - Every WRAPPER_TAGS_LIST tag inlined into probePageInjected
 *  - Every TYPE_EDITOR_MARKERS entry (selector + engine name) inlined into actByIdxInjected
 *  - Shadow-recursion markers in both actByIdxInjected and LOCATE_BY_IDX_FRAGMENT
 */
import { describe, it, expect } from "vitest";
import {
  INTERACTIVE_SELECTOR,
  EDITOR_SELECTOR,
  EDITOR_ENGINE_MAP,
  WRAPPER_TAGS_LIST,
  TYPE_EDITOR_MARKERS,
} from "./_shared/interactive";
import { probePageInjected } from "./probe-core";
import { actByIdxInjected } from "./act-core";
import { LOCATE_BY_IDX_FRAGMENT } from "./_shared/locate";
import { installCaptureListener } from "@/lib/recording/capture";

describe("INTERACTIVE_SELECTOR parity across injected functions", () => {
  // esbuild-compiled fn.toString() uses double-quote escaping for string literals;
  // compare against the JSON-escaped form so the check is esbuild-agnostic.
  const escapedSelector = JSON.stringify(INTERACTIVE_SELECTOR).slice(1, -1);

  for (const [name, fn] of [
    ["probePageInjected", probePageInjected],
    ["installCaptureListener", installCaptureListener],
  ] as const) {
    it(`${name} inlines the canonical INTERACTIVE_SELECTOR literal`, () => {
      expect(fn.toString()).toContain(escapedSelector);
    });
  }
});

// ── Part A: EDITOR_SELECTOR parity ────────────────────────────────────────────
describe("EDITOR_SELECTOR parity in probePageInjected", () => {
  // Same esbuild double-quote escape technique used for INTERACTIVE_SELECTOR above.
  const escapedEditorSelector = JSON.stringify(EDITOR_SELECTOR).slice(1, -1);

  it("probePageInjected inlines the canonical EDITOR_SELECTOR literal", () => {
    expect(probePageInjected.toString()).toContain(escapedEditorSelector);
  });
});

// ── Part A: WRAPPER_TAGS_LIST parity ─────────────────────────────────────────
describe("WRAPPER_TAGS_LIST parity in probePageInjected", () => {
  // Every tag in the canonical list must appear as a string literal inside the
  // injected function. Because wrapper tags are plain ASCII identifiers (no
  // internal quotes), JSON.stringify(tag) === `"${tag}"`, so we just check for
  // the raw tag name (no esbuild escaping needed).
  for (const tag of WRAPPER_TAGS_LIST) {
    it(`probePageInjected inlines wrapper tag "${tag}"`, () => {
      expect(probePageInjected.toString()).toContain(tag);
    });
  }
});

// ── Part A: TYPE_EDITOR_MARKERS parity in actByIdxInjected ───────────────────
describe("TYPE_EDITOR_MARKERS parity in actByIdxInjected (Task 6 drift guard)", () => {
  // actByIdxInjected inlines detectEditor() which copies TYPE_EDITOR_MARKERS
  // verbatim. Guard each [selector, engineName] entry so future edits to the
  // authoritative _shared/interactive.ts are caught immediately.
  for (const [selector, engineName] of TYPE_EDITOR_MARKERS) {
    // Engine name (plain ASCII, e.g. "Monaco") — check raw string
    it(`actByIdxInjected inlines engine name "${engineName}"`, () => {
      expect(actByIdxInjected.toString()).toContain(engineName);
    });
    // Selector may contain double-quotes (e.g. `[data-slate-editor="true"]`);
    // apply the same JSON-escape technique for reliable matching.
    const escapedSelector = JSON.stringify(selector).slice(1, -1);
    it(`actByIdxInjected inlines selector ${JSON.stringify(selector)}`, () => {
      expect(actByIdxInjected.toString()).toContain(escapedSelector);
    });
  }
});

// ── Part A: EDITOR_ENGINE_MAP parity in probePageInjected (editorEngineOf) ────
describe("EDITOR_ENGINE_MAP parity in probePageInjected", () => {
  // probePageInjected inlines editorEngineOf() which maps each editor host class
  // to its engine display name. Guard each [selector, engine] pair so the inline
  // mapping can't drift from the authoritative EDITOR_ENGINE_MAP.
  for (const [selector, engine] of EDITOR_ENGINE_MAP) {
    const escapedSelector = JSON.stringify(selector).slice(1, -1);
    it(`probePageInjected inlines editor host class ${JSON.stringify(selector)}`, () => {
      expect(probePageInjected.toString()).toContain(escapedSelector);
    });
    it(`probePageInjected inlines engine name "${engine}"`, () => {
      expect(probePageInjected.toString()).toContain(engine);
    });
  }
});

// ── capture: EDITOR_SELECTOR + EDITOR_ENGINE_MAP parity ──────────────────────
describe("EDITOR_SELECTOR / EDITOR_ENGINE_MAP parity in installCaptureListener", () => {
  const escapedEditorSelector = JSON.stringify(EDITOR_SELECTOR).slice(1, -1);
  it("installCaptureListener inlines the canonical EDITOR_SELECTOR literal", () => {
    expect(installCaptureListener.toString()).toContain(escapedEditorSelector);
  });
  for (const [selector, engine] of EDITOR_ENGINE_MAP) {
    const escapedSelector = JSON.stringify(selector).slice(1, -1);
    it(`installCaptureListener inlines editor host class ${JSON.stringify(selector)}`, () => {
      expect(installCaptureListener.toString()).toContain(escapedSelector);
    });
    it(`installCaptureListener inlines engine name "${engine}"`, () => {
      expect(installCaptureListener.toString()).toContain(engine);
    });
  }
});

// ── Part A: Shadow-recursion structural parity ────────────────────────────────
// LOCATE_BY_IDX_FRAGMENT (CDP string) and actByIdxInjected (findByIdxDeep) must
// both contain open-shadow recursion markers so they stay structurally mirrored.
describe("Open-shadow recursion markers in actByIdxInjected and LOCATE_BY_IDX_FRAGMENT", () => {
  const OPEN_SHADOW_MARKERS = ["shadowRoot", "open"] as const;

  for (const marker of OPEN_SHADOW_MARKERS) {
    it(`actByIdxInjected contains open-shadow marker "${marker}"`, () => {
      expect(actByIdxInjected.toString()).toContain(marker);
    });

    it(`LOCATE_BY_IDX_FRAGMENT contains open-shadow marker "${marker}"`, () => {
      expect(LOCATE_BY_IDX_FRAGMENT).toContain(marker);
    });
  }
});
