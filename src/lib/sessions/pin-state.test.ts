import { describe, it, expect } from "vitest";
import {
  getPrimaryPin,
  addPinToMeta,
  removePinFromMeta,
  getEffectivePinMode,
  clearTaskPinIfActive,
  togglePinTabUserMode,
  clearUserPin,
} from "./pin-state";
import type { SessionMeta, SessionAgentState } from "./types";

const FRESH = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: "s1",
  createdAt: 0,
  lastAccessedAt: 0,
  status: "active",
  messages: [],
  ...overrides,
});

const AGENT = (stepIndex: number): SessionAgentState => ({
  agentMessages: [],
  pendingInstructions: [],
  stepIndex,
  hasImageContent: false,
});

describe("v1.5 pin-state helpers (multi-pin Path A)", () => {
  it("getPrimaryPin returns first entry of pinnedTabs", () => {
    const meta = FRESH({
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    expect(getPrimaryPin(meta)).toEqual({ tabId: 12, origin: "https://a.com" });
  });

  it("getPrimaryPin returns undefined for empty / absent array", () => {
    expect(getPrimaryPin(FRESH())).toBeUndefined();
    expect(getPrimaryPin(FRESH({ pinnedTabs: [] }))).toBeUndefined();
  });

  it("addPinToMeta pushes new entry", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    const next = addPinToMeta(meta, { tabId: 13, origin: "https://b.com" });
    expect(next.pinnedTabs).toEqual([
      { tabId: 12, origin: "https://a.com" },
      { tabId: 13, origin: "https://b.com" },
    ]);
  });

  it("addPinToMeta is idempotent for duplicate tabId", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    const next = addPinToMeta(meta, { tabId: 12, origin: "https://a.com" });
    expect(next.pinnedTabs).toHaveLength(1);
  });

  it("removePinFromMeta drops matching tabId", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    const next = removePinFromMeta(meta, 13);
    expect(next.pinnedTabs).toEqual([{ tabId: 12, origin: "https://a.com" }]);
  });

  it("clearTaskPinIfActive empties pinnedTabs array in task mode", () => {
    const meta = FRESH({
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    const next = clearTaskPinIfActive(meta);
    expect(next.pinMode).toBe("auto");
    expect(next.pinnedTabs).toBeUndefined();
  });

  it("clearTaskPinIfActive preserves user-mode array", () => {
    const meta = FRESH({
      pinMode: "user",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    expect(clearTaskPinIfActive(meta)).toBe(meta);
  });

  describe("togglePinTabUserMode", () => {
    it("from auto: first toggle adds + flips to user mode", () => {
      const meta = FRESH({ pinMode: "auto" });
      const next = togglePinTabUserMode(meta, { tabId: 12, origin: "https://a.com" });
      expect(next.pinMode).toBe("user");
      expect(next.pinnedTabs).toEqual([{ tabId: 12, origin: "https://a.com" }]);
    });

    it("from user with one pin: toggling another adds (multi-select)", () => {
      const meta = FRESH({
        pinMode: "user",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      });
      const next = togglePinTabUserMode(meta, { tabId: 13, origin: "https://b.com" });
      expect(next.pinMode).toBe("user");
      expect(next.pinnedTabs).toEqual([
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ]);
    });

    it("from user with two pins: toggling existing tab removes it", () => {
      const meta = FRESH({
        pinMode: "user",
        pinnedTabs: [
          { tabId: 12, origin: "https://a.com" },
          { tabId: 13, origin: "https://b.com" },
        ],
      });
      const next = togglePinTabUserMode(meta, { tabId: 12, origin: "https://a.com" });
      expect(next.pinMode).toBe("user");
      expect(next.pinnedTabs).toEqual([{ tabId: 13, origin: "https://b.com" }]);
    });

    it("from user with one pin: toggling that tab removes it AND flips to auto", () => {
      const meta = FRESH({
        pinMode: "user",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      });
      const next = togglePinTabUserMode(meta, { tabId: 12, origin: "https://a.com" });
      expect(next.pinMode).toBe("auto");
      expect(next.pinnedTabs).toBeUndefined();
    });

    it("from task mode: refuses (no-op identity) — loop owns task pins", () => {
      const meta = FRESH({
        pinMode: "task",
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      });
      const next = togglePinTabUserMode(meta, { tabId: 13, origin: "https://b.com" });
      expect(next).toBe(meta);
    });
  });

  it("clearUserPin clears all pinnedTabs and flips to auto; no-op for task mode", () => {
    const userMeta = FRESH({
      pinMode: "user",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    });
    const cleared = clearUserPin(userMeta);
    expect(cleared.pinMode).toBe("auto");
    expect(cleared.pinnedTabs).toBeUndefined();

    const taskMeta = FRESH({
      pinMode: "task",
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    expect(clearUserPin(taskMeta)).toBe(taskMeta);
  });

  it("getEffectivePinMode infers 'task' from non-empty pinnedTabs + in-flight agent", () => {
    const meta = FRESH({
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
    });
    expect(getEffectivePinMode(meta, AGENT(3))).toBe("task");
  });

  it("getEffectivePinMode returns 'auto' for empty array even with in-flight agent", () => {
    const meta = FRESH({ pinnedTabs: [] });
    expect(getEffectivePinMode(meta, AGENT(3))).toBe("auto");
  });
});
