// src/lib/agent/tools/page-atlas/extract-tool.ts
//
// extract_records — bulk full-fidelity extraction of a collection/table atlas
// target straight into a scratchpad collection. The rows never pass through the
// LLM context: the SW pulls them via the probe-core `extract` op (structural
// signature relocation, batched by row cursor), injects a content hash for
// dedupe when no dedupeKey is given, and writes them with saveRecords. The LLM
// only gets counts + per-field coverage + a 2-row sample. scroll:true drives an
// internal scroll-extract-accumulate loop for infinite / virtualized lists.

import type { ActionResult } from "../../../dom-actions/types";
import {
  probePageInjected,
  type ProbeParams,
  type ProbeResult,
  type ExtractRow,
  type AtlasExtractSignature,
} from "../../../dom-actions/probe-core";
import { scroll } from "../../../dom-actions/scroll";
import type { Tool, ToolHandlerContext } from "../../types";
import { escapeUntrustedWrappers } from "../../untrusted-wrappers";
import { pageAtlasStore, type PageAtlasStore } from "./state";
import { resolveTarget, pageStateGetter, type GetPageState } from "./target-tools";

const BATCH_SIZE = 500;
const MAX_FIELD_CHARS = 2048;
const DEFAULT_MAX_ROWS = 2000;
const MAX_BATCH_PULLS = 100; // per-pass batch-pull guard

// Scroll-loop bounds (spec §7 / §12).
const STALL_LIMIT = 3;
const MAX_SCROLL_STEPS = 200;
const MAX_DURATION_MS = 120_000;
const SETTLE_MS = 600;

const READ_PAGE_FIRST = 'Call read_page({mode:"atlas"}) first, then use atlas_id and target_id from that atlas.';
const TARGET_STALE = 'target_stale: the page structure changed — re-run read_page({mode:"atlas"}).';

type ExtractProbeResult = Extract<ProbeResult, { op: "extract" }>;

export interface ExtractRecordsDeps {
  saveRecords: (
    collection: string,
    records: Array<Record<string, unknown>>,
    opts: { dedupeKey?: string; fields?: string[] },
  ) => Promise<{ added: number; skipped: number; total: number } | { error: string }>;
  store?: PageAtlasStore;
  getPageState?: GetPageState;
  exec?: (tabId: number, frameId: number, params: ProbeParams) => Promise<ProbeResult | undefined>;
  scrollPage?: (tabId: number, frameId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
}

interface ExtractArgs {
  atlas_id?: unknown;
  target_id?: unknown;
  collection?: unknown;
  dedupeKey?: unknown;
  scroll?: unknown;
  max_rows?: unknown;
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

// djb2 content hash — stable, cheap, collision-tolerant identity for full-row
// dedupe when the caller gives no dedupeKey.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const defaultExec = async (
  tabId: number,
  frameId: number,
  params: ProbeParams,
): Promise<ProbeResult | undefined> => {
  const results = (await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: probePageInjected,
    args: [params],
  })) as chrome.scripting.InjectionResult<ProbeResult>[];
  return results[0]?.result;
};

const defaultScrollPage = async (tabId: number, frameId: number): Promise<void> => {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: scroll,
    args: ["down"],
  });
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Pull every currently-visible row for a signature (all cursor batches).
async function extractVisible(
  exec: NonNullable<ExtractRecordsDeps["exec"]>,
  tabId: number,
  frameId: number,
  signature: AtlasExtractSignature,
): Promise<{ ok: true; rows: ExtractRow[]; slots: string[] } | { ok: false }> {
  const rows: ExtractRow[] = [];
  const slots = new Set<string>();
  let cursor = 0;
  for (let pull = 0; pull < MAX_BATCH_PULLS; pull++) {
    const r = await exec(tabId, frameId, {
      op: "extract",
      signature,
      cursor,
      batchSize: BATCH_SIZE,
      maxFieldChars: MAX_FIELD_CHARS,
    });
    if (!r || r.op !== "extract" || !r.found) return { ok: false };
    rows.push(...r.rows);
    r.slots.forEach((s) => slots.add(s));
    if (r.done) break;
    cursor = r.nextCursor;
  }
  return { ok: true, rows, slots: Array.from(slots) };
}

