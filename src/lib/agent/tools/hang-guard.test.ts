// A hanging browser API must become a readable tool failure, not a wedged loop.
//
// The agent loop is deliberately unbounded (no MAX_STEPS — termination is the
// LLM's call), so there is no outer watchdog to break a deadlock. If
// chrome.tabs.group never settles, the task is stuck until the user aborts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { ApiHangError, withHangGuard } from "./hang-guard";

afterEach(() => {
  vi.useRealTimers();
});

describe("withHangGuard", () => {
  it("passes a resolved value straight through", async () => {
    await expect(withHangGuard(Promise.resolve(7), "api", 1000)).resolves.toBe(7);
  });

  it("preserves a genuine rejection rather than masking it as a hang", async () => {
    const boom = new Error("Tabs cannot be edited right now");
    await expect(withHangGuard(Promise.reject(boom), "api", 1000)).rejects.toBe(boom);
  });

  it("rejects with ApiHangError when the promise never settles", async () => {
    vi.useFakeTimers();
    const pending = withHangGuard(new Promise<void>(() => {}), "chrome.tabs.group", 3000);
    // Attach the assertion before advancing so the rejection is never unhandled.
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiHangError);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });

  it("names the API in the message so the observation tells the LLM what failed", async () => {
    vi.useFakeTimers();
    const pending = withHangGuard(new Promise<void>(() => {}), "chrome.tabs.group", 3000);
    const assertion = expect(pending).rejects.toThrow(/chrome\.tabs\.group/);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });

  it("does not fire once the promise has already settled", async () => {
    vi.useFakeTimers();
    await expect(withHangGuard(Promise.resolve("ok"), "api", 1000)).resolves.toBe("ok");
    // The timer must have been cleared — an unref'd pending timer here would
    // reject after the caller already moved on.
    expect(vi.getTimerCount()).toBe(0);
  });
});
