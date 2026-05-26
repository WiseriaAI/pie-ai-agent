import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CDP_INPUT_ENABLED_STORAGE_KEY,
  LEGACY_KEYBOARD_FLAG_KEY,
} from "@/lib/cdp-input-enabled";
import { runCdpInputMigration } from "./cdp-input-migration";

beforeEach(() => {
  const data: Record<string, unknown> = {};
  // @ts-expect-error mock
  global.chrome = {
    storage: {
      local: {
        get: vi.fn((keys) => {
          const want = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of want) if (k in data) out[k] = data[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((kv) => {
          Object.assign(data, kv);
          return Promise.resolve();
        }),
        remove: vi.fn((keys) => {
          const want = Array.isArray(keys) ? keys : [keys];
          for (const k of want) delete data[k];
          return Promise.resolve();
        }),
      },
    },
  };
});

describe("runCdpInputMigration", () => {
  it("is idempotent (running twice produces same final state)", async () => {
    await chrome.storage.local.set({ [LEGACY_KEYBOARD_FLAG_KEY]: true });
    await runCdpInputMigration();
    await runCdpInputMigration();
    const r = await chrome.storage.local.get([
      CDP_INPUT_ENABLED_STORAGE_KEY,
      LEGACY_KEYBOARD_FLAG_KEY,
    ]);
    expect(r[CDP_INPUT_ENABLED_STORAGE_KEY]).toBe(true);
    expect(LEGACY_KEYBOARD_FLAG_KEY in r).toBe(false);
  });
});
