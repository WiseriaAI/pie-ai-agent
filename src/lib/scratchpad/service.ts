// src/lib/scratchpad/service.ts
//
// High-level scratchpad API used by the agent tools. Each mutating call does
// a read-modify-write against IndexedDB and enforces a per-session byte
// budget BEFORE persisting (reject, don't corrupt). The agent loop is
// single-threaded per session, so read-modify-write needs no locking.

import {
  appendRecords,
  setNotes,
  clearScratchpad,
  readRecords,
  estimateBytes,
  type AppendOpts,
  type ReadOpts,
  type ReadResult,
} from "./operations";
import { buildOverview } from "./overview";
import { readScratchpad, writeScratchpad } from "./store";

/** Per-session protective quota. IndexedDB itself has no 10MB cap; this is a
 *  guard against a runaway loop ballooning one session. Backlog: user-tunable. */
export const MAX_SCRATCHPAD_BYTES = 50 * 1024 * 1024;

export interface SaveResult {
  added: number;
  skipped: number;
  total: number;
}

export async function saveRecords(
  sessionId: string,
  collection: string,
  records: Array<Record<string, unknown>>,
  opts: AppendOpts = {},
): Promise<SaveResult | { error: string }> {
  const pad = await readScratchpad(sessionId);
  const result = appendRecords(pad, collection, records, opts);
  if (estimateBytes(result.pad) > MAX_SCRATCHPAD_BYTES) {
    return {
      error: `scratchpad capacity exceeded (${MAX_SCRATCHPAD_BYTES / 1024 / 1024}MB/session). Clean up with query_scratchpad or clear_scratchpad, or export with output_file({filename, collection}) then clear.`,
    };
  }
  await writeScratchpad(result.pad);
  return { added: result.added, skipped: result.skipped, total: result.total };
}

export async function updateNotes(sessionId: string, notes: string): Promise<void> {
  const pad = await readScratchpad(sessionId);
  await writeScratchpad(setNotes(pad, notes));
}

export async function readScratchpadRecords(
  sessionId: string,
  collection: string,
  opts: ReadOpts = {},
): Promise<ReadResult | { error: string }> {
  const pad = await readScratchpad(sessionId);
  return readRecords(pad, collection, opts);
}

export async function clearScratchpadCollections(
  sessionId: string,
  collection?: string,
): Promise<void> {
  const pad = await readScratchpad(sessionId);
  await writeScratchpad(clearScratchpad(pad, collection));
}

/** Whole collection, unpaginated — for direct-to-file export (output_file's
 *  `collection` arg). Rows go straight to the serializer, never into context. */
export async function getCollection(
  sessionId: string,
  collection: string,
): Promise<{ records: Array<Record<string, unknown>>; fields?: string[] } | { error: string }> {
  const pad = await readScratchpad(sessionId);
  const col = pad.collections[collection];
  if (!col) {
    const names = Object.keys(pad.collections);
    return { error: `unknown collection "${collection}". Available: ${names.length ? names.join(", ") : "(none)"}` };
  }
  return { records: col.records, fields: col.fields };
}

export async function getOverview(sessionId: string): Promise<string> {
  const pad = await readScratchpad(sessionId);
  return buildOverview(pad);
}
