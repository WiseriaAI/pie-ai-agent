// src/lib/agent/tools/scratchpad.ts
//
// Agent tools over the per-session scratchpad. Service functions are injected
// (already bound to a sessionId in loop.ts) so these handlers stay pure and
// unit-testable without touching IndexedDB.

import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import type { SaveResult } from "../../scratchpad/service";
import type { ReadResult } from "../../scratchpad/operations";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";

export interface ScratchpadToolDeps {
  saveRecords: (
    collection: string,
    records: Array<Record<string, unknown>>,
    opts: { dedupeKey?: string; fields?: string[] },
  ) => Promise<SaveResult | { error: string }>;
  updateNotes: (notes: string) => Promise<void>;
  readRecords: (
    collection: string,
    opts: { offset?: number; limit?: number; query?: string },
  ) => Promise<ReadResult | { error: string }>;
  clearScratchpad: (collection?: string) => Promise<void>;
  queryScratchpad: (args: { from: string; sql: string; into?: string }) =>
    Promise<{ rows: number; columns: string[]; preview: Array<Record<string, unknown>>; into?: string } | { error: string }>;
}

interface SaveArgs {
  collection?: string;
  records?: unknown;
  dedupeKey?: string;
  fields?: string[];
}
interface NotesArgs { notes?: unknown }
interface ReadArgs { collection?: string; offset?: number; limit?: number; query?: string }
interface ClearArgs { collection?: string }

