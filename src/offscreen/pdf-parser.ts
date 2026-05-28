import { tabUrlForCacheKey } from "@/lib/pdf/detect";

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
  | { type: "pdf:search"; url: string; query: string; maxResults: number };

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

// ── Runtime wiring (skipped under vitest / non-extension contexts) ───────────
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const state = createState();
  // Task 6 will replace this stub with the real LiteParse call.
  const placeholderParse = async (_bytes: ArrayBuffer): Promise<ParsedPdf> => {
    throw new Error("parse_failed: parser not yet wired (Task 6)");
  };
  const deps: ParserDeps = { parseBytes: placeholderParse, fetchImpl: fetch.bind(globalThis) };

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
