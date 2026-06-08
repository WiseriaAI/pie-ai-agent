// src/offscreen/sql-engine.ts
//
// SQLite (sql.js) compute engine. Stateless per call: build an in-memory DB,
// import one collection as a table, run the SQL, return rows, close the DB.
// IndexedDB stays the source of truth — this is a throwaway coprocessor.

import initSqlJs, { type SqlJsStatic } from "sql.js";

export interface QueryOk {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}
export type QueryResult = QueryOk | { error: string };

let sqlPromise: Promise<SqlJsStatic> | null = null;
let initImpl: () => Promise<SqlJsStatic> = () =>
  initSqlJs({ locateFile: () => chrome.runtime.getURL("sql-wasm.wasm") });

/** Test seam: override how sql.js is initialized (node wasmBinary in tests). */
export function __setSqlInitForTests(fn: () => Promise<SqlJsStatic>): void {
  initImpl = fn;
  sqlPromise = null;
}

function ensureSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) sqlPromise = initImpl().catch((e) => { sqlPromise = null; throw e; });
  return sqlPromise;
}

// Quote an identifier for safe interpolation as a table/column name.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Flatten a record value into a SQLite-storable primitive. Objects/arrays →
// JSON text; everything else → string/number/null.
function toCell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return JSON.stringify(v);
}

export async function runQuery(
  table: string,
  records: Array<Record<string, unknown>>,
  sql: string,
): Promise<QueryResult> {
  const SQL = await ensureSql();
  const db = new SQL.Database();
  try {
    // Union of keys across all records → columns.
    const cols = Array.from(
      records.reduce((set, r) => { for (const k of Object.keys(r)) set.add(k); return set; }, new Set<string>()),
    );
    if (cols.length === 0) cols.push("_empty");

    // Columns declared WITHOUT a type: SQLite's dynamic typing then preserves
    // each inserted value's affinity (INTEGER stays number, TEXT stays text)
    // so numbers round-trip as numbers rather than coercing to strings.
    const colDefs = cols.map((c) => quoteIdent(c)).join(", ");
    db.run(`CREATE TABLE ${quoteIdent(table)} (${colDefs})`);

    if (records.length > 0) {
      const placeholders = cols.map(() => "?").join(", ");
      const stmt = db.prepare(`INSERT INTO ${quoteIdent(table)} VALUES (${placeholders})`);
      for (const rec of records) {
        stmt.run(cols.map((c) => toCell(rec[c])));
      }
      stmt.free();
    }

    const res = db.exec(sql);
    if (res.length === 0) return { columns: [], rows: [] };
    const { columns, values } = res[0];
    const rows = values.map((vals) => {
      const row: Record<string, unknown> = {};
      columns.forEach((c, i) => { row[c] = vals[i]; });
      return row;
    });
    return { columns, rows };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    db.close();
  }
}
