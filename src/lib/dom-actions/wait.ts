import type { ActionResult } from "./types";

/**
 * Upper bound on a single `wait` call. Page-monitoring scenarios (waiting for a
 * page to auto-refresh, a countdown/queue to clear, a poll to settle) routinely
 * need tens of seconds to a few minutes, so the cap is 5 minutes rather than the
 * old 10s. It stays bounded (not unlimited) so a runaway LLM value can't hang a
 * task indefinitely. Long waits are safe: the per-port keep-alive (25s
 * getPlatformInfo heartbeat) keeps the SW alive while a task runs.
 */
export const MAX_WAIT_SECONDS = 300;

/**
 * Runs in the Service Worker (NOT injected into the page).
 * Waits for the given number of seconds, capped at {@link MAX_WAIT_SECONDS}.
 *
 * Honors an optional AbortSignal so a user-initiated abort resolves the wait
 * immediately instead of leaving the loop stuck in setTimeout. The agent loop
 * otherwise only checks `signal.aborted` between steps, so without this a long
 * wait would ignore aborts until it elapsed.
 *
 * @param seconds - Number of seconds to wait (capped at MAX_WAIT_SECONDS)
 * @param signal - Optional abort signal; when it fires the wait resolves early
 */
export async function wait(
  seconds: number,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const capped = Math.min(Math.max(0, seconds), MAX_WAIT_SECONDS);
  const startedAt = Date.now();

  if (signal?.aborted) {
    return {
      success: true,
      observation: `Wait interrupted after 0s (requested ${seconds}s)`,
    };
  }

  const aborted = await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, capped * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  if (aborted) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    return {
      success: true,
      observation: `Wait interrupted after ${elapsed}s (requested ${seconds}s)`,
    };
  }

  return {
    success: true,
    observation: `Waited ${capped}s${capped < seconds ? ` (requested ${seconds}s, capped at ${MAX_WAIT_SECONDS}s)` : ""}`,
  };
}
