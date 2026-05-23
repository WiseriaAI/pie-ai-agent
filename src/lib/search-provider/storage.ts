// src/lib/search-provider/storage.ts (STUB — replaced fully in Task 3)
import type { SearchProviderId } from "./types";

export async function getSearchProviderKey(_id: SearchProviderId): Promise<string | null> {
  return "test-key"; // temporary; Task 3 implements real storage
}
