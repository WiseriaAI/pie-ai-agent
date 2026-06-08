import type { ActionResult } from "../../../dom-actions/types";
import type { Tool, ToolHandlerContext } from "../../types";
import { escapeUntrustedWrappers } from "../../untrusted-wrappers";
import { pageAtlasStore, parseOrigin, type PageAtlasStore } from "./state";
import type { AtlasRecord, AtlasTarget, AtlasTargetType, PageAtlasState } from "./types";

type GetTabUrl = (tabId: number) => Promise<string | undefined>;

export interface PageAtlasTargetToolDeps {
  store?: PageAtlasStore;
  getTabUrl?: GetTabUrl;
}

type TargetMode = "summary" | "text";

interface FindTargetArgs {
  atlas_id?: unknown;
  query?: unknown;
  kind?: unknown;
}

interface TargetReadArgs {
  atlas_id?: unknown;
  target_id?: unknown;
  range?: unknown;
  mode?: unknown;
}

interface ExtractRecordsArgs {
  atlas_id?: unknown;
  target_id?: unknown;
  schema?: unknown;
  range?: unknown;
}

const READ_PAGE_FIRST = 'Call read_page({mode:"atlas"}) first, then use atlas_id and target_id from that atlas.';
const INVALID_RANGE = "invalid_range: expected range like 0..10";
const ALL_TARGET_TYPES: AtlasTargetType[] = ["collection", "table", "detail_region", "region"];

function xml(value: unknown): string {
  return escapeUntrustedWrappers(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attr(name: string, value: unknown): string {
  return `${name}="${xml(value)}"`;
}

function ok(observation: string): ActionResult {
  return { success: true, observation };
}

function fail(error: string): ActionResult {
  return { success: false, error };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeKind(value: unknown): AtlasTargetType | undefined {
  return value === "collection" || value === "table" || value === "detail_region" || value === "region"
    ? value
    : undefined;
}

function normalizeMode(value: unknown): TargetMode {
  return value === "text" ? "text" : "summary";
}

type ParsedRange =
  | { ok: true; start: number; end: number }
  | { ok: false; error: string };

function parseRange(value: unknown, recordCount: number): ParsedRange {
  if (value === undefined || value === null) return { ok: true, start: 0, end: recordCount };
  if (typeof value !== "string") return { ok: false, error: INVALID_RANGE };
  const match = value.trim().match(/^(\d+)\.\.(\d+)$/);
  if (!match) return { ok: false, error: INVALID_RANGE };

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    return { ok: false, error: INVALID_RANGE };
  }
  return {
    ok: true,
    start: Math.min(start, recordCount),
    end: Math.min(end, recordCount),
  };
}

function selectedRecords(records: AtlasRecord[] | undefined, range: unknown): { ok: true; records: AtlasRecord[] } | { ok: false; error: string } {
  const all = records ?? [];
  const rangeResult = parseRange(range, all.length);
  if (!rangeResult.ok) return rangeResult;
  return { ok: true, records: all.slice(rangeResult.start, rangeResult.end) };
}

function searchableText(target: AtlasTarget): string {
  return [
    target.label,
    target.summary,
    ...(target.fieldGuesses ?? []).map((field) => field.name),
    ...(target.columns ?? []),
  ].join(" ").toLowerCase();
}

function matchReason(target: AtlasTarget, query: string): string {
  const q = query.toLowerCase();
  if (target.label.toLowerCase().includes(q)) return `label matches ${query}`;
  if (target.summary.toLowerCase().includes(q)) return `summary matches ${query}`;
  const field = (target.fieldGuesses ?? []).find((candidate) => candidate.name.toLowerCase().includes(q));
  if (field) return `field ${field.name} matches ${query}`;
  const column = (target.columns ?? []).find((candidate) => candidate.toLowerCase().includes(q));
  if (column) return `column ${column} matches ${query}`;
  return `target metadata matches ${query}`;
}

async function defaultGetTabUrl(tabId: number): Promise<string | undefined> {
  const tab = await chrome.tabs.get(tabId);
  return tab.url;
}

async function getCurrentUrl(getTabUrl: GetTabUrl, tabId: number): Promise<string | undefined> {
  try {
    return await getTabUrl(tabId);
  } catch {
    return undefined;
  }
}

async function resolveTarget(
  store: PageAtlasStore,
  getTabUrl: GetTabUrl,
  ctx: ToolHandlerContext,
  atlasId: string,
  targetId: string,
  allowedTypes: AtlasTargetType[],
): Promise<{ ok: true; atlas: PageAtlasState; target: AtlasTarget } | { ok: false; error: string }> {
  const currentUrl = await getCurrentUrl(getTabUrl, ctx.tabId);
  if (!currentUrl) {
    return { ok: false, error: READ_PAGE_FIRST };
  }

  const result = store.resolveTarget({
    atlasId,
    targetId,
    tabId: ctx.tabId,
    currentUrl,
    allowedTypes,
    now: Date.now(),
  });

  if (!result.ok) return { ok: false, error: result.message };
  return result;
}

async function resolveAtlasForSearch(
  store: PageAtlasStore,
  getTabUrl: GetTabUrl,
  ctx: ToolHandlerContext,
  atlasId: string,
): Promise<{ ok: true; atlas: PageAtlasState } | { ok: false; error: string }> {
  const atlas = store.get(atlasId);
  if (!atlas) return { ok: false, error: READ_PAGE_FIRST };

  const firstTarget = atlas.targets[0];
  if (firstTarget) {
    const resolved = await resolveTarget(store, getTabUrl, ctx, atlasId, firstTarget.id, ALL_TARGET_TYPES);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, atlas: resolved.atlas };
  }

  const currentUrl = await getCurrentUrl(getTabUrl, ctx.tabId);
  if (!currentUrl) return { ok: false, error: READ_PAGE_FIRST };
  if (atlas.tabId !== ctx.tabId) {
    return { ok: false, error: `atlas ${atlas.atlasId} belongs to tab ${atlas.tabId}, not tab ${ctx.tabId}. ${READ_PAGE_FIRST}` };
  }

  const currentOrigin = parseOrigin(currentUrl);
  if (
    currentOrigin !== atlas.origin
    || ((currentOrigin === null || atlas.origin === null) && currentUrl !== atlas.url)
  ) {
    return {
      ok: false,
      error: 'The page origin changed since the atlas was created. Call read_page({mode:"atlas"}) again.',
    };
  }

  return { ok: true, atlas };
}

function wrapUntrustedPageContent(tool: string, atlasId: string, targetId: string, body: string): string {
  return (
    `<untrusted_page_content ${attr("atlas_id", atlasId)} ${attr("target_id", targetId)} ${attr("tool", tool)}>` +
    `${body}` +
    "</untrusted_page_content>"
  );
}

function renderRecords(tagName: string, atlasId: string, target: AtlasTarget, records: AtlasRecord[]): string {
  const lines = [
    `<${tagName} ${attr("atlas_id", atlasId)} ${attr("target_id", target.id)} ${attr("type", target.type)} ${attr("label", target.label)} ${attr("count", records.length)}>`,
  ];
  for (const record of records) {
    lines.push(`  <record ${attr("id", record.id)}>`);
    lines.push(`    <fields>${xml(JSON.stringify(record.fields))}</fields>`);
    if (record.text) lines.push(`    <text>${xml(record.text)}</text>`);
    lines.push(`    <evidence>${xml(record.evidence)}</evidence>`);
    lines.push("  </record>");
  }
  lines.push(`</${tagName}>`);
  return lines.join("\n");
}

function schemaKeys(schema: unknown): string[] | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  return Object.keys(schema as Record<string, unknown>);
}

