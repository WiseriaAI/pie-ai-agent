import { describe, it, expect } from "vitest";
import { abortSummaryForReason } from "./abort-summary";
import { enDict } from "@/lib/i18n/dictionaries/en";

function valueAt(dict: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], dict);
}

describe("abortSummaryForReason", () => {
  it("maps each detach reason to a distinct dict key", () => {
    const keys = new Set(
      (
        [
          "user-cancelled-via-yellow-bar",
          "kill-switch",
          "tab-closed",
          null,
        ] as const
      ).map((r) => abortSummaryForReason(r).summaryKey),
    );
    // Four reasons → four distinct keys.
    expect(keys.size).toBe(4);
  });

  it("falls back to the generic 'stopped' key for unmapped / null reasons", () => {
    expect(abortSummaryForReason(null).summaryKey).toBe(
      "agentSummary.abort.stopped",
    );
    expect(abortSummaryForReason("abort-signal").summaryKey).toBe(
      "agentSummary.abort.stopped",
    );
    expect(abortSummaryForReason("explicit-detach").summaryKey).toBe(
      "agentSummary.abort.stopped",
    );
  });

  it("every produced summaryKey resolves in the English dictionary", () => {
    for (const reason of [
      "user-cancelled-via-yellow-bar",
      "kill-switch",
      "tab-closed",
      "abort-signal",
      null,
    ] as const) {
      const { summaryKey } = abortSummaryForReason(reason);
      const v = valueAt(enDict, summaryKey);
      expect(typeof v, summaryKey).toBe("string");
      expect((v as string).length, summaryKey).toBeGreaterThan(0);
    }
  });

  it("carries a non-empty English fallback summary for wire/non-UI consumers", () => {
    for (const reason of [
      "user-cancelled-via-yellow-bar",
      "kill-switch",
      "tab-closed",
      null,
    ] as const) {
      const { summary } = abortSummaryForReason(reason);
      expect(summary.length).toBeGreaterThan(0);
      // Fallback is English (ASCII) — no CJK so non-UI consumers stay readable.
      expect(/[一-鿿]/.test(summary)).toBe(false);
    }
  });
});
