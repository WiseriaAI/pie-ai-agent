import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, unknown>();

vi.mock("@/lib/idb/config-store", () => ({
  getConfig: vi.fn(async (key: string) => store.get(key)),
  setConfig: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  }),
}));

import {
  getCustomRules,
  setCustomRules,
  STORAGE_KEY_CUSTOM_RULES,
  CUSTOM_RULES_MAX_LENGTH,
} from "./custom-rules";

describe("custom-rules storage", () => {
  beforeEach(() => store.clear());

  it("returns empty string when unset", async () => {
    expect(await getCustomRules()).toBe("");
  });

  it("returns empty string when a non-string value somehow lands in the store", async () => {
    store.set(STORAGE_KEY_CUSTOM_RULES, 42);
    expect(await getCustomRules()).toBe("");
  });

  it("round-trips a saved value", async () => {
    await setCustomRules("Always answer in bullet points.");
    expect(store.get(STORAGE_KEY_CUSTOM_RULES)).toBe("Always answer in bullet points.");
    expect(await getCustomRules()).toBe("Always answer in bullet points.");
  });

  it("clamps oversized input to CUSTOM_RULES_MAX_LENGTH on save", async () => {
    const huge = "x".repeat(CUSTOM_RULES_MAX_LENGTH + 500);
    await setCustomRules(huge);
    expect((store.get(STORAGE_KEY_CUSTOM_RULES) as string).length).toBe(CUSTOM_RULES_MAX_LENGTH);
  });
});
