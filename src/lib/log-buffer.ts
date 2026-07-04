// src/lib/log-buffer.ts
//
// Lightweight cross-context error/warn capture for the "attach recent logs"
// feedback option. Patches console.error/warn to append truncated entries to a
// single config-store key. NEVER reads chat data (IDB `sessions`); env/message
// bodies are out of scope by construction.
import { getConfig, setConfig } from "./idb/config-store";

export interface LogEntry {
  ts: number;
  level: "error" | "warn";
  ctx: string;
  text: string;
}

const KEY = "log_buffer";
const MAX_ENTRIES = 500;
const MAX_TEXT = 500;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function serialize(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ")
    .slice(0, MAX_TEXT);
}

/** Append one entry; prune >24h; cap to MAX_ENTRIES (drop oldest). Best-effort —
 *  swallows all errors so a failing write never recurses into console.error.
 *  // ponytail: 整缓冲每条全量重写 + last-writer-wins（SW/panel 并发时可能丢个别行），
 *  //           error/warn 量级可接受；热循环狂刷再改增量存储。 */
export async function appendLog(entry: LogEntry): Promise<void> {
  try {
    const cur = (await getConfig<LogEntry[]>(KEY)) ?? [];
    const cutoff = entry.ts - RETENTION_MS;
    const next = [...cur, entry].filter((e) => e.ts >= cutoff);
    if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
    await setConfig(KEY, next);
  } catch {
    /* best-effort */
  }
}

/** Recent entries within `windowMs` (default 24h), oldest→newest, as text. */
export async function readRecentLogs(now: number, windowMs = RETENTION_MS): Promise<string> {
  let cur: LogEntry[] = [];
  try { cur = (await getConfig<LogEntry[]>(KEY)) ?? []; } catch { cur = []; }
  const cutoff = now - windowMs;
  return cur
    .filter((e) => e.ts >= cutoff)
    .map((e) => `[${new Date(e.ts).toISOString()}] ${e.level} (${e.ctx}) ${e.text}`)
    .join("\n");
}

let installed = false;
/** Patch console.error/warn to also append to the buffer. Idempotent per realm. */
export function installLogCapture(ctx: string, now: () => number = () => Date.now()): void {
  if (installed) return;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void appendLog({ ts: now(), level, ctx, text: serialize(args) });
    };
  }
}
