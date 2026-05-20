import { describe, expect, it } from "vitest";
import {
  stableStringify,
  stepSignature,
  detectLoop,
  recordStep,
  type StepSignature,
} from "./loop-detection";

describe("stableStringify", () => {
  it("orders object keys deterministically", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });
  it("recurses into nested objects and arrays", () => {
    expect(stableStringify({ x: [{ q: 1, p: 2 }] })).toBe(
      stableStringify({ x: [{ p: 2, q: 1 }] }),
    );
  });
  it("renders primitives and null/undefined", () => {
    expect(stableStringify(5)).toBe("5");
    expect(stableStringify("hi")).toBe('"hi"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("null");
  });
});

describe("stepSignature", () => {
  it("is stable across arg key order", () => {
    const a = stepSignature([{ name: "click", args: { frameId: 0, elementIndex: 3 } }]);
    const b = stepSignature([{ name: "click", args: { elementIndex: 3, frameId: 0 } }]);
    expect(a).toBe(b);
  });
  it("differs when tool or args differ", () => {
    expect(stepSignature([{ name: "click", args: { elementIndex: 1 } }])).not.toBe(
      stepSignature([{ name: "click", args: { elementIndex: 2 } }]),
    );
    expect(stepSignature([{ name: "click", args: {} }])).not.toBe(
      stepSignature([{ name: "type", args: {} }]),
    );
  });
  it("returns empty string for zero calls", () => {
    expect(stepSignature([])).toBe("");
  });
});

describe("detectLoop", () => {
  const sig = "click:{\"elementIndex\":1}";
  const ok = (s: string): StepSignature => ({ sig: s, allErrored: false });
  const err = (s: string): StepSignature => ({ sig: s, allErrored: true });

  it("returns none when nothing repeats", () => {
    expect(detectLoop([ok("a"), ok("b")], "c")).toEqual({ kind: "none" });
  });

  it("returns none for an empty buffer", () => {
    expect(detectLoop([], sig)).toEqual({ kind: "none" });
  });

  it("A: fires exact-repeat on the 3rd identical step (default threshold 3)", () => {
    // two prior identical + current = 3
    expect(detectLoop([ok(sig), ok(sig)], sig)).toEqual({
      kind: "exact-repeat",
      count: 3,
    });
  });

  it("A: does NOT fire on only the 2nd identical step", () => {
    expect(detectLoop([ok(sig)], sig)).toEqual({ kind: "none" });
  });

  it("B: fires repeat-error on the 2nd identical errored step (default threshold 2)", () => {
    expect(detectLoop([err(sig)], sig)).toEqual({
      kind: "repeat-error",
      count: 2,
    });
  });

  it("B: a single non-errored prior step does NOT trip repeat-error", () => {
    expect(detectLoop([ok(sig)], sig)).toEqual({ kind: "none" });
  });

  it("only counts the contiguous trailing run of the current sig", () => {
    // older identical sig separated by a different sig does not count
    expect(detectLoop([ok(sig), ok("other"), ok(sig)], sig)).toEqual({
      kind: "none",
    });
  });

  it("respects custom thresholds", () => {
    expect(
      detectLoop([ok(sig)], sig, { exactRepeatThreshold: 2 }),
    ).toEqual({ kind: "exact-repeat", count: 2 });
  });
});

describe("recordStep", () => {
  it("caps the ring buffer to the newest entries", () => {
    const buf: StepSignature[] = [];
    for (let i = 0; i < 7; i++) {
      recordStep(buf, { sig: `s${i}`, allErrored: false }, 5);
    }
    expect(buf.map((e) => e.sig)).toEqual(["s2", "s3", "s4", "s5", "s6"]);
  });
});