export function createExtractRecordsTool(deps: ExtractRecordsDeps): Tool {
  const store = deps.store ?? pageAtlasStore;
  const getPageState = deps.getPageState ?? pageStateGetter({});
  const exec = deps.exec ?? defaultExec;
  const scrollPage = deps.scrollPage ?? defaultScrollPage;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const signal = deps.signal;

  return {
    name: "extract_records",
    description:
      `Bulk-extract every record of a collection/table target straight into a scratchpad collection — full fidelity, without the data passing through your context. Returns counts + field coverage + a sample (first + last rows) for verification.

USE WHEN:
- You are collecting many rows (products, listings, table rows) from a repeated structure the atlas already identified.
- The list loads more items as you scroll (infinite/virtualized, no pagination links) — pass scroll:true and ONE call drives the whole scroll-extract loop. Never scroll manually and re-extract per screen.
- The list is paginated (next-page links) — extract each page into the SAME collection; duplicates are skipped.

**DO NOT USE WHEN:**
- You need a handful of rows to reason about in context — use read_struct.
- No suitable atlas target exists (page too unstructured) — read the page and save rows manually with save_scratchpad.`,
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string", description: 'A collection or table target from read_page({mode:"atlas"}).' },
        collection: { type: "string", description: 'Scratchpad collection to write into, e.g. "products".' },
        dedupeKey: { type: "string", description: 'Field that identifies a row (e.g. "link"). Omit to auto-dedupe by full-row content hash.' },
        scroll: { type: "boolean", description: "Auto-scroll and keep extracting until no new items (infinite lists). Default false." },
        max_rows: { type: "integer", minimum: 1, description: "Stop after this many stored rows. Default 2000." },
      },
      required: ["atlas_id", "target_id", "collection"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as ExtractArgs;
      if (!isNonEmptyString(a.atlas_id) || !isNonEmptyString(a.target_id) || !isNonEmptyString(a.collection)) {
        return fail(`extract_records requires atlas_id, target_id and collection. ${READ_PAGE_FIRST}`);
      }
      const collection = a.collection.trim();
      const userDedupeKey = isNonEmptyString(a.dedupeKey) ? a.dedupeKey.trim() : undefined;
      const injectHash = userDedupeKey === undefined;
      const dedupeKey = userDedupeKey ?? "_hash";
      const maxRows =
        typeof a.max_rows === "number" && Number.isFinite(a.max_rows) && a.max_rows >= 1
          ? Math.floor(a.max_rows)
          : DEFAULT_MAX_ROWS;
      const doScroll = a.scroll === true;

      const resolved = await resolveTarget(store, getPageState, ctx, a.atlas_id, a.target_id, ["collection", "table"]);
      if (!resolved.ok) return fail(resolved.error);
      const target = resolved.target;
      const signature = target.signature;
      if (!signature) {
        return fail(`This target cannot be bulk-extracted (no structure signature). ${READ_PAGE_FIRST}`);
      }
      const frameId = target.frameId;

      // Coverage + sample accumulators (span all passes).
      const slotOrder: string[] = [];
      const slotSeen = new Set<string>();
      const coverage = new Map<string, number>();
      let rowsSeen = 0;
      // Head + rolling tail: the first rows of a list are usually its most
      // regular; noise (promoted cards, sentinels) tends to live at the end.
      const sampleHead: ExtractRow[] = [];
      const sampleTail: Array<{ idx: number; row: ExtractRow }> = [];

      const account = (rows: ExtractRow[]): void => {
        for (const row of rows) {
          const idx = rowsSeen++;
          for (const [k, v] of Object.entries(row)) {
            if (!slotSeen.has(k)) {
              slotSeen.add(k);
              slotOrder.push(k);
            }
            if (v) coverage.set(k, (coverage.get(k) ?? 0) + 1);
          }
          if (sampleHead.length < 2) sampleHead.push(row);
          sampleTail.push({ idx, row });
          if (sampleTail.length > 2) sampleTail.shift();
        }
      };

      // Persist a batch (inject _hash when auto-deduping) and accumulate stats.
      const persist = async (
        rows: ExtractRow[],
      ): Promise<{ added: number; skipped: number; total: number } | { error: string }> => {
        account(rows);
        const toSave: Array<Record<string, unknown>> = injectHash
          ? rows.map((r) => ({ ...r, _hash: djb2(JSON.stringify(r)) }))
          : rows;
        return deps.saveRecords(collection, toSave, { dedupeKey });
      };

      const coverageLine = (): string =>
        slotOrder
          .map((s) => `${s} ${rowsSeen > 0 ? Math.round(((coverage.get(s) ?? 0) / rowsSeen) * 100) : 0}%`)
          .join(" · ");

      const sampleBlock = (): string => {
        const rows = [...sampleHead, ...sampleTail.filter((t) => t.idx >= 2).map((t) => t.row)];
        return `<untrusted_scratchpad_preview>${escapeUntrustedWrappers(JSON.stringify(rows))}</untrusted_scratchpad_preview>`;
      };

      // ── Single pass (scroll=false) ──
      if (!doScroll) {
        const pass = await extractVisible(exec, ctx.tabId, frameId, signature);
        if (!pass.ok) return fail(TARGET_STALE);
        let rows = pass.rows;
        let capped = false;
        if (rows.length > maxRows) {
          rows = rows.slice(0, maxRows);
          capped = true;
        }
        const res = await persist(rows);
        if ("error" in res) return fail(res.error);
        const observation =
          `Extracted from "${target.label}" into "${collection}": added ${res.added}, skipped ${res.skipped} (duplicates), total ${res.total}.\n` +
          (capped ? `Stopped: reached max_rows (${maxRows}).\n` : "") +
          `Fields (coverage): ${coverageLine()}\n` +
          `Sample (first + last rows): ${sampleBlock()}`;
        return ok(observation);
      }

      // ── Scroll loop (scroll=true) ──
      const start = now();
      let screens = 0;
      let stall = 0;
      let stopReason = "";
      let totalAdded = 0;
      let totalSkipped = 0;
      let collectionTotal = 0; // cumulative collection size (saveRecords total)

      for (;;) {
        if (signal?.aborted) {
          stopReason = "aborted by user";
          break;
        }
        const pass = await extractVisible(exec, ctx.tabId, frameId, signature);
        if (!pass.ok) {
          if (screens === 0 && collectionTotal === 0) return fail(TARGET_STALE);
          stopReason = "container lost (page structure changed mid-scroll)";
          break;
        }
        const room = Math.max(maxRows - collectionTotal, 0);
        const rows = pass.rows.slice(0, room);
        const res = await persist(rows);
        if ("error" in res) return fail(res.error);
        totalAdded += res.added;
        totalSkipped += res.skipped;
        collectionTotal = res.total;
        if (collectionTotal >= maxRows) {
          stopReason = `reached max_rows (${maxRows})`;
          break;
        }
        stall = res.added === 0 ? stall + 1 : 0;
        if (stall >= STALL_LIMIT) {
          stopReason = `no new items after ${STALL_LIMIT} scrolls`;
          break;
        }
        if (screens >= MAX_SCROLL_STEPS) {
          stopReason = `reached max scroll steps (${MAX_SCROLL_STEPS})`;
          break;
        }
        if (now() - start >= MAX_DURATION_MS) {
          stopReason = "time limit reached (120s)";
          break;
        }
        await scrollPage(ctx.tabId, frameId);
        screens++;
        await sleep(SETTLE_MS);
      }

      const observation =
        `Extracted from "${target.label}" into "${collection}": added ${totalAdded}, skipped ${totalSkipped} (duplicates), total ${collectionTotal}.\n` +
        `Scrolled ${screens} screens; stopped: ${stopReason}.\n` +
        `Fields (coverage): ${coverageLine()}\n` +
        `Sample (first + last rows): ${sampleBlock()}`;
      return ok(observation);
    },
  };
}
