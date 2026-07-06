import { describe, it, expect } from "vitest";
import { createExtractRecordsTool } from "./extract-tool";
import { createPageAtlasStore } from "./state";
import type { AtlasFingerprint, AtlasTarget, PageAtlasState } from "./types";
import type { ProbeParams, ProbeResult, ExtractRow } from "../../../dom-actions/probe-core";
import type { ToolHandlerContext } from "../../types";

const FP: AtlasFingerprint = {
  url: "https://x.test/",
  title: "t",
  bodyTextLengthBucket: 0,
  interactiveCountBucket: 0,
  topSectionCount: 1,
};

const CTX = { tabId: 7 } as ToolHandlerContext;

function storeWithTarget(overrides: Partial<AtlasTarget> = {}) {
  const store = createPageAtlasStore();
  const target: AtlasTarget = {
    id: "collection_c0",
    type: "collection",
    label: "Products",
    frameId: 0,
    confidence: "medium",
    summary: "3 repeated li items",
    signature: { kind: "collection", ordinal: 0, itemShapeKey: "li|a:0|a" },
    ...overrides,
  };
  const atlas: PageAtlasState = {
    atlasId: "atlas_1",
    tabId: 7,
    url: "https://x.test/",
    origin: "https://x.test",
    title: "t",
    createdAt: Date.now(),
    fingerprint: FP,
    targets: [target],
    controls: [],
    forms: [],
    controlGroups: [],
    navigation: [],
  };
  store.save(atlas);
  return store;
}

const getPageState = async () => ({ url: "https://x.test/", fingerprint: FP });

type ExtractOut = Extract<ProbeResult, { op: "extract" }>;

// scripted exec: return the next ProbeResult per call (repeats last).
function scriptedExec(script: ExtractOut[]) {
  const calls: ProbeParams[] = [];
  let i = 0;
  return {
    calls,
    exec: async (_tab: number, _frame: number, p: ProbeParams): Promise<ProbeResult> => {
      calls.push(p);
      return script[Math.min(i++, script.length - 1)];
    },
  };
}

const batch = (rows: ExtractRow[], over: Partial<ExtractOut> = {}): ExtractOut => ({
  op: "extract",
  found: true,
  slots: Object.keys(rows[0] ?? {}),
  rows,
  totalVisible: rows.length,
  nextCursor: rows.length,
  done: true,
  ...over,
});

// A saveRecords fake that dedupes by a key (default _hash) like the real one.
function fakeSaveRecords(key = "_hash") {
  const seen = new Set<string>();
  const store: Array<Record<string, unknown>> = [];
  const calls: Array<{ collection: string; records: Array<Record<string, unknown>>; opts: unknown }> = [];
  return {
    calls,
    store,
    saveRecords: async (
      collection: string,
      records: Array<Record<string, unknown>>,
      opts: { dedupeKey?: string },
    ) => {
      calls.push({ collection, records, opts });
      const dk = opts.dedupeKey ?? key;
      let added = 0;
      let skipped = 0;
      for (const r of records) {
        const v = r[dk];
        const id = v === undefined || v === null ? undefined : String(v);
        if (id !== undefined && seen.has(id)) {
          skipped++;
          continue;
        }
        if (id !== undefined) seen.add(id);
        store.push(r);
        added++;
      }
      return { added, skipped, total: store.length };
    },
  };
}