function renderExtractedRecords(records: AtlasRecord[], keys: string[]): string {
  const extracted = records.map((record) => {
    const row: Record<string, string> = {};
    for (const key of keys) {
      row[key] = escapeUntrustedWrappers(record.fields[key] ?? "");
    }
    row._evidence = escapeUntrustedWrappers(record.evidence);
    return row;
  });
  return xml(JSON.stringify(extracted));
}

export function createPageAtlasTargetTools(deps: PageAtlasTargetToolDeps = {}): Tool[] {
  const store = deps.store ?? pageAtlasStore;
  const getTabUrl = deps.getTabUrl ?? defaultGetTabUrl;

  const findTargetTool: Tool = {
    name: "find_target",
    description:
      "Find target_id candidates inside an existing page atlas by searching only target metadata " +
      "(labels, summaries, field guesses, and table columns). Call read_page({mode:\"atlas\"}) first.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        query: { type: "string" },
        kind: { type: "string", enum: ["collection", "table", "detail_region", "region"] },
      },
      required: ["atlas_id", "query"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as FindTargetArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.query)) {
        return fail(`find_target requires atlas_id and query. ${READ_PAGE_FIRST}`);
      }

      const resolved = await resolveAtlasForSearch(store, getTabUrl, ctx, a.atlas_id);
      if (!resolved.ok) return fail(resolved.error);

      const kind = normalizeKind(a.kind);
      const query = a.query.trim();
      const candidates = resolved.atlas.targets
        .filter((target) => (!kind || target.type === kind) && searchableText(target).includes(query.toLowerCase()))
        .slice(0, 20);

      const lines = [
        `<target_candidates ${attr("atlas_id", resolved.atlas.atlasId)} ${attr("query", query)} ${attr("count", candidates.length)}>`,
      ];
      for (const target of candidates) {
        lines.push(
          `  <target_candidate ${attr("target_id", target.id)} ${attr("type", target.type)} ${attr("confidence", target.confidence)} ${attr("label", target.label)} ${attr("reason", matchReason(target, query))} />`,
        );
      }
      lines.push("</target_candidates>");
      return ok(lines.join("\n"));
    },
  };

  const readCollectionTool: Tool = {
    name: "read_collection",
    description:
      "Read records from a collection target in an existing page atlas. Requires atlas_id and target_id from read_page({mode:\"atlas\"}).",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        range: { type: "string", description: "Optional 0-based half-open range like 0..10." },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as TargetReadArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id)) {
        return fail(`read_collection requires atlas_id and target_id. ${READ_PAGE_FIRST}`);
      }
      const resolved = await resolveTarget(store, getTabUrl, ctx, a.atlas_id, a.target_id, ["collection"]);
      if (!resolved.ok) return fail(resolved.error);
      const selected = selectedRecords(resolved.target.records, a.range);
      if (!selected.ok) return fail(selected.error);
      return ok(wrapUntrustedPageContent(
        "read_collection",
        resolved.atlas.atlasId,
        resolved.target.id,
        renderRecords("collection_records", resolved.atlas.atlasId, resolved.target, selected.records),
      ));
    },
  };

  const readTableTool: Tool = {
    name: "read_table",
    description:
      "Read records from a table target in an existing page atlas. Requires atlas_id and target_id from read_page({mode:\"atlas\"}).",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        range: { type: "string", description: "Optional 0-based half-open range like 0..10." },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as TargetReadArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id)) {
        return fail(`read_table requires atlas_id and target_id. ${READ_PAGE_FIRST}`);
      }
      const resolved = await resolveTarget(store, getTabUrl, ctx, a.atlas_id, a.target_id, ["table"]);
      if (!resolved.ok) return fail(resolved.error);
      const selected = selectedRecords(resolved.target.records, a.range);
      if (!selected.ok) return fail(selected.error);
      return ok(wrapUntrustedPageContent(
        "read_table",
        resolved.atlas.atlasId,
        resolved.target.id,
        renderRecords("table_records", resolved.atlas.atlasId, resolved.target, selected.records),
      ));
    },
  };

  const readTargetTool: Tool = {
    name: "read_target",
    description:
      "Read a detail_region or region target from an existing page atlas in summary or text mode. Requires read_page({mode:\"atlas\"}) first.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        mode: { type: "string", enum: ["summary", "text"], default: "summary" },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as TargetReadArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id)) {
        return fail(`read_target requires atlas_id and target_id. ${READ_PAGE_FIRST}`);
      }
      const resolved = await resolveTarget(store, getTabUrl, ctx, a.atlas_id, a.target_id, ["detail_region", "region"]);
      if (!resolved.ok) return fail(resolved.error);
      const mode = normalizeMode(a.mode);
      if (mode === "summary") {
        return ok(wrapUntrustedPageContent(
          "read_target",
          resolved.atlas.atlasId,
          resolved.target.id,
          `<target_summary ${attr("atlas_id", resolved.atlas.atlasId)} ${attr("target_id", resolved.target.id)} ${attr("type", resolved.target.type)} ${attr("label", resolved.target.label)}>${xml(resolved.target.summary)}</target_summary>`,
        ));
      }
      const selected = selectedRecords(resolved.target.records, undefined);
      if (!selected.ok) return fail(selected.error);
      return ok(wrapUntrustedPageContent(
        "read_target",
        resolved.atlas.atlasId,
        resolved.target.id,
        renderRecords("target_text", resolved.atlas.atlasId, resolved.target, selected.records),
      ));
    },
  };

  const extractRecordsTool: Tool = {
    name: "extract_records",
    description:
      "Extract records from a collection, table, or detail_region target using only keys from the supplied schema object. Requires read_page({mode:\"atlas\"}) first.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        schema: { type: "object", additionalProperties: true },
        range: { type: "string", description: "Optional 0-based half-open range like 0..10." },
      },
      required: ["atlas_id", "target_id", "schema"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as ExtractRecordsArgs;
      const keys = schemaKeys(a.schema);
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id) || !keys) {
        return fail(`extract_records requires atlas_id, target_id, and a schema object. ${READ_PAGE_FIRST}`);
      }
      const resolved = await resolveTarget(store, getTabUrl, ctx, a.atlas_id, a.target_id, [
        "collection",
        "table",
        "detail_region",
      ]);
      if (!resolved.ok) return fail(resolved.error);
      const selected = selectedRecords(resolved.target.records, a.range);
      if (!selected.ok) return fail(selected.error);
      return ok(wrapUntrustedPageContent(
        "extract_records",
        resolved.atlas.atlasId,
        resolved.target.id,
        renderExtractedRecords(selected.records, keys),
      ));
    },
  };

  return [findTargetTool, readCollectionTool, readTableTool, readTargetTool, extractRecordsTool];
}
