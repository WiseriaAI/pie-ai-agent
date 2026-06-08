/**
 * Lazy offscreen document lifecycle + request/response bridge.
 *
 * - ensureOffscreen() is idempotent and concurrency-safe: a single in-flight
 *   creation promise is shared across simultaneous callers.
 * - sendToOffscreen() tags every outbound message with target='offscreen'
 *   and a fresh requestId, then resolves with the typed payload returned
 *   by the offscreen-side handler. Offscreen returns { ok: true, result }
 *   on success or { ok: false, error } on failure; the latter rejects.
 */

const OFFSCREEN_HTML = "src/offscreen/pdf-parser.html";

export type OffscreenRequest =
  | { type: "pdf:outline"; url: string }
  | { type: "pdf:read_page"; url: string; pages: number[] }
  | { type: "pdf:search"; url: string; query: string; maxResults: number }
  | { type: "pdf:parse_bytes"; base64: string; cacheKey: string }
  | { type: "sql:run"; table: string; records: Array<Record<string, unknown>>; sql: string };

export interface OffscreenSuccess<T = unknown> {
  ok: true;
  result: T;
}
export interface OffscreenFailure {
  ok: false;
  error: string;
}
export type OffscreenReply<T = unknown> = OffscreenSuccess<T> | OffscreenFailure;

let ensurePromise: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    if (typeof chrome.offscreen?.hasDocument === "function") {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    }
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_HTML),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        "Parse PDF bytes with the LiteParse WASM module; SWs cannot load WASM streaming + run heavy parsing while servicing other events.",
    });
  })().catch((err) => {
    ensurePromise = null;
    throw err;
  });
  return ensurePromise;
}

function newRequestId(): string {
  return (
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  );
}

export async function sendToOffscreen<T = unknown>(
  req: OffscreenRequest,
): Promise<T> {
  await ensureOffscreen();
  const requestId = newRequestId();
  const reply = (await chrome.runtime.sendMessage({
    ...req,
    target: "offscreen",
    requestId,
  })) as OffscreenReply<T> | undefined;
  if (!reply) {
    throw new Error("offscreen: no reply (document may have been torn down)");
  }
  if (!reply.ok) {
    throw new Error(reply.error || "offscreen: unknown error");
  }
  return reply.result;
}
