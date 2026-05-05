import { describe, it, expect } from "vitest";
import { resolveEffectivePinned } from "./effective-pinned";
import type { SessionMeta } from "@/lib/sessions/types";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeGetMeta(meta: Partial<SessionMeta> | undefined | null) {
  return async (_id: string) => meta as SessionMeta | undefined | null;
}

function makeQueryActiveTab(tab: { id?: number; url?: string } | null) {
  return async () => (tab ? [tab] : []);
}

const noRestrict = (_url: string) => false;
const alwaysRestrict = (_url: string) => true;
function restrictChromeOnly(url: string) {
  return url.startsWith("chrome://");
}

const SESSION_ID = "test-session-abc";
const PINNED_CTX = { tabId: 42, origin: "https://example.com" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveEffectivePinned", () => {
  it("tier-1: returns closurePinned immediately when set", async () => {
    const result = await resolveEffectivePinned(
      PINNED_CTX,
      SESSION_ID,
      makeGetMeta(undefined), // should not be called
      makeQueryActiveTab(null), // should not be called
      noRestrict,
    );
    expect(result).toEqual(PINNED_CTX);
  });

  it("tier-2: returns meta pin when closure is undefined but meta has pinnedTabs[]", async () => {
    // v1.5 — tier-2 reads pinnedTabs[] via getPrimaryPin.
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta({ pinnedTabs: [{ tabId: 7, origin: "https://meta.example.com" }] }),
      makeQueryActiveTab(null), // should not be called
      noRestrict,
    );
    expect(result).toEqual({ tabId: 7, origin: "https://meta.example.com" });
  });

  it("tier-2: skips meta when pinnedTabs[] is empty/absent, falls through to tier 3", async () => {
    // v1.5 — no pinnedTabs[] → getPrimaryPin returns undefined → fall through.
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta({ pinnedOrigin: "https://meta.example.com" }), // no pinnedTabs
      makeQueryActiveTab({ id: 99, url: "https://active.example.com" }),
      noRestrict,
    );
    // Falls through to tier 3.
    expect(result).toEqual({ tabId: 99, origin: "https://active.example.com" });
  });

  it("tier-3: returns active-tab pin when both closure and meta are absent", async () => {
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta(undefined),
      makeQueryActiveTab({ id: 15, url: "https://active.example.com" }),
      noRestrict,
    );
    expect(result).toEqual({ tabId: 15, origin: "https://active.example.com" });
  });

  it("tier-3: returns null when active tab URL is restricted (chrome://)", async () => {
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta(undefined),
      makeQueryActiveTab({ id: 1, url: "chrome://newtab/" }),
      restrictChromeOnly,
    );
    expect(result).toBeNull();
  });

  it("tier-3: returns null when active tab has no URL", async () => {
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta(undefined),
      makeQueryActiveTab({ id: 5 }), // no url
      noRestrict,
    );
    expect(result).toBeNull();
  });

  it("tier-3: returns null when active tab list is empty", async () => {
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta(undefined),
      makeQueryActiveTab(null),
      noRestrict,
    );
    expect(result).toBeNull();
  });

  it("all-fail: returns null when active tab has malformed URL", async () => {
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta(undefined),
      makeQueryActiveTab({ id: 8, url: "not a url :::???" }),
      noRestrict,
    );
    expect(result).toBeNull();
  });

  it("tier-2 exception: falls through to tier-3 when getMetaFn throws", async () => {
    const throwingMeta = async (_id: string): Promise<SessionMeta | undefined> => {
      throw new Error("storage error");
    };
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      throwingMeta,
      makeQueryActiveTab({ id: 20, url: "https://fallback.example.com" }),
      noRestrict,
    );
    expect(result).toEqual({ tabId: 20, origin: "https://fallback.example.com" });
  });

  it("all tiers fail + isRestrictedUrl blocks → returns null", async () => {
    const result = await resolveEffectivePinned(
      undefined,
      SESSION_ID,
      makeGetMeta(null),
      makeQueryActiveTab({ id: 1, url: "chrome://settings/" }),
      alwaysRestrict,
    );
    expect(result).toBeNull();
  });
});
