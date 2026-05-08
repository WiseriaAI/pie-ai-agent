import { describe, it, expect, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import { cleanupThinShellSkills } from "./migration-cleanup-thinshell";

// `chrome.storage.local` is mocked globally in src/test/setup.ts.
// The mock auto-resets __store = {} between tests via the global beforeEach.

describe("cleanupThinShellSkills", () => {
  it("no-op on empty storage", async () => {
    const removeSpy = vi.spyOn(chromeMock.storage.local, "remove");
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");

    await cleanupThinShellSkills();

    expect(removeSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();

    removeSpy.mockRestore();
    setSpy.mockRestore();
  });

  it("removes stale skill_take_screenshot / skill_open_url_in_tab user-side copies", async () => {
    const store = chromeMock.storage.local.__store;
    store.skill_take_screenshot = { id: "take_screenshot", builtIn: false };
    store.skill_open_url_in_tab = { id: "open_url_in_tab", builtIn: false };
    store.skill_other = { id: "other" };

    await cleanupThinShellSkills();

    expect("skill_take_screenshot" in store).toBe(false);
    expect("skill_open_url_in_tab" in store).toBe(false);
    expect("skill_other" in store).toBe(true);
  });

  it("filters stale enabled_skills markers", async () => {
    const store = chromeMock.storage.local.__store;
    store.enabled_skills = [
      "take_screenshot",
      "!open_url_in_tab",
      "auto_group_tabs",
      "!extract_structured_data",
    ];

    await cleanupThinShellSkills();

    expect(store.enabled_skills).toEqual([
      "auto_group_tabs",
      "!extract_structured_data",
    ]);
  });

  it("is idempotent across two consecutive runs", async () => {
    const store = chromeMock.storage.local.__store;
    store.skill_take_screenshot = { id: "take_screenshot" };
    store.enabled_skills = ["take_screenshot", "auto_group_tabs"];

    // Spy to track call counts across both runs.
    const removeSpy = vi.spyOn(chromeMock.storage.local, "remove");
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");

    await cleanupThinShellSkills();
    await cleanupThinShellSkills();

    expect("skill_take_screenshot" in store).toBe(false);
    expect(store.enabled_skills).toEqual(["auto_group_tabs"]);

    // Second run must be a no-op (no extra writes / removes after first cleanup).
    expect(removeSpy.mock.calls.length).toBeLessThanOrEqual(2); // 1st run only
    expect(setSpy.mock.calls.length).toBeLessThanOrEqual(1); // 1st run only

    removeSpy.mockRestore();
    setSpy.mockRestore();
  });
});
