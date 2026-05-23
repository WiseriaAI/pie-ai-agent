import { describe, it, expect, vi, beforeEach } from "vitest";
import { tavilyProvider } from "./tavily";
import * as storage from "./storage";

describe("tavilyProvider.search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes Tavily response into SearchToolResult", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue("tvly-fake");
    const mockResp = {
      results: [
        {
          title: "Bubble sort - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Bubble_sort",
          content: "Bubble sort is a simple sorting algorithm...",
          published_date: "2024-03-15",
        },
        {
          title: "Algo Notes",
          url: "https://example.com/algo",
          content: "Worst-case O(n^2) when reversed.",
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResp), { status: 200 }),
    );

    const result = await tavilyProvider.search({
      query: "bubble sort worst case",
      maxResults: 5,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.query).toBe("bubble sort worst case");
    expect(result.resultCount).toBe(2);
    expect(result.results[0]).toEqual({
      title: "Bubble sort - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Bubble_sort",
      snippet: "Bubble sort is a simple sorting algorithm...",
      publishedDate: "2024-03-15",
    });
    expect(result.results[1].publishedDate).toBeUndefined();
  });

  it("returns 'not configured' error when no key", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue(null);
    const result = await tavilyProvider.search({ query: "x", maxResults: 5 });
    expect(result).toEqual({
      error:
        "Tavily API key not configured. Open Settings → Search to add your key.",
    });
  });

  it("returns rejected error on 401", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue("tvly-bad");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    const result = await tavilyProvider.search({ query: "x", maxResults: 5 });
    expect(result).toEqual({
      error: "Tavily API key rejected. Check Settings → Search.",
    });
  });

  it("returns rate-limit error on 429", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue("tvly-ok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const result = await tavilyProvider.search({ query: "x", maxResults: 5 });
    expect(result).toEqual({
      error: "Tavily rate limit hit. Try again later or upgrade your plan.",
    });
  });

  it("returns unavailable error on network failure", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue("tvly-ok");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    const result = await tavilyProvider.search({ query: "x", maxResults: 5 });
    expect(result).toEqual({ error: "Search service unavailable. Try again." });
  });

  it("propagates abort signal as aborted error", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue("tvly-ok");
    const abortErr = new DOMException("aborted", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const ac = new AbortController();
    ac.abort();
    const result = await tavilyProvider.search({
      query: "x",
      maxResults: 5,
      signal: ac.signal,
    });
    expect(result).toEqual({ error: "Search aborted." });
  });

  it("returns empty results for empty Tavily response", async () => {
    vi.spyOn(storage, "getSearchProviderKey").mockResolvedValue("tvly-ok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const result = await tavilyProvider.search({ query: "x", maxResults: 5 });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.resultCount).toBe(0);
    expect(result.results).toEqual([]);
  });
});

describe("tavilyProvider.test", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:true on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const r = await tavilyProvider.test("tvly-ok");
    expect(r).toEqual({ ok: true });
  });

  it("returns ok:false with 'Key rejected.' on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    const r = await tavilyProvider.test("tvly-bad");
    expect(r).toEqual({ ok: false, reason: "Key rejected." });
  });

  it("returns ok:false on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("net"));
    const r = await tavilyProvider.test("tvly-x");
    expect(r).toEqual({ ok: false, reason: "Could not reach Tavily." });
  });
});
