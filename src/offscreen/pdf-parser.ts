import initLiteParse, { LiteParse } from "@llamaindex/liteparse-wasm";
import { tabUrlForCacheKey } from "@/lib/pdf/detect";
import { base64ToArrayBuffer } from "@/lib/files/base64";

export interface ParsedPage {
  page: number; // 1-indexed
  text: string;
}

export interface OutlineEntry {
  level: number;
  title: string;
  page: number;
}

export interface ParsedPdf {
  totalPages: number;
  title: string | null;
  outline: OutlineEntry[];
  pages: ParsedPage[]; // length === totalPages, 1-indexed via .page
}

export interface ParserState {
  cache: Map<string, ParsedPdf>;
}

export function createState(): ParserState {
  return { cache: new Map() };
}

export interface ParserDeps {
  parseBytes: (bytes: ArrayBuffer) => Promise<ParsedPdf>;
  fetchImpl: typeof fetch;
}

export type OffscreenMessage =
  | { type: "pdf:outline"; url: string }
  | { type: "pdf:read_page"; url: string; pages: number[] }
  | { type: "pdf:search"; url: string; query: string; maxResults: number }
  | { type: "pdf:parse_bytes"; base64: string; cacheKey: string };

export type HandleResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

const SCAN_SENTINEL = "scanned_pdf: No text layer; OCR not supported in MVP";
const MAX_BYTES = 100 * 1024 * 1024;
const SNIPPET_CONTEXT = 80;

