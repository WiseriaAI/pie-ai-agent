import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { getConfig } from "@/lib/idb/config-store";
import {
  getSearchProviderKey,
  setSearchProviderKey,
  clearSearchProviderKey,
  getSearchProviderStatus,
  markVerified,
} from "./storage";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("search-provider storage", () => {
  it("returns null when no key set", async () => {
    expect(await getSearchProviderKey("tavily")).toBeNull();
  });

  it("round-trips plaintext through encrypt/decrypt", async () => {
    await setSearchProviderKey("tavily", "tvly-secret-abc");
    expect(await getSearchProviderKey("tavily")).toBe("tvly-secret-abc");
    // Raw storage must NOT contain plaintext
    const raw = await getConfig<{ encryptedKey: string }>("search_provider_tavily");
    expect(raw).not.toBeNull();
    expect(raw!.encryptedKey).not.toContain("tvly-secret-abc");
  });

  it("clearSearchProviderKey removes the entry", async () => {
    await setSearchProviderKey("tavily", "tvly-x");
    await clearSearchProviderKey("tavily");
    expect(await getSearchProviderKey("tavily")).toBeNull();
    expect(await getConfig("search_provider_tavily")).toBeUndefined();
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
