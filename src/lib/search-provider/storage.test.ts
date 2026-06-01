import { describe, it, expect, beforeEach } from "vitest";
import {
  getSearchProviderKey,
  setSearchProviderKey,
  clearSearchProviderKey,
  getSearchProviderStatus,
  markVerified,
} from "./storage";

// chrome.storage.local mock — same pattern as other tests in the repo.
const memStore = new Map<string, unknown>();
beforeEach(() => {
  memStore.clear();
  globalThis.chrome = {
    storage: {
      local: ({
        get: async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of arr) if (memStore.has(k)) out[k] = memStore.get(k);
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) memStore.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) memStore.delete(k);
        },
      } as unknown as typeof chrome.storage.local),
    },
  } as unknown as typeof chrome;
});

describe("search-provider storage", () => {
  it("returns null when no key set", async () => {
    expect(await getSearchProviderKey("tavily")).toBeNull();
  });

  it("round-trips plaintext through encrypt/decrypt", async () => {
    await setSearchProviderKey("tavily", "tvly-secret-abc");
    expect(await getSearchProviderKey("tavily")).toBe("tvly-secret-abc");
    // Raw storage must NOT contain plaintext
    const raw = memStore.get("search_provider_tavily") as { encryptedKey: string };
    expect(raw.encryptedKey).not.toContain("tvly-secret-abc");
  });

  it("clearSearchProviderKey removes the entry", async () => {
    await setSearchProviderKey("tavily", "tvly-x");
    await clearSearchProviderKey("tavily");
    expect(await getSearchProviderKey("tavily")).toBeNull();
    expect(memStore.has("search_provider_tavily")).toBe(false);
  });

  it("getSearchProviderStatus returns configured=false when unset", async () => {
    const s = await getSearchProviderStatus("tavily");
    expect(s).toEqual({ configured: false });
  });

  it("getSearchProviderStatus returns masked key when configured", async () => {
    await setSearchProviderKey("tavily", "tvly-prod-abcdefgh12345XYZ12");
    const s = await getSearchProviderStatus("tavily");
    expect(s.configured).toBe(true);
    expect(s.maskedKey).toMatch(/^tvly-/);
    expect(s.maskedKey).toMatch(/XYZ12$/);
    expect(s.maskedKey).toContain("·");
    expect(s.maskedKey).not.toContain("abcdefgh");
  });

  it("markVerified records timestamp", async () => {
    await setSearchProviderKey("tavily", "tvly-x");
    await markVerified("tavily");
    const s = await getSearchProviderStatus("tavily");
    expect(s.lastVerifiedAt).toBeGreaterThan(Date.now() - 1000);
  });
});
