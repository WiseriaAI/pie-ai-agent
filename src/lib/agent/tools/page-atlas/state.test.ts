import { describe, expect, it } from "vitest";
import { createPageAtlasStore, parseOrigin } from "./state";
import type { PageAtlasState } from "./types";

const atlas = (overrides: Partial<PageAtlasState> = {}): PageAtlasState => ({
  atlasId: "atlas_1",
  tabId: 7,
  url: "https://example.com/products",
  origin: "https://example.com",
  title: "Products",
  createdAt: 1_000,
  fingerprint: {
    url: "https://example.com/products",
    title: "Products",
    bodyTextLengthBucket: 10,
    interactiveCountBucket: 5,
    topSectionCount: 2,
  },
  targets: [
    {
      id: "collection_c1",
      type: "collection",
      label: "Products",
      frameId: 0,
      confidence: "high",
      summary: "Visible product cards",
      visibleCount: 2,
      estimatedTotal: 2,
      records: [
        {
          id: "record_r1",
          fields: { name: "Pie" },
          text: "Pie",
          evidence: "card text",
        },
      ],
    },
    {
      id: "table_t1",
      type: "table",
      label: "Raw product table",
      frameId: 0,
      confidence: "medium",
      summary: "Raw product rows",
      columns: ["name"],
    },
  ],
  controls: [
    {
      id: "control_next",
      frameId: 0,
      pieIdx: 4,
      type: "button",
      label: "Next",
    },
  ],
  forms: [
    {
      id: "form_search",
      label: "Search",
      frameId: 0,
      fields: ["query"],
      submitControlId: "control_next",
    },
  ],
  controlGroups: [
    {
      id: "group_filters",
      label: "Filters",
      frameId: 0,
      controls: ["control_next"],
    },
  ],
  navigation: [
    {
      id: "navigation_pages",
      type: "pagination",
      label: "Pages",
      frameId: 0,
      controls: ["control_next"],
    },
  ],
  ...overrides,
});

describe("page atlas store", () => {
  it("parses invalid and opaque URL origins as null", () => {
    expect(parseOrigin("not a url")).toBeNull();
    expect(parseOrigin("about:blank")).toBeNull();
    expect(parseOrigin("data:text/html,hi")).toBeNull();
  });

  it("resolves a fresh target", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://example.com/products?page=2",
      targetId: "collection_c1",
      allowedTypes: ["collection"],
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
      allowedTypes: ["collection"],
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
      allowedTypes: ["collection"],
      now: 1_101,
    });

    expect(result).toEqual({
      ok: false,
      reason: "atlas_expired",
      message: "The page atlas is stale. Call read_page({mode:\"atlas\"}) again.",
    });
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
      allowedTypes: ["collection"],
      now: 1_500,
    });

    expect(result).toEqual({
      ok: false,
      reason: "origin_changed",
      message: "The page origin changed since the atlas was created. Call read_page({mode:\"atlas\"}) again.",
    });
  });

  it("resolves a null-origin atlas only when the current URL is unchanged", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });
    store.save(atlas({
      url: "about:blank",
      origin: null,
      fingerprint: {
        url: "about:blank",
        title: "Products",
        bodyTextLengthBucket: 10,
        interactiveCountBucket: 5,
        topSectionCount: 2,
      },
    }));

    const result = store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "about:blank",
      targetId: "collection_c1",
      allowedTypes: ["collection"],
      now: 1_500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.id).toBe("collection_c1");
    }
  });

  it("fails closed when a null-origin atlas sees a different opaque or invalid URL", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });
    store.save(atlas({
      url: "about:blank",
      origin: null,
      fingerprint: {
        url: "about:blank",
        title: "Products",
        bodyTextLengthBucket: 10,
        interactiveCountBucket: 5,
        topSectionCount: 2,
      },
    }));

    for (const currentUrl of ["data:text/html,hi", "not a url"]) {
      expect(store.resolveTarget({
        atlasId: "atlas_1",
        tabId: 7,
        currentUrl,
        targetId: "collection_c1",
        allowedTypes: ["collection"],
        now: 1_500,
      })).toEqual({
        ok: false,
        reason: "origin_changed",
        message: "The page origin changed since the atlas was created. Call read_page({mode:\"atlas\"}) again.",
      });
    }
  });

  it("returns exact fail-closed messages for missing atlas, target, and tab mismatch", () => {
    const store = createPageAtlasStore({ ttlMs: 5_000 });

    expect(store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      targetId: "collection_c1",
      allowedTypes: ["collection"],
      now: 1_500,
    })).toEqual({
      ok: false,
      reason: "atlas_not_found",
      message: "Call read_page({mode:\"atlas\"}) first, then use a target_id from that atlas.",
    });

    store.save(atlas());

    expect(store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 8,
      currentUrl: "https://example.com/products",
      targetId: "collection_c1",
      allowedTypes: ["collection"],
      now: 1_500,
    })).toEqual({
      ok: false,
      reason: "tab_mismatch",
      message: "atlas atlas_1 belongs to tab 7, not tab 8",
    });

    expect(store.resolveTarget({
      atlasId: "atlas_1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      targetId: "missing",
      allowedTypes: ["collection"],
      now: 1_500,
    })).toEqual({
      ok: false,
      reason: "target_not_found",
      message: "target missing does not exist in atlas atlas_1. Call read_page({mode:\"atlas\"}) again.",
    });
  });
});
