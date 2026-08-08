// Timeout guard for browser APIs that can hang instead of failing.
//
// Same defect class as the side-panel probe (see background/panel-open.ts):
// Arc exposes `chrome.tabGroups` and accepts `chrome.tabs.group()`, but the
// returned promise never settles. A tool awaiting it wedges the agent loop
// forever — no observation, no error, no recovery. Since the loop is
// deliberately unbounded (no MAX_STEPS, termination is the LLM's call), there
// is nothing downstream to break the deadlock.
//
// Wrapping the call turns "hang forever" into an ordinary failed tool call the
// LLM can read and route around.

export class ApiHangError extends Error {
  constructor(api: string, ms: number) {
    super(
      `${api} did not respond within ${ms}ms — this browser accepts the call but never completes it. ` +
        `Treat the operation as unavailable here and continue without it.`,
    );
    this.name = "ApiHangError";
  }
}

/**
 * Await `promise`, rejecting with `ApiHangError` if it hasn't settled in
 * `timeoutMs`.
 *
 * Rejection (not a silent resolve) is deliberate: every caller already has a
 * catch path that turns an error into a partial-completion observation, so the
 * failure lands in the transcript the LLM reads.
 */
export async function withHangGuard<T>(
  promise: Promise<T>,
  api: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiHangError(api, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Budget for tab-group calls. Grouping is a local window operation with no
 * network in the path, so a working browser answers in single-digit ms; this
 * is slack, not a real expectation.
 */
export const TAB_GROUP_TIMEOUT_MS = 3000;
