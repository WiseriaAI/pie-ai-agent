// src/lib/extraction/serialize.ts
import type { ExtractionField, ExtractionRow, ExtractionResult } from "./types";

function escapeCSV(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function cell(v: unknown): string {
  if (v == null) return "";
  return escapeCSV(String(v));
}

export function toCSV(
  rows: ExtractionRow[],
  schema: ExtractionField[],
  opts: { includeSourceColumns: boolean },
): string {
  const cols = schema.map((s) => s.name);
  const head = [...cols.map(escapeCSV), ...(opts.includeSourceColumns ? ["_source_page", "_source_url"] : [])].join(",");
  if (!rows.length) return head;
  const body = rows
    .map((r) => {
      const base = cols.map((c) => cell(r[c]));
      const src = opts.includeSourceColumns ? [cell(r._source?.page), cell(r._source?.url)] : [];
      return [...base, ...src].join(",");
    })
    .join("\n");
  return `${head}\n${body}`;
}

// ExtractionResult is intentionally imported here for Task 4 (toContractJSON will be added to this file next).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ExtractionResultRef = ExtractionResult;
