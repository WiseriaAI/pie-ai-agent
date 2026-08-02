// src/lib/scratchpad/serialize.ts
//
// Pure serializers for exporting a collection straight to a file, so the LLM
// never has to transcribe rows back through its context (see output_file's
// `collection` arg). No IO.

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Column order: declared `fields` first (they're the schema hint), then any
 *  extra keys in first-seen order so late-added fields aren't silently dropped. */
export function columnsOf(
  records: Array<Record<string, unknown>>,
  fields?: string[],
): string[] {
  const cols = fields ? [...fields] : [];
  const seen = new Set(cols);
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

export function toCsv(records: Array<Record<string, unknown>>, fields?: string[]): string {
  const cols = columnsOf(records, fields);
  const lines = [cols.map((c) => quote(c)).join(",")];
  for (const r of records) lines.push(cols.map((c) => quote(cell(r[c]))).join(","));
  return lines.join("\n");
}
