/**
 * Guards that the self-contained injected functions inline the SAME
 * INTERACTIVE_SELECTOR string literal as the canonical _shared source. They
 * cannot import it (executeScript serializes their bodies), so drift is caught
 * here via source-text inspection of Function.prototype.toString().
 * All three injected functions (pageSnapshotInjected, searchPageInjected,
 * installCaptureListener) are guarded here.
 *
 * Implementation note: esbuild compiles single-quoted strings with interior
 * double-quotes to double-quoted strings with escaped interior double-quotes
 * (e.g. `'[role="button"]'` → `"[role=\"button\"]"` in the compiled output).
 * fn.toString() reflects the *compiled* source, so we compare against the
 * JSON-escape form: JSON.stringify(INTERACTIVE_SELECTOR).slice(1,-1) strips the
 * outer quotes, leaving the escaped content that esbuild emits verbatim.
 */
import { describe, it, expect } from "vitest";
import { INTERACTIVE_SELECTOR } from "./_shared/interactive";
import { pageSnapshotInjected } from "./page-snapshot";
import { searchPageInjected } from "./search-page";
import { installCaptureListener } from "@/lib/recording/capture";

describe("INTERACTIVE_SELECTOR parity across injected functions", () => {
  // esbuild-compiled fn.toString() uses double-quote escaping for string literals;
  // compare against the JSON-escaped form so the check is esbuild-agnostic.
  const escapedSelector = JSON.stringify(INTERACTIVE_SELECTOR).slice(1, -1);

  for (const [name, fn] of [
    ["pageSnapshotInjected", pageSnapshotInjected],
    ["searchPageInjected", searchPageInjected],
    ["installCaptureListener", installCaptureListener],
  ] as const) {
    it(`${name} inlines the canonical INTERACTIVE_SELECTOR literal`, () => {
      expect(fn.toString()).toContain(escapedSelector);
    });
  }
});
