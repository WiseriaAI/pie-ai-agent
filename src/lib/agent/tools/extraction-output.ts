// src/lib/agent/tools/extraction-output.ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import type { FileArtifact } from "@/lib/files/output-store";
import type { ExtractionField, ExtractionRow, ExtractionResult, ProducedBy } from "@/lib/extraction/types";
import { toCSV, toContractJSON } from "@/lib/extraction/serialize";
import { appendRows, getAccumulated } from "@/lib/extraction/accumulator";
import { sanitizeDownloadName } from "@/lib/files/download-name";

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

// ── add_extraction_rows — commit ONE page's rows to the session buffer ───────
// The LLM calls this once per page while paginating. Each call carries only that
// page's rows (small + reliable), so output_extraction never needs the whole
// dataset passed inline (which large extractions make the model drop/truncate).

interface AddRowsArgs {
  rows?: ExtractionRow[];
  schema?: ExtractionField[];
  reset?: boolean;
}

export interface AddExtractionRowsDeps {
  sessionId: string;
}

export function buildAddExtractionRowsTool(deps: AddExtractionRowsDeps): Tool {
  return {
    name: "add_extraction_rows",
    description:
      "Commit ONE page's extracted rows to the current extraction buffer. Call this once per page as you " +
      "paginate — each call carries only that page's rows (small and reliable). On the FIRST page pass " +
      "reset:true AND the schema. After the last page, call output_extraction (it serializes the buffer; you " +
      "do NOT pass rows there). Never try to hold all rows yourself to pass them in one big output_extraction call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["rows"],
      properties: {
        rows: { type: "array", description: "THIS page's rows only; each = user fields + _source:{page,url}." },
        schema: { type: "array", description: "Field defs [{name,type,description?,normalize?}]. Pass on the first page." },
        reset: { type: "boolean", description: "Pass true on the first page to start a fresh extraction (clears any prior buffer)." },
      },
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as AddRowsArgs;
      if (!Array.isArray(a.rows)) return { success: false, error: "rows is required (array of THIS page's rows)" };
      const total = appendRows(deps.sessionId, a.rows, { reset: a.reset === true, schema: a.schema });
      return {
        success: true,
        observation: `Buffered ${a.rows.length} row(s); ${total} total so far. When done paginating, call output_extraction (format "json", then "csv").`,
      };
    },
  };
}

// ── output_extraction — serialize the buffer (or inline rows) → download card ─

interface OutputExtractionArgs {
  format?: "csv" | "json";
  filename?: string;
  schema?: ExtractionField[];
  rows?: ExtractionRow[];
  pageCount?: number;
  producedBy?: ProducedBy;
  includeSourceColumns?: boolean;
}

export interface OutputExtractionDeps {
  sessionId: string;
  store: (a: FileArtifact) => void | Promise<void>;
}

export function buildOutputExtractionTool(deps: OutputExtractionDeps): Tool {
  return {
    name: "output_extraction",
    description:
      "Serialize the extraction buffer into a downloadable file and present it as a card in the side panel. " +
      "First commit each page's rows with add_extraction_rows; then call this ONCE with format='json' (full " +
      "contract: schema+rows+meta) and ONCE with format='csv' (flat, human/Excel). You do NOT pass rows here — " +
      "it reads the buffer accumulated by add_extraction_rows. (For a tiny one-shot you MAY pass rows+schema " +
      "inline instead.) The tool stamps extractedAt and computes rowCount.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["format"],
      properties: {
        format: { type: "string", enum: ["csv", "json"], description: "csv (flat) or json (full contract)." },
        filename: { type: "string", description: 'Base name without extension, e.g. "orders". Presented under pie/.' },
        schema: { type: "array", description: "Optional: inline field defs (one-shot). Normally taken from the buffer." },
        rows: { type: "array", description: "Optional: inline rows (tiny one-shot). Normally taken from the buffer." },
        pageCount: { type: "number", description: "How many pages were traversed." },
        producedBy: { type: "object", description: "{skillId, skillName, version} provenance." },
        includeSourceColumns: { type: "boolean", description: "CSV only; default true." },
      },
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as OutputExtractionArgs;
      const format = a.format === "json" ? "json" : a.format === "csv" ? "csv" : null;
      if (!format) return { success: false, error: "format is required: 'csv' or 'json'" };

      // Resolve rows + schema: inline if provided (one-shot), else the buffer.
      const acc = getAccumulated(deps.sessionId);
      const rows = Array.isArray(a.rows) && a.rows.length ? a.rows : acc?.rows ?? [];
      const schema = Array.isArray(a.schema) && a.schema.length ? a.schema : acc?.schema ?? [];
      if (!rows.length) {
        return { success: false, error: "no rows to output. Commit each page's rows with add_extraction_rows first (or pass rows inline for a one-shot)." };
      }
      if (!schema.length) {
        return { success: false, error: "no schema. Pass schema to add_extraction_rows on the first page (or inline here)." };
      }

      const ext = format === "json" ? "json" : "csv";
      const mime = format === "json" ? "application/json" : "text/csv";
      const base = typeof a.filename === "string" && a.filename.trim() ? a.filename.trim() : "extraction";
      const filename = sanitizeDownloadName(`${base}.${ext}`);

      const meta = {
        extractedAt: new Date(Date.now()).toISOString(),
        rowCount: rows.length,
        pageCount: typeof a.pageCount === "number" ? a.pageCount : 0,
        producedBy: a.producedBy ?? { skillId: "", skillName: "", version: 0 },
      };
      const result: ExtractionResult = { schema, rows, meta };
      const content =
        format === "json"
          ? toContractJSON(result)
          : toCSV(rows, schema, { includeSourceColumns: a.includeSourceColumns !== false });

      const byteLength = new Blob([content]).size;
      if (byteLength > MAX_CONTENT_BYTES) return { success: false, error: `content_too_large: max ${MAX_CONTENT_BYTES / 1024 / 1024}MB` };

      const id = crypto.randomUUID();
      await deps.store({ id, sessionId: deps.sessionId, filename, mime, content, byteLength, addedAt: Date.now() });
      return {
        success: true,
        observation: `Presented "${filename}" (${rows.length} rows) as a downloadable card. The user chooses whether/where to save it.`,
        fileOutput: { id, filename, mime, size: byteLength },
      };
    },
  };
}
