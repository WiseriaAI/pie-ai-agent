import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tryAcquire, waitUntil, _resetForTests } from "./rate-limiter";

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});
afterEach(() => vi.useRealTimers());

describe("rate-limiter", () => {
  it("未满窗直通：limit 内的 tryAcquire 返回 null 并记账", () => {
    expect(tryAcquire("k", 2)).toBeNull();
    expect(tryAcquire("k", 2)).toBeNull();
    expect(tryAcquire("k", 2)).toBe(Date.now() + 60_000); // 第 3 条要等
  });

  it("满窗排队：60s 后窗口滚动放行", async () => {
    tryAcquire("k", 1);
    const resumeAt = tryAcquire("k", 1)!;
    expect(resumeAt).toBe(Date.now() + 60_000);
    let resolved = false;
    const p = waitUntil(resumeAt).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await p;
    expect(resolved).toBe(true);
    expect(tryAcquire("k", 1)).toBeNull();
  });

  it("满窗只放行一个：抢输的拿到新的 resumeAt（要再等一个窗口）", async () => {
    tryAcquire("k", 1); // t=0 占位
    const first = tryAcquire("k", 1)!;
    await vi.advanceTimersByTimeAsync(60_100);
    expect(tryAcquire("k", 1)).toBeNull(); // 赢家拿到空位
    const second = tryAcquire("k", 1)!; // 输家
    expect(second).toBeGreaterThan(first);
  });

  it("waitUntil abort：抛 AbortError", async () => {
    const ac = new AbortController();
    const p = waitUntil(Date.now() + 60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("已 abort 的 signal → 立即拒绝", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(waitUntil(Date.now() + 1_000, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("不同 key 互不影响", () => {
    tryAcquire("a", 1);
    expect(tryAcquire("a", 1)).not.toBeNull();
    expect(tryAcquire("b", 1)).toBeNull();
  });
});
