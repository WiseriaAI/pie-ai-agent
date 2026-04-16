import type { ActionResult } from "./types";

const MAX_WAIT_SECONDS = 10;

/**
 * Runs in the Service Worker (NOT injected into the page).
 * Waits for the given number of seconds, capped at 10.
 *
 * @param seconds - Number of seconds to wait (capped at 10)
 */
export async function wait(seconds: number): Promise<ActionResult> {
  const capped = Math.min(Math.max(0, seconds), MAX_WAIT_SECONDS);
  await new Promise<void>((resolve) => setTimeout(resolve, capped * 1000));
  return {
    success: true,
    observation: `Waited ${capped}s${capped < seconds ? ` (requested ${seconds}s, capped at ${MAX_WAIT_SECONDS}s)` : ""}`,
  };
}