export function buildScratchpadTools(deps: ScratchpadToolDeps): Tool[] {
  const saveRecords: Tool = {
    name: "save_scratchpad",
    description:
      `Append structured records to a named scratchpad collection. Persisted outside the chat context and survives compaction. ALWAYS use this to store intermediate results when scraping structured data from pages — never accumulate extracted rows in your reply. Pass dedupeKey on the first save to skip duplicate rows on retry/re-scrape.

USE WHEN:
- You are extracting ANY rows of structured data (products, links, table rows, search results) — store them here as you go, not in your reply.
- A long task produces data incrementally and you must not lose it to context compaction.

**DO NOT USE WHEN:**
- The value is free-text task state (pages done, next step) — use update_scratchpad_notes.
- You just want to read existing rows back — use read_scratchpad.`,
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: 'Table name, e.g. "products".' },
        records: { type: "array", description: "Array of record objects to append.", items: { type: "object" } },
        dedupeKey: { type: "string", description: "Optional field name; rows whose value was already stored are skipped." },
        fields: { type: "array", description: "Optional schema hint (field names).", items: { type: "string" } },
      },
      required: ["collection", "records"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as SaveArgs;
      if (typeof a.collection !== "string" || !a.collection.trim()) {
        return { success: false, error: "collection is required (string)" };
      }
      if (!Array.isArray(a.records)) {
        return { success: false, error: "records must be an array of objects" };
      }
      const rows = a.records.filter((r) => r && typeof r === "object") as Array<Record<string, unknown>>;
      const res = await deps.saveRecords(a.collection, rows, { dedupeKey: a.dedupeKey, fields: a.fields });
      if ("error" in res) return { success: false, error: res.error };
      return {
        success: true,
        observation: `Saved to "${a.collection}": added ${res.added}, skipped ${res.skipped} (duplicates), total ${res.total}.`,
      };
    },
  };

  const updateNotes: Tool = {
    name: "update_scratchpad_notes",
    description:
      `Overwrite the scratchpad progress notes (replaces the whole block). This is free-text task state, not data rows.

USE WHEN:
- You need to track where you are across a long task — pages done, categories left, next step.
- You want a place to keep your plan that survives context compaction.

**DO NOT USE WHEN:**
- You're storing structured rows of extracted data — use save_scratchpad.
- You expect to edit just part of the notes — there's no partial edit; always pass the full updated block.`,
    parameters: {
      type: "object",
      properties: { notes: { type: "string", description: "Full markdown notes (replaces previous notes)." } },
      required: ["notes"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as NotesArgs;
      if (typeof a.notes !== "string") return { success: false, error: "notes is required (string)" };
      await deps.updateNotes(a.notes);
      return { success: true, observation: "Progress notes updated." };
    },
  };

  const readRecordsTool: Tool = {
    name: "read_scratchpad",
    description:
      `Read stored records back from a collection (paginated; default 50). Use offset/limit to page and query for a case-insensitive substring filter.

USE WHEN:
- You need older or more detail than the scratchpad overview already shows.
- You want to page through or substring-filter previously saved rows.

**DO NOT USE WHEN:**
- The overview already shows the counts + recent rows you need — don't re-read.
- You want to dedupe/aggregate/reshape the data — use query_scratchpad (keeps it out of context).`,
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection to read." },
        offset: { type: "integer", description: "Start index (default 0).", minimum: 0 },
        limit: { type: "integer", description: "Max rows (default 50).", minimum: 1 },
        query: { type: "string", description: "Optional case-insensitive substring filter." },
      },
      required: ["collection"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as ReadArgs;
      if (typeof a.collection !== "string" || !a.collection.trim()) {
        return { success: false, error: "collection is required (string)" };
      }
      const res = await deps.readRecords(a.collection, { offset: a.offset, limit: a.limit, query: a.query });
      if ("error" in res) return { success: false, error: res.error };
      // Records are page-derived (scraped) untrusted data; wrap + escape per
      // P3-O so they cannot break out of context (see overview.ts for parity).
      const body = escapeUntrustedWrappers(JSON.stringify(res.records));
      return {
        success: true,
        observation:
          `Records ${res.offset}-${res.offset + res.records.length} of ${res.total}:\n` +
          `<untrusted_scratchpad_preview>${body}</untrusted_scratchpad_preview>`,
      };
    },
  };

  const clearScratchpadTool: Tool = {
    name: "clear_scratchpad",
    description:
      `Reset the scratchpad. Pass a collection name to clear just that table, or omit to wipe everything (all collections + notes).

USE WHEN:
- You're starting a fresh extraction target and want a clean slate.
- A collection holds stale/wrong data you want to drop before re-saving.

**DO NOT USE WHEN:**
- You only want to remove some rows — clear is all-or-nothing per collection; use query_scratchpad with a filtering SELECT into a new collection instead.
- You still need the saved data — this is irreversible.`,
    parameters: {
      type: "object",
      properties: { collection: { type: "string", description: "Optional collection to clear; omit to clear all." } },
      required: [],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as ClearArgs;
      await deps.clearScratchpad(typeof a.collection === "string" ? a.collection : undefined);
      return { success: true, observation: a.collection ? `Cleared collection "${a.collection}".` : "Cleared the whole scratchpad." };
    },
  };

  const queryScratchpadTool: Tool = {
    name: "query_scratchpad",
    description:
      `Run SQL over a scratchpad collection to clean/dedupe/aggregate/transform. Runs in a sandboxed SQLite engine; the data never re-enters your context. The collection loads as a table named after \`from\` (nested fields become JSON text). Omit \`into\` for a result summary; pass \`into\` to write the result set back as a new collection.

USE WHEN:
- You need to dedupe, filter, aggregate, sort, or reshape saved rows — especially large collections.
- You want the transform done without pulling all the data back into context.
- You'll export the cleaned result: write it with \`into\`, then export with output_file.

**DO NOT USE WHEN:**
- You just want to read a few rows as-is — use read_scratchpad.
- The data isn't in a scratchpad collection yet — save it with save_scratchpad first.`,
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source collection, loaded as a SQL table of the same name." },
        sql: { type: "string", description: "SQL to run, e.g. SELECT DISTINCT url, price FROM products WHERE price > 0." },
        into: { type: "string", description: "Optional target collection to store the result set." },
      },
      required: ["from", "sql"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as { from?: string; sql?: string; into?: string };
      if (typeof a.from !== "string" || !a.from.trim()) return { success: false, error: "from is required (string)" };
      if (typeof a.sql !== "string" || !a.sql.trim()) return { success: false, error: "sql is required (string)" };
      const res = await deps.queryScratchpad({ from: a.from, sql: a.sql, into: a.into });
      if ("error" in res) return { success: false, error: res.error };
      const previewJson = escapeUntrustedWrappers(JSON.stringify(res.preview));
      const dest = res.into ? ` written to "${res.into}"` : "";
      return {
        success: true,
        observation: `Query returned ${res.rows} row(s)${dest}. Preview: <untrusted_scratchpad_preview>${previewJson}</untrusted_scratchpad_preview>`,
      };
    },
  };

  return [saveRecords, updateNotes, readRecordsTool, clearScratchpadTool, queryScratchpadTool];
}
