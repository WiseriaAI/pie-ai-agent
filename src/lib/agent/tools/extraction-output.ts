// src/lib/agent/tools/extraction-output.ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import type { FileArtifact } from "@/lib/files/output-store";
import type { ExtractionField, ExtractionRow, ExtractionResult, ProducedBy } from "@/lib/extraction/types";
import { toCSV, toContractJSON } from "@/lib/extraction/serialize";
import { sanitizeDownloadName } from "@/lib/files/download-name";

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

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export function buildOutputExtractionTool(deps: OutputExtractionDeps): Tool {
  return {
    name: "output_extraction",
    description:
      "Serialize extracted rows into a downloadable file and present it as a card in the side panel. " +
      "Call once with format='json' (full contract: schema+rows+meta, the canonical machine output) and " +
      "once with format='csv' (flat, human/Excel). Pass the structured rows (each row's user fields plus a " +
      "_source:{page,url}); the tool stamps extractedAt and computes rowCount. The user downloads from the card.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["format", "schema", "rows"],
      properties: {
        format: { type: "string", enum: ["csv", "json"], description: "csv (flat) or json (full contract)." },
        filename: { type: "string", description: 'Base name without extension, e.g. "orders". Presented under pie/.' },
        schema: { type: "array", description: "Field defs [{name,type,description?,normalize?}]." },
        rows: { type: "array", description: "Rows; each = user fields + _source:{page,url}." },
        pageCount: { type: "number", description: "How many pages were traversed." },
        producedBy: { type: "object", description: "{skillId, skillName, version} provenance." },
        includeSourceColumns: { type: "boolean", description: "CSV only; default true." },
      },
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as OutputExtractionArgs;
      if (!Array.isArray(a.rows)) return { success: false, error: "rows is required (array)" };
      if (!Array.isArray(a.schema)) return { success: false, error: "schema is required (array)" };
      const format = a.format === "json" ? "json" : a.format === "csv" ? "csv" : null;
      if (!format) return { success: false, error: "format must be 'csv' or 'json'" };

      const ext = format === "json" ? "json" : "csv";
      const mime = format === "json" ? "application/json" : "text/csv";
      const base = typeof a.filename === "string" && a.filename.trim() ? a.filename.trim() : "extraction";
      const filename = sanitizeDownloadName(`${base}.${ext}`);

      const meta = {
        extractedAt: new Date(Date.now()).toISOString(),
        rowCount: a.rows.length,
        pageCount: typeof a.pageCount === "number" ? a.pageCount : 0,
        producedBy: a.producedBy ?? { skillId: "", skillName: "", version: 0 },
      };
      const result: ExtractionResult = { schema: a.schema, rows: a.rows, meta };
      const content =
        format === "json"
          ? toContractJSON(result)
          : toCSV(a.rows, a.schema, { includeSourceColumns: a.includeSourceColumns !== false });

      const byteLength = new Blob([content]).size;
      if (byteLength > MAX_CONTENT_BYTES) return { success: false, error: `content_too_large: max ${MAX_CONTENT_BYTES / 1024 / 1024}MB` };

      const id = crypto.randomUUID();
      await deps.store({ id, sessionId: deps.sessionId, filename, mime, content, byteLength, addedAt: Date.now() });
      return {
        success: true,
        observation: `Presented "${filename}" (${a.rows.length} rows) as a downloadable card. The user chooses whether/where to save it.`,
        fileOutput: { id, filename, mime, size: byteLength },
      };
    },
  };
}
