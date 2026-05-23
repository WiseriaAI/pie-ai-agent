import {
  ACTIVE_SEARCH_PROVIDER,
  getSearchProvider,
  type SearchResult,
} from "@/lib/search-provider";
import type { Tool, ToolHandlerContext } from "../types";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import type { ActionResult } from "@/lib/dom-actions/types";

interface SearchArgsParsed {
  query: string;
  max_results?: number;
}

const DEFAULT_MAX = 5;
const MIN_MAX = 1;
const MAX_MAX = 10;

function clampMaxResults(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX;
  return Math.min(MAX_MAX, Math.max(MIN_MAX, Math.floor(v)));
}

function topDomains(results: SearchResult[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, "");
      if (!seen.has(host)) {
        seen.add(host);
        out.push(host);
      }
    } catch {
      // skip invalid URL
    }
    if (out.length >= 3) break;
  }
  return out;
}

function buildObservation(query: string, results: SearchResult[]): string {
  const safeQueryDisplay = escapeUntrustedWrappers(query);
  const summary =
    results.length === 0
      ? `0 results for "${safeQueryDisplay}".`
      : `${results.length} results · top: ${topDomains(results).join(" · ")}`;

  const rows = results
    .map((r, i) => {
      const date = r.publishedDate ? ` (${r.publishedDate})` : "";
      return `[${i + 1}] ${r.title}${date}\n    ${r.url}\n    ${r.snippet}`;
    })
    .join("\n\n");

  const safeQuery = escapeWrapperAttribute(query);
  return [
    summary,
    "",
    `<untrusted_search_result query="${safeQuery}" total="${results.length}">`,
    rows,
    `</untrusted_search_result>`,
  ].join("\n");
}

export const searchWebTool: Tool = {
  name: "search_web",
  description:
    "Search the web for current information using Tavily, a search engine " +
    "optimized for AI agents. Returns ranked results with title, URL, and " +
    "snippet. Use to answer knowledge questions the current tabs cannot, or " +
    "to find authoritative sources to drill into via open_url.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search query in natural language. Tavily is tuned for LLM " +
          "agents — phrase as a question or topic ('latest developments in " +
          "X'), not as raw keywords.",
      },
      max_results: {
        type: "integer",
        description:
          "Number of results (1–10). Default 5. Use 3 for quick fact-" +
          "checks, 8–10 for broad surveys.",
        default: DEFAULT_MAX,
        minimum: MIN_MAX,
        maximum: MAX_MAX,
      },
    },
    required: ["query"],
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as SearchArgsParsed;
    const query = typeof a.query === "string" ? a.query.trim() : "";
    if (!query) {
      return {
        success: false,
        observation: "search_web: query is required.",
        error: "missingQuery",
      };
    }
    const maxResults = clampMaxResults(a.max_results);

    const provider = getSearchProvider(ACTIVE_SEARCH_PROVIDER);
    const result = await provider.search({ query, maxResults });

    if ("error" in result) {
      return {
        success: false,
        observation: result.error,
        error: result.error,
      };
    }

    return {
      success: true,
      observation: buildObservation(result.query, result.results),
    };
  },
};
