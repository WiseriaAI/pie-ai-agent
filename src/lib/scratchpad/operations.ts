// src/lib/scratchpad/operations.ts
//
// Pure operations over a Scratchpad value. No IO. Every mutator returns a
// NEW Scratchpad (callers persist the result). Keeping these pure makes the
// dedupe / pagination / sizing logic trivially testable.

import type { Collection, Scratchpad } from "./types";

export interface AppendResult {
  pad: Scratchpad;
  added: number;
  skipped: number;
  total: number;
}

export interface AppendOpts {
  dedupeKey?: string;
  fields?: string[];
}

function cloneCollection(c: Collection): Collection {
  return { ...c, records: [...c.records] };
}

export function appendRecords(
  pad: Scratchpad,
  collectionName: string,
  records: Array<Record<string, unknown>>,
  opts: AppendOpts = {},
): AppendResult {
  const existing = pad.collections[collectionName];
  const col: Collection = existing
    ? cloneCollection(existing)
    : { name: collectionName, records: [] };

  // First-save declarations (do not overwrite once set).
  if (col.dedupeKey === undefined && opts.dedupeKey) col.dedupeKey = opts.dedupeKey;
  if (col.fields === undefined && opts.fields) col.fields = opts.fields;

  const dedupeKey = col.dedupeKey;
  let added = 0;
  let skipped = 0;

  // Seed the seen-set from already-stored records when deduping.
  const seen = new Set<string>();
  if (dedupeKey) {
    for (const rec of col.records) {
      const v = rec[dedupeKey];
      if (v !== undefined && v !== null) seen.add(String(v));
    }
  }

  for (const rec of records) {
    if (dedupeKey) {
      const v = rec[dedupeKey];
      const key = v === undefined || v === null ? undefined : String(v);
      if (key !== undefined && seen.has(key)) {
        skipped++;
        continue;
      }
      if (key !== undefined) seen.add(key);
    }
    col.records.push(rec);
    added++;
  }

  const nextCollections = { ...pad.collections, [collectionName]: col };
  return {
    pad: { ...pad, collections: nextCollections },
    added,
    skipped,
    total: col.records.length,
  };
}

export function setNotes(pad: Scratchpad, notes: string): Scratchpad {
  return { ...pad, notes };
}

export function clearScratchpad(pad: Scratchpad, collectionName?: string): Scratchpad {
  if (collectionName === undefined) {
    return { ...pad, collections: {}, notes: "" };
  }
  const next = { ...pad.collections };
  delete next[collectionName];
  return { ...pad, collections: next };
}

export interface ReadResult {
  records: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
}

export interface ReadOpts {
  offset?: number;
  limit?: number;
  query?: string;
}

const DEFAULT_READ_LIMIT = 50;

export function readRecords(
  pad: Scratchpad,
  collectionName: string,
  opts: ReadOpts = {},
): ReadResult | { error: string } {
  const col = pad.collections[collectionName];
  if (!col) {
    const names = Object.keys(pad.collections);
    const avail = names.length ? names.join(", ") : "(none)";
    return { error: `unknown collection "${collectionName}". Available: ${avail}` };
  }
  let rows = col.records;
  if (opts.query) {
    const q = opts.query.toLowerCase();
    rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
  }
  const total = rows.length;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? DEFAULT_READ_LIMIT);
  return { records: rows.slice(offset, offset + limit), total, offset, limit };
}

/** Rough at-rest byte estimate via JSON length (UTF-16 chars ≈ enough for a
 *  protective quota check; not an exact storage figure). */
export function estimateBytes(pad: Scratchpad): number {
  return JSON.stringify(pad).length;
}
