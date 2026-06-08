import { describe, expect, it } from "vitest";
import { createPageAtlasStore } from "./state";
import type { PageAtlasState } from "./types";

const atlas = (overrides: Partial<PageAtlasState> = {}): PageAtlasState => ({
  atlasId: "atlas_1",
  tabId: 7,
  url: "https://example.com/products",
  origin: "https://example.com",
  createdAt: 1_000,
  targets: [
    {
      id: "collection_c1",
      type: "collection",
      label: "Products",
      frameId: 0,
    },
    {
      id: "table_t1",
      type: "table",
      label: "Raw product table",
      frameId: 0,
    },
  ],
  ...overrides,
});

describe("page atlas store", () => {
  it("resolves a fresh target", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://example.com/products?page=2",
      targetId: "collection_c1",
      expectedType: "collection",
      now: 1_500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.id).toBe("collection_c1");
      expect(result.atlas.atlasId).toBe("atlas_1");
    }
  });

  it("returns the exact unsupported type message", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      targetId: "table_t1",
      expectedType: "collection",
      now: 1_500,
    });

    expect(result).toEqual({
      ok: false,
      reason: "unsupported_target_type",
      message: "target table_t1 is type table; expected collection",
    });
  });

  it("expires a stale atlas", () => {
    const store = createPageAtlasStore({ ttlMs: 100 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      targetId: "collection_c1",
      expectedType: "collection",
      now: 1_101,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("atlas_expired");
    }
    expect(store.get("atlas_1")).toBeUndefined();
  });

  it("fails closed when the current tab drifts cross-origin", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://evil.example/products",
      targetId: "collection_c1",
      expectedType: "collection",
      now: 1_500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("origin_changed");
    }
  });
});
