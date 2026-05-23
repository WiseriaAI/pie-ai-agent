import { getSearchProviderKey } from "./storage";
import type {
  SearchArgs,
  SearchProvider,
  SearchToolError,
  SearchToolResult,
  TestResult,
} from "./types";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

interface TavilyResultRaw {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponseRaw {
  results?: TavilyResultRaw[];
}

export const tavilyProvider: SearchProvider = {
  id: "tavily",

  async search(args: SearchArgs): Promise<SearchToolResult | SearchToolError> {
    const apiKey = await getSearchProviderKey("tavily");
    if (!apiKey) {
      return {
        error:
          "Tavily API key not configured. Open Settings → Search to add your key.",
      };
    }

    let resp: Response;
    try {
      resp = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: args.query,
          search_depth: "basic",
          max_results: args.maxResults,
        }),
        signal: args.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return { error: "Search aborted." };
      }
      return { error: "Search service unavailable. Try again." };
    }

    if (resp.status === 401) {
      return {
        error: "Tavily API key rejected. Check Settings → Search.",
      };
    }
    if (resp.status === 429) {
      return {
        error: "Tavily rate limit hit. Try again later or upgrade your plan.",
      };
    }
    if (!resp.ok) {
      return { error: "Search service unavailable. Try again." };
    }

    let raw: TavilyResponseRaw;
    try {
      raw = (await resp.json()) as TavilyResponseRaw;
    } catch {
      return { error: "Search service returned malformed data." };
    }

    const results = (raw.results ?? [])
      .filter((r): r is Required<Pick<TavilyResultRaw, "title" | "url" | "content">> & TavilyResultRaw =>
        typeof r.title === "string" && typeof r.url === "string" && typeof r.content === "string",
      )
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        ...(r.published_date ? { publishedDate: r.published_date } : {}),
      }));

    return {
      query: args.query,
      resultCount: results.length,
      results,
    };
  },

  async test(apiKey: string): Promise<TestResult> {
    try {
      const resp = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: "test",
          search_depth: "basic",
          max_results: 1,
        }),
      });
      if (resp.status === 401) return { ok: false, reason: "Key rejected." };
      if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
      return { ok: true };
    } catch {
      return { ok: false, reason: "Could not reach Tavily." };
    }
  },
};