describe("extract_records — single pass", () => {
  it("saves extracted rows via saveRecords and reports counts + coverage + sample", async () => {
    const sink = fakeSaveRecords();
    const { exec } = scriptedExec([
      batch([
        { title: "A", link: "/a", price: "¥1" },
        { title: "B", link: "/b" },
      ]),
    ]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products" },
      CTX,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("added 2");
    expect(r.observation).toMatch(/title 100%/);
    expect(r.observation).toMatch(/price 50%/);
    expect(r.observation).toContain("<untrusted_scratchpad_preview>");
    expect(sink.calls).toHaveLength(1);
  });

  it("injects _hash dedupe when dedupeKey omitted", async () => {
    const sink = fakeSaveRecords();
    const { exec } = scriptedExec([batch([{ title: "A" }, { title: "B" }])]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
    });
    await tool.handler({ atlas_id: "atlas_1", target_id: "collection_c0", collection: "products" }, CTX);
    expect(sink.calls[0].opts).toEqual({ dedupeKey: "_hash" });
    for (const rec of sink.calls[0].records) {
      expect(typeof rec._hash).toBe("string");
    }
  });

  it("passes user dedupeKey through and does not inject _hash", async () => {
    const sink = fakeSaveRecords("link");
    const { exec } = scriptedExec([batch([{ title: "A", link: "/a" }])]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
    });
    await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", dedupeKey: "link" },
      CTX,
    );
    expect(sink.calls[0].opts).toEqual({ dedupeKey: "link" });
    expect(sink.calls[0].records[0]._hash).toBeUndefined();
  });

  it("pulls multiple cursor batches until done", async () => {
    const sink = fakeSaveRecords();
    const { exec, calls } = scriptedExec([
      batch([{ n: "0" }], { done: false, nextCursor: 500, totalVisible: 501 }),
      batch([{ n: "1" }], { done: true, nextCursor: 501, totalVisible: 501 }),
    ]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products" },
      CTX,
    );
    expect(r.success).toBe(true);
    // exec called with cursor 0 then cursor 500
    const cursors = calls.filter((c) => c.op === "extract").map((c) => (c.op === "extract" ? c.cursor : -1));
    expect(cursors).toEqual([0, 500]);
    // both rows saved in one persist call
    expect(sink.calls[0].records).toHaveLength(2);
  });

  it("fails with target_stale guidance when extract returns found=false", async () => {
    const sink = fakeSaveRecords();
    const { exec } = scriptedExec([batch([], { found: false })]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products" },
      CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('read_page({mode:"atlas"})');
  });

  it("fails when target has no signature", async () => {
    const sink = fakeSaveRecords();
    const { exec } = scriptedExec([batch([{ title: "A" }])]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget({ signature: undefined }),
      getPageState,
      exec,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products" },
      CTX,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('read_page({mode:"atlas"})');
  });

  it("caps stored rows at max_rows", async () => {
    const sink = fakeSaveRecords();
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` }));
    const { exec } = scriptedExec([batch(rows)]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", max_rows: 5 },
      CTX,
    );
    expect(sink.calls[0].records).toHaveLength(5);
    expect(r.observation).toContain("reached max_rows (5)");
  });
});

describe("extract_records — scroll loop", () => {
  const noSleep = async () => {};

  it("accumulates until 3 stalled passes, reports screens + stop reason", async () => {
    const sink = fakeSaveRecords();
    const p1 = batch(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` })));
    const p2 = batch(Array.from({ length: 8 }, (_, i) => ({ id: `r${i + 7}` }))); // overlap r7-r9
    // script: p1, p2, then p2 repeats (added=0 thrice)
    const { exec } = scriptedExec([p1, p2]);
    let scrolls = 0;
    let sleeps = 0;
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
      scrollPage: async () => {
        scrolls++;
      },
      sleep: async (ms) => {
        expect(ms).toBe(600);
        sleeps++;
      },
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", scroll: true },
      CTX,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("Scrolled 4 screens");
    expect(r.observation).toContain("no new items after 3 scrolls");
    expect(scrolls).toBe(4);
    expect(sleeps).toBe(4);
  });

  it("stops at max_rows", async () => {
    const sink = fakeSaveRecords();
    const p1 = batch(Array.from({ length: 10 }, (_, i) => ({ id: `a${i}` })));
    const p2 = batch(Array.from({ length: 10 }, (_, i) => ({ id: `b${i}` })));
    const { exec } = scriptedExec([p1, p2]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
      scrollPage: async () => {},
      sleep: noSleep,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", scroll: true, max_rows: 12 },
      CTX,
    );
    expect(r.observation).toContain("reached max_rows (12)");
    // second persist limited to remaining room (2)
    expect(sink.calls[1].records).toHaveLength(2);
  });

  it("aborts via signal, keeps saved rows", async () => {
    const sink = fakeSaveRecords();
    const controller = new AbortController();
    const p1 = batch(Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` })));
    const { exec } = scriptedExec([p1]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
      scrollPage: async () => {
        controller.abort(); // abort right after the first pass scrolls
      },
      sleep: noSleep,
      signal: controller.signal,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", scroll: true },
      CTX,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("aborted by user");
    expect(r.observation).toContain("added 5");
  });

  it("container lost mid-scroll returns partial with reason", async () => {
    const sink = fakeSaveRecords();
    const p1 = batch(Array.from({ length: 4 }, (_, i) => ({ id: `r${i}` })));
    const gone = batch([], { found: false });
    const { exec } = scriptedExec([p1, gone]);
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
      scrollPage: async () => {},
      sleep: noSleep,
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", scroll: true },
      CTX,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("container lost");
    expect(r.observation).toContain("added 4");
  });

  it("stops at time limit", async () => {
    const sink = fakeSaveRecords();
    const p1 = batch(Array.from({ length: 3 }, (_, i) => ({ id: `r${i}` })));
    const { exec } = scriptedExec([p1]);
    const times = [0, 121_000];
    let ti = 0;
    const tool = createExtractRecordsTool({
      saveRecords: sink.saveRecords,
      store: storeWithTarget(),
      getPageState,
      exec,
      scrollPage: async () => {},
      sleep: noSleep,
      now: () => times[Math.min(ti++, times.length - 1)],
    });
    const r = await tool.handler(
      { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products", scroll: true },
      CTX,
    );
    expect(r.observation).toContain("time limit reached (120s)");
  });
});
