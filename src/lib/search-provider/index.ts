import { tavilyProvider } from "./tavily";
import type { SearchProvider, SearchProviderId } from "./types";

export type {
  SearchArgs,
  SearchProvider,
  SearchProviderId,
  SearchResult,
  SearchToolError,
  SearchToolResult,
  TestResult,
} from "./types";

export {
  getSearchProviderKey,
  setSearchProviderKey,
  clearSearchProviderKey,
  getSearchProviderStatus,
  markVerified,
} from "./storage";

const PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  tavily: tavilyProvider,
};

export function getSearchProvider(id: SearchProviderId): SearchProvider {
  return PROVIDERS[id];
}

/** The default provider used by `search_web` tool. MVP: always Tavily. */
export const ACTIVE_SEARCH_PROVIDER: SearchProviderId = "tavily";
