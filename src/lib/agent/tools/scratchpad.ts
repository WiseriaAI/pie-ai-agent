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
    name: "save_records",
    description:
      "Append structured records to a named scratchpad collection (persisted outside the chat context, survives compaction). Use this WHILE extracting — don't accumulate data in your reply. Pass dedupeKey on first save to skip duplicate rows on retry/re-scrape.",
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
    name: "update_notes",
    description:
      "Overwrite the scratchpad progress notes (whole block). Track task state here — pages done, categories left, next step — so you never lose your place across long tasks.",
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
    name: "read_records",
    description:
      "Read back stored records from a collection (paginated; default 50). Use offset/limit to page and query for a substring filter. The overview already shows counts + recent rows, so only read when you need older detail.",
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
      "Reset the scratchpad. Pass a collection name to clear just that table, or omit to clear everything (all collections + notes). Use when starting a fresh extraction target.",
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

  return [saveRecords, updateNotes, readRecordsTool, clearScratchpadTool];
}
