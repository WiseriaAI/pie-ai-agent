// src/lib/scratchpad/sql-bridge.ts
//
// SW-side bridge for query_scratchpad: read the source collection from IDB,
// hand it to the offscreen SQLite engine, optionally write the result set
// back as a new collection. IndexedDB remains the source of truth.

import { sendToOffscreen } from "../../background/offscreen-manager";
import { readScratchpad, writeScratchpad } from "./store";
import { appendRecords, estimateBytes } from "./operations";
import { MAX_SCRATCHPAD_BYTES } from "./service";

interface SqlRunResult { columns: string[]; rows: Array<Record<string, unknown>> }

// Test seam — override the offscreen sender so unit tests don't need chrome.offscreen.
let sender: ((req: { type: "sql:run"; table: string; records: Array<Record<string, unknown>>; sql: string }) => Promise<SqlRunResult>) | null = null;
export function __setOffscreenSenderForTests(
  fn: ((req: { type: "sql:run"; table: string; records: Array<Record<string, unknown>>; sql: string }) => Promise<SqlRunResult>) | null,
): void {
  sender = fn;
}

export interface QueryArgs { from: string; sql: string; into?: string }
export interface QuerySummary {
  rows: number;
  columns: string[];
  preview: Array<Record<string, unknown>>;
  into?: string;
}

const PREVIEW_ROWS = 5;

export async function queryScratchpad(
  sessionId: string,
  args: QueryArgs,
): Promise<QuerySummary | { error: string }> {
  const pad = await readScratchpad(sessionId);
  const col = pad.collections[args.from];
  if (!col) {
    const names = Object.keys(pad.collections);
    return { error: `unknown collection "${args.from}". Available: ${names.length ? names.join(", ") : "(none)"}` };
  }

  let result: SqlRunResult;
  try {
    const send = sender ?? ((req) => sendToOffscreen<SqlRunResult>(req));
    result = await send({ type: "sql:run", table: args.from, records: col.records, sql: args.sql });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  if (args.into) {
    // Replace the target collection with the result set.
    const cleared = { ...pad, collections: { ...pad.collections } };
    delete cleared.collections[args.into];
    const next = appendRecords(cleared, args.into, result.rows, {});
    // Re-check the per-session budget BEFORE persisting: SQL can amplify rows
    // (e.g. a self cross-join turns N rows into N²), so `into` write-back is a
    // path that could otherwise blow past the cap that service.saveRecords
    // enforces. Reject without persisting (S4 capacity invariant).
    if (estimateBytes(next.pad) > MAX_SCRATCHPAD_BYTES) {
      return {
        error: `scratchpad capacity exceeded (${MAX_SCRATCHPAD_BYTES / 1024 / 1024}MB/session) — query result too large to store into "${args.into}".`,
      };
    }
    await writeScratchpad(next.pad);
    return { rows: result.rows.length, columns: result.columns, preview: result.rows.slice(0, PREVIEW_ROWS), into: args.into };
  }

  return { rows: result.rows.length, columns: result.columns, preview: result.rows.slice(0, PREVIEW_ROWS) };
}
