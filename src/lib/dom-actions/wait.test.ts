import { describe, expect, it, vi, afterEach } from "vitest";
import { wait, MAX_WAIT_SECONDS } from "./wait";

afterEach(() => {
  vi.useRealTimers();
});

describe("wait", () => {
  it("waits the requested duration when within the cap", async () => {
    vi.useFakeTimers();
    const p = wait(120);
    // Not yet resolved before the full duration elapses.
    await vi.advanceTimersByTimeAsync(119_000);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.observation).toBe("Waited 120s");
  });

  it("caps oversized requests at MAX_WAIT_SECONDS and notes it", async () => {
    vi.useFakeTimers();
    const p = wait(9999);
    await vi.advanceTimersByTimeAsync(MAX_WAIT_SECONDS * 1000);
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.observation).toBe(
      `Waited ${MAX_WAIT_SECONDS}s (requested 9999s, capped at ${MAX_WAIT_SECONDS}s)`,
    );
  });

  it("exposes a 300s cap (5 minutes)", () => {
    expect(MAX_WAIT_SECONDS).toBe(300);
  });

  it("clamps negative values to 0", async () => {
    vi.useFakeTimers();
    const p = wait(-5);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.observation).toBe("Waited 0s");
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await wait(120, controller.signal);
    expect(r.success).toBe(true);
    expect(r.observation).toBe("Wait interrupted after 0s (requested 120s)");
  });

  it("resolves early when the signal aborts mid-wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = wait(120, controller.signal);
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort();
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.observation).toBe("Wait interrupted after 30s (requested 120s)");
  });

  it("does not leak the abort listener after a normal completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const p = wait(5, controller.signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
