import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { peekWait, acquire, _resetForTests } from "./rate-limiter";

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
});
afterEach(() => vi.useRealTimers());

describe("rate-limiter", () => {
  it("未满窗直通：limit 内的 acquire 立即 resolve，peekWait 为 null", async () => {
    expect(peekWait("k", 2)).toBeNull();
    await acquire("k", 2);
    expect(peekWait("k", 2)).toBeNull();
    await acquire("k", 2);
    expect(peekWait("k", 2)).not.toBeNull(); // 第 3 条会等
  });

  it("满窗排队：60s 后窗口滚动放行", async () => {
    await acquire("k", 1);
    const resumeAt = peekWait("k", 1);
    expect(resumeAt).toBe(Date.now() + 60_000);
    let resolved = false;
    const p = acquire("k", 1).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await p;
    expect(resolved).toBe(true);
  });

  it("多 waiter 按窗口空位逐个放行", async () => {
    await acquire("k", 1); // t=0 占位
    const order: number[] = [];
    const p1 = acquire("k", 1).then(() => order.push(1));
    const p2 = acquire("k", 1).then(() => order.push(2));
    await vi.advanceTimersByTimeAsync(60_100); // t=0 过期 → 放行一个
    expect(order.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_100); // 再过 60s → 放行第二个
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("abort 打断等待：抛 AbortError 且不记账", async () => {
    await acquire("k", 1);
    const ac = new AbortController();
    const p = acquire("k", 1, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // 不记账：窗口滚动后 peekWait 立即变 null（只有最初 1 条）
    await vi.advanceTimersByTimeAsync(60_100);
    expect(peekWait("k", 1)).toBeNull();
  });

  it("已 abort 的 signal → 立即拒绝", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquire("k", 5, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("不同 key 互不影响", async () => {
    await acquire("a", 1);
    expect(peekWait("a", 1)).not.toBeNull();
    expect(peekWait("b", 1)).toBeNull();
  });
});