async function getParsed(
  url: string,
  state: ParserState,
  deps: ParserDeps,
): Promise<ParsedPdf> {
  const key = tabUrlForCacheKey(url);
  const cached = state.cache.get(key);
  if (cached) return cached;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await deps.fetchImpl(url);
  } catch (e) {
    throw new Error(`fetch_failed: ${e instanceof Error ? e.message : "network error"}`);
  }
  if (!response.ok) {
    throw new Error(`fetch_failed: status ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `too_large: ${Math.round(bytes.byteLength / (1024 * 1024))}MB exceeds ${MAX_BYTES / (1024 * 1024)}MB cap`,
    );
  }

  let parsed: ParsedPdf;
  try {
    parsed = await deps.parseBytes(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "parse error";
    if (/password|encrypt/i.test(msg)) throw new Error(`encrypted_pdf: ${msg}`);
    throw new Error(`parse_failed: ${msg}`);
  }

  if (parsed.pages.every((p) => p.text.trim() === "")) {
    throw new Error(SCAN_SENTINEL);
  }

  state.cache.set(key, parsed);
  return parsed;
}

async function getParsedFromBytes(
  bytes: ArrayBuffer,
  cacheKey: string,
  state: ParserState,
  deps: ParserDeps,
): Promise<ParsedPdf> {
  const cached = state.cache.get(cacheKey);
  if (cached) return cached;
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `too_large: ${Math.round(bytes.byteLength / (1024 * 1024))}MB exceeds ${MAX_BYTES / (1024 * 1024)}MB cap`,
    );
  }
  let parsed: ParsedPdf;
  try {
    parsed = await deps.parseBytes(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "parse error";
    if (/password|encrypt/i.test(msg)) throw new Error(`encrypted_pdf: ${msg}`);
    throw new Error(`parse_failed: ${msg}`);
  }
  if (parsed.pages.every((p) => p.text.trim() === "")) {
    throw new Error(SCAN_SENTINEL);
  }
  state.cache.set(cacheKey, parsed);
  return parsed;
}

function buildSnippet(text: string, offset: number, query: string): string {
  const start = Math.max(0, offset - SNIPPET_CONTEXT);
  const end = Math.min(text.length, offset + query.length + SNIPPET_CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}

export async function handleMessage(
  msg: OffscreenMessage,
  state: ParserState,
  deps: ParserDeps,
): Promise<HandleResult> {
  try {
    if (msg.type === "pdf:parse_bytes") {
      const parsed = await getParsedFromBytes(base64ToArrayBuffer(msg.base64), msg.cacheKey, state, deps);
      return { ok: true, result: { pages: parsed.pages, total_pages: parsed.totalPages } };
    }

    const parsed = await getParsed(msg.url, state, deps);

    switch (msg.type) {
      case "pdf:outline":
        return {
          ok: true,
          result: {
            title: parsed.title,
            total_pages: parsed.totalPages,
            outline: parsed.outline,
          },
        };

      case "pdf:read_page": {
        const wanted = new Set(msg.pages);
        const pages = parsed.pages.filter((p) => wanted.has(p.page));
        return {
          ok: true,
          result: { pages, total_pages: parsed.totalPages },
        };
      }

      case "pdf:search": {
        const q = msg.query;
        if (q.length === 0) {
          return { ok: false, error: "empty_query" };
        }
        const ql = q.toLowerCase();
        const matches: Array<{ page: number; snippet: string; match_offset: number }> = [];
        let total = 0;
        for (const p of parsed.pages) {
          const lower = p.text.toLowerCase();
          let idx = lower.indexOf(ql);
          let perPageEmitted = false;
          while (idx !== -1) {
            total++;
            if (!perPageEmitted && matches.length < msg.maxResults) {
              matches.push({
                page: p.page,
                snippet: buildSnippet(p.text, idx, q),
                match_offset: idx,
              });
              perPageEmitted = true;
            }
            idx = lower.indexOf(ql, idx + ql.length);
          }
        }
        return {
          ok: true,
          result: { matches, total_matches: total },
        };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── LiteParse WASM integration ────────────────────────────────────────────────

let liteParseReady: Promise<void> | null = null;

async function ensureLiteParse(): Promise<void> {
  if (liteParseReady) return liteParseReady;
  liteParseReady = (async () => {
    const wasmUrl = chrome.runtime.getURL("liteparse.wasm");
    await initLiteParse(wasmUrl);
  })().catch((err) => {
    liteParseReady = null; // retry on next call
    throw err;
  });
  return liteParseReady;
}

async function realParseBytes(bytes: ArrayBuffer): Promise<ParsedPdf> {
  await ensureLiteParse();

  const parser = new LiteParse({ ocrEnabled: false, outputFormat: "json", quiet: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await parser.parse(new Uint8Array(bytes));

  // raw.pages is an array of page objects; each page may contain:
  //   - items: Array<{ text: string, ... }> for spatial text items, OR
  //   - text: string for plain text output
  // raw.text: string — full document text (not split by page)
  // raw.metadata: { title?: string, ... } — document metadata
  // raw.outline: Array<{ level: number, title: string, page: number }> — TOC

  const rawPages: unknown[] = Array.isArray(raw?.pages) ? raw.pages : [];

  const pages: ParsedPage[] = rawPages.map((p: unknown, i: number) => {
    const page = p as Record<string, unknown>;
    // Prefer a top-level text field; fall back to joining items[].text
    let text = "";
    if (typeof page.text === "string") {
      text = page.text;
    } else if (Array.isArray(page.items)) {
      text = (page.items as Array<Record<string, unknown>>)
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join(" ");
    }
    const pageNum =
      typeof page.pageNumber === "number" ? page.pageNumber : i + 1;
    return { page: pageNum, text };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadata = (raw?.metadata ?? {}) as Record<string, any>;
  const title: string | null =
    typeof metadata.title === "string" && metadata.title.length > 0
      ? metadata.title
      : null;

  const rawOutline: unknown[] = Array.isArray(raw?.outline) ? raw.outline : [];
  const outline: OutlineEntry[] = rawOutline
    .filter(
      (o): o is { title: string; page: number; level?: number } =>
        o !== null &&
        typeof o === "object" &&
        typeof (o as Record<string, unknown>).title === "string" &&
        typeof (o as Record<string, unknown>).page === "number",
    )
    .map((o) => ({
      level: typeof o.level === "number" ? o.level : 1,
      title: o.title,
      page: o.page,
    }));

  return {
    totalPages: pages.length,
    title,
    outline,
    pages,
  };
}

// ── Runtime wiring (skipped under vitest / non-extension contexts) ───────────
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const state = createState();
  const deps: ParserDeps = { parseBytes: realParseBytes, fetchImpl: fetch.bind(globalThis) };

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as { target?: string; requestId?: string } & Partial<OffscreenMessage>;
    if (msg?.target !== "offscreen") return; // not for us
    void (async () => {
      if (!msg.type) {
        sendResponse({ ok: false, error: "missing_type" });
        return;
      }
      const result = await handleMessage(msg as OffscreenMessage, state, deps);
      sendResponse(result);
    })();
    return true; // async response
  });
}
