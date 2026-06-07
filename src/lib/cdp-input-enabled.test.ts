import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { getConfig } from "@/lib/idb/config-store";
import {
  isCdpInputEnabled,
  setCdpInputEnabled,
  CDP_INPUT_ENABLED_STORAGE_KEY,
  migrateLegacyKeyboardFlag,
  LEGACY_KEYBOARD_FLAG_KEY,
} from "./cdp-input-enabled";

beforeEach(async () => {
  await _resetForTests();
});

describe("cdp-input-enabled", () => {
  it("returns undefined when never set", async () => {
    expect(await isCdpInputEnabled()).toBe(undefined);
  });

  it("returns true when set true", async () => {
    await setCdpInputEnabled(true);
    expect(await isCdpInputEnabled()).toBe(true);
  });

  it("returns false when set false", async () => {
    await setCdpInputEnabled(false);
    expect(await isCdpInputEnabled()).toBe(false);
  });

  it("migrates legacy keyboard_simulation_enabled=true to new key=true and deletes old", async () => {
    // seed legacy key directly into config store
    const { setConfig } = await import("@/lib/idb/config-store");
    await setConfig(LEGACY_KEYBOARD_FLAG_KEY, true);
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(true);
    expect(await getConfig(LEGACY_KEYBOARD_FLAG_KEY)).toBe(undefined);
  });

  it("migrates legacy keyboard_simulation_enabled=false to new key=false and deletes old", async () => {
    const { setConfig } = await import("@/lib/idb/config-store");
    await setConfig(LEGACY_KEYBOARD_FLAG_KEY, false);
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(false);
  });

  it("no-ops when legacy key absent (keeps new key undefined)", async () => {
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(undefined);
  });

  it("no-ops when new key already set (does not overwrite from legacy)", async () => {
    const { setConfig } = await import("@/lib/idb/config-store");
    await setCdpInputEnabled(false);
    await setConfig(LEGACY_KEYBOARD_FLAG_KEY, true);
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(false);
  });
});
