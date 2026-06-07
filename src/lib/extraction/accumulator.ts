// src/lib/extraction/accumulator.ts
// In-memory, per-session accumulation of extracted rows. Lets the LLM commit
// ONE page at a time via add_extraction_rows (small, reliable tool calls)
// instead of re-emitting the entire dataset in a single output_extraction call
// — which large multi-page extractions make unreliable (the model truncates or
// drops the args entirely). Lives in the SW; reset per run, cleared on SW restart.
import type { ExtractionField, ExtractionRow } from "./types";

export interface Accumulation {
  schema: ExtractionField[];
  rows: ExtractionRow[];
}

const buffers = new Map<string, Accumulation>();

/**
 * Append a page's rows to the session buffer. Pass `reset: true` on the first
 * page of a fresh extraction (clears any prior buffer); pass `schema` on the
 * first page so output_extraction can serialize without it. Returns the running
 * total row count.
 */
export function appendRows(
  sessionId: string,
  rows: ExtractionRow[],
  opts?: { reset?: boolean; schema?: ExtractionField[] },
): number {
  let acc = buffers.get(sessionId);
  if (opts?.reset || !acc) {
    acc = { schema: opts?.schema ?? [], rows: [] };
    buffers.set(sessionId, acc);
  }
  if (opts?.schema && opts.schema.length) acc.schema = opts.schema;
  acc.rows.push(...rows);
  return acc.rows.length;
}

export function getAccumulated(sessionId: string): Accumulation | undefined {
  return buffers.get(sessionId);
}

export function clearAccumulated(sessionId: string): void {
  buffers.delete(sessionId);
}
