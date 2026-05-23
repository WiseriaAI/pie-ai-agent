/**
 * Search provider abstraction. MVP supports Tavily only; the `id` union and
 * `SearchProvider` interface are forward-compatible for Exa / Serper / Brave.
 *
 * Storage convention: each provider's encrypted key lives at
 * chrome.storage.local["search_provider_${id}"]. No multi-instance — unlike
 * LLM providers, a user has at most ONE key per search provider.
 */

export type SearchProviderId = "tavily";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchToolResult {
  query: string;
  resultCount: number;
  results: SearchResult[];
}

export interface SearchToolError {
  error: string;
}

export interface SearchArgs {
  query: string;
  maxResults: number;
  signal?: AbortSignal;
}

export interface TestResult {
  ok: boolean;
  reason?: string;
}

export interface SearchProvider {
  id: SearchProviderId;
  search(args: SearchArgs): Promise<SearchToolResult | SearchToolError>;
  test(apiKey: string): Promise<TestResult>;
}
