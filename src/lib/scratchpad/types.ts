// src/lib/scratchpad/types.ts
//
// Per-session scratchpad data model. The scratchpad is the durable
// external memory for long-horizon extraction tasks: structured records
// (append-only, optional dedupe) plus a free-form progress notes block.
// IndexedDB is the single source of truth; nothing here touches storage.

export interface Collection {
  /** Collection name, e.g. "products". */
  name: string;
  /** Optional schema hint declared on first save; informational only. */
  fields?: string[];
  /** Optional field name used to skip duplicate records on append. */
  dedupeKey?: string;
  /** Append-only record rows. */
  records: Array<Record<string, unknown>>;
}

export interface Scratchpad {
  /** Equals the owning sessionId (IDB keyPath "id"). */
  id: string;
  /** Named record tables. */
  collections: Record<string, Collection>;
  /** Free-form progress notes (whole-block overwrite). */
  notes: string;
  /** Epoch ms of last mutation. */
  updatedAt: number;
}

export function emptyScratchpad(id: string): Scratchpad {
  return { id, collections: {}, notes: "", updatedAt: 0 };
}
