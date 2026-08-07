import type { ActionResult } from "../../../dom-actions/types";
import { probePageInjected, type ProbeResult } from "../../../dom-actions/probe-core";
import type { Tool, ToolHandlerContext } from "../../types";
import { escapeUntrustedWrappers } from "../../untrusted-wrappers";
import { pageAtlasStore, type PageAtlasStore } from "./state";
import type { AtlasFingerprint, AtlasRecord, AtlasTarget, AtlasTargetType, PageAtlasState } from "./types";

type GetTabUrl = (tabId: number) => Promise<string | undefined>;
export type GetPageState = (tabId: number) => Promise<{ url?: string; fingerprint?: AtlasFingerprint }>;

export interface PageAtlasTargetToolDeps {
  store?: PageAtlasStore;
  getTabUrl?: GetTabUrl;
  getPageState?: GetPageState;
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

interface ReadStructArgs {
  atlas_id?: unknown;
  target_id?: unknown;
  range?: unknown;
  fields?: unknown;
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

/**
 * 元素内容位置的文本转义 = `xml()` 减去引号那一项。
 *
 * 标签边界字符(`<` `>` `&`)照转,所以逃逸防护与 `xml()` 完全等价;但刻意 **不**
 * 转义 `"`:record 的 fields 是 JSON,引号是里面最多的字符,`&quot;` 一个顶六个,
 * 实测单字段投影因此从 1066 chars 膨胀到 2066(1.94x)。引号只在属性值位置才
 * 必须转义,那里继续走 attr()/xml()。
 */
function contentText(value: string): string {
  return escapeUntrustedWrappers(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** record 内容:紧凑 JSON,不做属性级转义。 */
function jsonContent(value: unknown): string {
  return contentText(JSON.stringify(value));
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

/**
 * 不传 range 时的默认条数上限。长列表默认全量返回会让一次 read_struct 就把
 * 上下文吃掉一大块;上限 + omitted 提示让 LLM 自己决定要不要翻页。显式传
 * range 时不受这个上限约束——那是它明确要的量。
 */
const DEFAULT_RECORD_LIMIT = 50;

function selectedRecords(
  records: AtlasRecord[] | undefined,
  range: unknown,
): { ok: true; records: AtlasRecord[]; omitted: number } | { ok: false; error: string } {
  const all = records ?? [];
  const rangeResult = parseRange(range, all.length);
  if (!rangeResult.ok) return rangeResult;
  const selected = all.slice(rangeResult.start, rangeResult.end);
  if (range === undefined || range === null) {
    return {
      ok: true,
      records: selected.slice(0, DEFAULT_RECORD_LIMIT),
      omitted: Math.max(0, selected.length - DEFAULT_RECORD_LIMIT),
    };
  }
  return { ok: true, records: selected, omitted: 0 };
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

async function defaultGetPageState(tabId: number): Promise<{ url?: string; fingerprint?: AtlasFingerprint }> {
  const tab = await chrome.tabs.get(tabId);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: probePageInjected,
      args: [{ op: "atlas" }],
      injectImmediately: true,
    }) as chrome.scripting.InjectionResult<ProbeResult>[];
    const result = results[0]?.result;
    if (result?.op === "atlas") {
      return { url: tab.url, fingerprint: result.fingerprint };
    }
  } catch {
    // Without a fresh page fingerprint, old atlas target ids are not safe to reuse.
  }
  return {};
}

export function pageStateGetter(deps: PageAtlasTargetToolDeps): GetPageState {
  if (deps.getPageState) return deps.getPageState;
  if (deps.getTabUrl) {
    return async (tabId) => ({ url: await deps.getTabUrl!(tabId) });
  }
  return defaultGetPageState;
}

async function getCurrentPageState(getPageState: GetPageState, tabId: number): Promise<{ url?: string; fingerprint?: AtlasFingerprint }> {
  try {
    return await getPageState(tabId);
  } catch {
    return {};
  }
}

export async function resolveTarget(
  store: PageAtlasStore,
  getPageState: GetPageState,
  ctx: ToolHandlerContext,
  atlasId: string,
  targetId: string,
  allowedTypes: AtlasTargetType[],
): Promise<{ ok: true; atlas: PageAtlasState; target: AtlasTarget } | { ok: false; error: string }> {
  const { url: currentUrl, fingerprint: currentFingerprint } = await getCurrentPageState(getPageState, ctx.tabId);
  if (!currentUrl) {
    return { ok: false, error: READ_PAGE_FIRST };
  }

  const result = store.resolveTarget({
    atlasId,
    targetId,
    tabId: ctx.tabId,
    currentUrl,
    currentFingerprint,
    allowedTypes,
    now: Date.now(),
  });

  if (!result.ok) return { ok: false, error: result.message };
  return result;
}

async function resolveAtlasForSearch(
  store: PageAtlasStore,
  getPageState: GetPageState,
  ctx: ToolHandlerContext,
  atlasId: string,
): Promise<{ ok: true; atlas: PageAtlasState } | { ok: false; error: string }> {
  const atlas = store.get(atlasId);
  if (!atlas) return { ok: false, error: READ_PAGE_FIRST };

  const firstTarget = atlas.targets[0];
  if (firstTarget) {
    const resolved = await resolveTarget(store, getPageState, ctx, atlasId, firstTarget.id, ALL_TARGET_TYPES);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, atlas: resolved.atlas };
  }

  const { url: currentUrl, fingerprint: currentFingerprint } = await getCurrentPageState(getPageState, ctx.tabId);
  if (!currentUrl) return { ok: false, error: READ_PAGE_FIRST };
  const result = store.resolveTarget({
    atlasId,
    targetId: "__atlas_freshness_probe__",
    tabId: ctx.tabId,
    currentUrl,
    currentFingerprint,
    allowedTypes: ALL_TARGET_TYPES,
    now: Date.now(),
  });
  if (!result.ok && result.reason !== "target_not_found") {
    return { ok: false, error: result.message };
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

const normalizeSpace = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * 一条 record 的内容:fields JSON,必要时并入 `_text`。
 *
 * `text` 是否重复取决于 target 类型,不能一刀切:
 *   - table —— probe 侧 `text` 就是各 cell 值的 join,fields 已完整覆盖,纯重复;
 *   - collection / region —— fields 只有 title/link,`text` 是整张卡片或整段
 *     正文(价格、状态、描述都在里面),丢了就是真实信息损失。
 * 所以按「是否等于 fields 值的拼接」判断,而不是按「有没有 fields」。
 */
function recordPayload(record: AtlasRecord): string {
  const payload: Record<string, string> = { ...record.fields };
  const text = record.text ?? "";
  if (text && normalizeSpace(text) !== normalizeSpace(Object.values(record.fields).join(" "))) {
    payload._text = text;
  }
  return jsonContent(payload);
}

/**
 * 一条 record 一行。此前是 4 行:`<record>` 包 `<fields>` + `<text>` +
 * `<evidence>`,其中 `text` 在 table 上是 fields 的完整重复,`evidence` 只是个
 * 标签名却占一整行。合成测量(25 行 x 8 字段)显示旧形态 13507 chars,新形态约
 * 4815,缩小 2.81x。
 */
function renderRecords(
  tagName: string,
  atlasId: string,
  target: AtlasTarget,
  records: AtlasRecord[],
  omitted = 0,
): string {
  const header = [
    `<${tagName}`,
    attr("atlas_id", atlasId),
    attr("target_id", target.id),
    attr("type", target.type),
    attr("label", target.label),
    attr("count", records.length),
  ];
  if (omitted > 0) {
    header.push(attr("omitted", omitted));
    header.push(attr("hint", `Pass range=${records.length}..${records.length + omitted} to read the rest.`));
  }
  const lines = [`${header.join(" ")}>`];
  for (const record of records) {
    lines.push(
      `  <record ${attr("id", record.id)} ${attr("evidence", record.evidence)}>${recordPayload(record)}</record>`,
    );
  }
  lines.push(`</${tagName}>`);
  return lines.join("\n");
}

/**
 * 字段投影:JSON Lines,一行一条。此前是把整个数组 JSON.stringify 后再走
 * `xml()`——双重编码,单字段投影从 1066 chars 膨胀到 2066。行式还有个好处:
 * 截断不会产生半个数组。
 */
function renderExtractedRecords(records: AtlasRecord[], keys: string[]): string {
  return records
    .map((record) => {
      const row: Record<string, string> = {};
      for (const key of keys) row[key] = record.fields[key] ?? "";
      row._evidence = record.evidence;
      return jsonContent(row);
    })
    .join("\n");
}

export function createPageAtlasTargetTools(deps: PageAtlasTargetToolDeps = {}): Tool[] {
  const store = deps.store ?? pageAtlasStore;
  const getPageState = pageStateGetter(deps);

  const findTargetTool: Tool = {
    name: "find_target",
    description:
      `Narrow a large page atlas down to the right target_id by searching only target metadata (labels, summaries, field guesses, table columns). Requires read_page({mode:"atlas"}) first.

USE WHEN:
- The atlas has many targets and you need to locate the one holding your data.
- You can name what you want by keyword but don't yet know its target_id.

**DO NOT USE WHEN:**
- The atlas already makes the target obvious — read it directly instead.
- You want the records themselves, not a target_id — use read_struct or read_target.`,
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

      const resolved = await resolveAtlasForSearch(store, getPageState, ctx, a.atlas_id);
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
      return ok(wrapUntrustedPageContent(
        "find_target",
        resolved.atlas.atlasId,
        "target_candidates",
        lines.join("\n"),
      ));
    },
  };

  const readTargetTool: Tool = {
    name: "read_target",
    description:
      `Read a detail_region (one structured block, e.g. a single product or profile) or region (a free-text section) target. mode="summary" (default) returns a short overview; mode="text" returns the full extracted text. Requires read_page({mode:"atlas"}) first.

USE WHEN:
- The target's type is "detail_region" or "region".
- You need an overview of the block — use mode="summary".
- You need the block's full body text — use mode="text".

**DO NOT USE WHEN:**
- The target is a repeated item list or a table — use read_struct.
- You need specific fields across many records — use read_struct with the fields parameter.`,
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
      const resolved = await resolveTarget(store, getPageState, ctx, a.atlas_id, a.target_id, ["detail_region", "region"]);
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
        renderRecords("target_text", resolved.atlas.atlasId, resolved.target, selected.records, selected.omitted),
      ));
    },
  };

