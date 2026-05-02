import { describe, expect, it } from "vitest";
import { canTransition, ALL_TRANSITIONS } from "./state-machine";
import type { SessionStatus } from "./types";

describe("ALL_TRANSITIONS", () => {
  it("is a non-empty array of [from, to] pairs", () => {
    expect(Array.isArray(ALL_TRANSITIONS)).toBe(true);
    expect(ALL_TRANSITIONS.length).toBeGreaterThan(0);
    for (const [from, to] of ALL_TRANSITIONS) {
      expect(typeof from).toBe("string");
      expect(typeof to).toBe("string");
    }
  });

  it("covers all 4 SessionStatus values on both sides", () => {
    const statuses: SessionStatus[] = ["active", "paused", "failed", "archived"];
    const fromSet = new Set(ALL_TRANSITIONS.map(([f]) => f));
    const toSet = new Set(ALL_TRANSITIONS.map(([, t]) => t));
    for (const s of statuses) {
      // every status should appear at least once as a source or destination
      expect(fromSet.has(s) || toSet.has(s)).toBe(true);
    }
  });
});

describe("canTransition — same-state self-transitions (idempotent helpers)", () => {
  const statuses: SessionStatus[] = ["active", "paused", "failed", "archived"];
  for (const s of statuses) {
    it(`${s} → ${s} allowed (defensive idempotency)`, () => {
      expect(canTransition(s, s)).toBe(true);
    });
  }
});

describe("canTransition — legal transitions (plan mermaid)", () => {
  it("active → failed (task error / cross-origin abort)", () => {
    expect(canTransition("active", "failed")).toBe(true);
  });

  it("active → paused (SW restart, no pending confirm)", () => {
    expect(canTransition("active", "paused")).toBe(true);
  });

  it("paused → active (user clicks 'Resume task', drift OK)", () => {
    expect(canTransition("paused", "active")).toBe(true);
  });

  it("paused → failed (user clicks 'Discard' on R11 drift card)", () => {
    expect(canTransition("paused", "failed")).toBe(true);
  });

  it("active → archived (LRU eviction or user soft-delete)", () => {
    expect(canTransition("active", "archived")).toBe(true);
  });

  it("failed → archived (LRU eviction or user soft-delete)", () => {
    expect(canTransition("failed", "archived")).toBe(true);
  });

  it("paused → archived (LRU eviction — paused doesn't protect from LRU)", () => {
    expect(canTransition("paused", "archived")).toBe(true);
  });

  it("archived → active (user manually unarchives within 30d window)", () => {
    expect(canTransition("archived", "active")).toBe(true);
  });
});

describe("canTransition — illegal transitions", () => {
  it("archived → failed is not allowed", () => {
    expect(canTransition("archived", "failed")).toBe(false);
  });

  it("archived → paused is not allowed", () => {
    expect(canTransition("archived", "paused")).toBe(false);
  });

  it("failed → active is not allowed (no direct unblock — must unarchive then re-activate)", () => {
    expect(canTransition("failed", "active")).toBe(false);
  });

  it("failed → paused is not allowed", () => {
    expect(canTransition("failed", "paused")).toBe(false);
  });

  it("active → active self-transition is the only active→active path", () => {
    // Verify 'active' has no 'running' sibling state leaking in
    expect(canTransition("active", "active")).toBe(true);
  });
});
