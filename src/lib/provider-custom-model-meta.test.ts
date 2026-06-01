import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getProviderCustomModelMetas,
  getProviderCustomModelMeta,
  setProviderCustomModelMeta,
  removeProviderCustomModelMeta,
  DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
} from "./provider-custom-model-meta";

// In-memory chrome.storage.local mock (happy-dom 不带 chrome)
beforeEach(() => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  });
});

describe("provider-custom-model-meta", () => {
  it("default max context is 256k", () => {
    expect(DEFAULT_CUSTOM_MODEL_MAX_CONTEXT).toBe(256_000);
  });

  it("empty get returns {}", async () => {
    expect(await getProviderCustomModelMetas("minimax")).toEqual({});
    expect(await getProviderCustomModelMeta("minimax", "x")).toBeUndefined();
  });

  it("set then get round-trips, scoped per provider", async () => {
    await setProviderCustomModelMeta("minimax", "MiniMax-X", {
      vision: true,
      maxContextTokens: 1_000_000,
    });
    expect(await getProviderCustomModelMeta("minimax", "MiniMax-X")).toEqual({
      vision: true,
      maxContextTokens: 1_000_000,
    });
    // 不同 provider 隔离
    expect(await getProviderCustomModelMeta("mimo", "MiniMax-X")).toBeUndefined();
  });

  it("remove deletes the entry only", async () => {
    await setProviderCustomModelMeta("minimax", "a", {
      vision: false,
      maxContextTokens: 256_000,
    });
    await setProviderCustomModelMeta("minimax", "b", {
      vision: true,
      maxContextTokens: 256_000,
    });
    await removeProviderCustomModelMeta("minimax", "a");
    expect(await getProviderCustomModelMeta("minimax", "a")).toBeUndefined();
    expect(await getProviderCustomModelMeta("minimax", "b")).toBeTruthy();
  });

  it("remove of absent id is a no-op", async () => {
    await removeProviderCustomModelMeta("minimax", "nonexistent");
    expect(await getProviderCustomModelMetas("minimax")).toEqual({});
  });

  it("displayName round-trips", async () => {
    await setProviderCustomModelMeta("minimax", "named", {
      displayName: "My Model",
      vision: false,
      maxContextTokens: 256_000,
    });
    expect(await getProviderCustomModelMeta("minimax", "named")).toEqual({
      displayName: "My Model",
      vision: false,
      maxContextTokens: 256_000,
    });
  });
});
