import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isCdpInputEnabled,
  setCdpInputEnabled,
  CDP_INPUT_ENABLED_STORAGE_KEY,
  migrateLegacyKeyboardFlag,
  LEGACY_KEYBOARD_FLAG_KEY,
} from "./cdp-input-enabled";

interface MockStorage { [k: string]: unknown }

beforeEach(() => {
  const data: MockStorage = {};
  global.chrome = {
    storage: {
      local: ({
        get: vi.fn((keys: string | string[]) => {
          const want = Array.isArray(keys) ? keys : [keys];
          const out: MockStorage = {};
          for (const k of want) if (k in data) out[k] = data[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((kv: MockStorage) => {
          Object.assign(data, kv);
          return Promise.resolve();
        }),
        remove: vi.fn((keys: string | string[]) => {
          const want = Array.isArray(keys) ? keys : [keys];
          for (const k of want) delete data[k];
          return Promise.resolve();
        }),
      } as unknown as typeof chrome.storage.local),
    },
  } as unknown as typeof chrome;
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
    await chrome.storage.local.set({ [LEGACY_KEYBOARD_FLAG_KEY]: true });
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(true);
    const after = await chrome.storage.local.get(LEGACY_KEYBOARD_FLAG_KEY);
    expect(after[LEGACY_KEYBOARD_FLAG_KEY]).toBe(undefined);
  });

  it("migrates legacy keyboard_simulation_enabled=false to new key=false and deletes old", async () => {
    await chrome.storage.local.set({ [LEGACY_KEYBOARD_FLAG_KEY]: false });
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(false);
  });

  it("no-ops when legacy key absent (keeps new key undefined)", async () => {
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(undefined);
  });

  it("no-ops when new key already set (does not overwrite from legacy)", async () => {
    await setCdpInputEnabled(false);
    await chrome.storage.local.set({ [LEGACY_KEYBOARD_FLAG_KEY]: true });
    await migrateLegacyKeyboardFlag();
    expect(await isCdpInputEnabled()).toBe(false);
  });
});