  const readStructTool: Tool = {
    name: "read_struct",
    description:
      `Read records from a collection, table, or detail_region target, rendered by the target's actual type — so you don't pre-classify collection vs table. Each record is one line of compact JSON (a "_text" key carries the item's full text when it isn't just the fields joined). Without "range" it returns at most 50 records and reports how many were omitted — pass "range" to page through the rest, or "fields" to project down to named fields (cheaper for large lists). Requires atlas_id + target_id from read_page({mode:"atlas"}).

USE WHEN:
- The target's type is "collection", "table", or "detail_region" and you need its records.
- You want all fields per item (omit "fields"), or only specific fields (pass "fields").

**DO NOT USE WHEN:**
- You want a block overview or a plain free-text region — use read_target.
- You are bulk-collecting rows into the scratchpad — use extract_records (full fidelity, no context cost).`,
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        range: { type: "string", description: "Optional 0-based half-open range like 0..10." },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional field names to keep; omit to return full records.",
        },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as ReadStructArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id)) {
        return fail(`read_struct requires atlas_id and target_id. ${READ_PAGE_FIRST}`);
      }
      const resolved = await resolveTarget(store, getPageState, ctx, a.atlas_id, a.target_id, [
        "collection",
        "table",
        "detail_region",
      ]);
      if (!resolved.ok) return fail(resolved.error);
      const selected = selectedRecords(resolved.target.records, a.range);
      if (!selected.ok) return fail(selected.error);
      const fields = Array.isArray(a.fields) ? a.fields.filter(isNonEmptyString) : [];
      const body =
        fields.length > 0
          ? renderExtractedRecords(selected.records, fields)
          : renderRecords("records", resolved.atlas.atlasId, resolved.target, selected.records, selected.omitted);
      return ok(wrapUntrustedPageContent("read_struct", resolved.atlas.atlasId, resolved.target.id, body));
    },
  };

  return [findTargetTool, readStructTool, readTargetTool];
}
