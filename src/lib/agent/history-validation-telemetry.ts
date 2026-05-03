/**
 * U4 — History-repair telemetry helpers.
 *
 * Extracted from src/background/index.ts so that the core logic is testable
 * as a pure function without constructing the full Service Worker context.
 *
 * Privacy invariant: raw message content is NEVER included in the log payload.
 * Only content-length + a SHA-256 hex prefix are emitted so violations can be
 * correlated in DevTools without leaking user data.
 */

import type { AgentMessage } from "../model-router/types";
import type { RoleViolation } from "./history-validation";

/** Single-violation telemetry entry — no raw content. */
export interface ViolationTelemetryEntry {
  idx: number;
  role: "user" | "assistant";
  contentLength: number;
  contentSha256First8: string;
}

/**
 * Build a structured telemetry payload for a history-repair event.
 *
 * Pure async function — does NOT call console.warn. Callers are responsible
 * for logging.
 *
 * @param violations - The violations returned by validateAndRepairAdjacentRoles.
 * @param messages   - The original (pre-repair) message array.
 * @returns Array of per-violation telemetry entries. Never throws — inner
 *   digest errors fall back to contentSha256First8 === 'n/a'.
 */
export async function buildHistoryRepairedTelemetry(
  violations: RoleViolation[],
  messages: AgentMessage[],
): Promise<ViolationTelemetryEntry[]> {
  return Promise.all(
    violations.map(async ({ idx, role }) => {
      const msg = messages[idx];
      const raw = msg
        ? typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)
        : "";
      const contentLength = raw.length;
      let contentSha256First8 = "n/a";
      try {
        const buf = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(raw),
        );
        const hex = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        contentSha256First8 = hex.slice(0, 8);
      } catch {
        // Web Crypto unavailable or digest failed — keep "n/a".
      }
      return { idx, role, contentLength, contentSha256First8 };
    }),
  );
}

/**
 * U4 — Emit a console.warn when validateAndRepairAdjacentRoles auto-repairs
 * adjacent same-role messages in the windowed LLM history.
 *
 * Wrapper around buildHistoryRepairedTelemetry that adds the console.warn
 * call and an outer try/catch so telemetry never crashes the caller.
 *
 * Uses the Web Crypto API available in Service Worker context.
 */
export async function logHistoryRepaired(
  violations: RoleViolation[],
  messages: AgentMessage[],
): Promise<void> {
  try {
    const payloads = await buildHistoryRepairedTelemetry(violations, messages);
    console.warn("[agent] multi-turn-history-repaired", { violations: payloads });
  } catch (e) {
    // Telemetry must never crash the caller.
    console.warn("[agent] multi-turn-history-repaired (telemetry error)", e);
  }
}
