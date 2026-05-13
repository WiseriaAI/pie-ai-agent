import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { waitForUrlSettle } from "./wait-for-url-settle";

beforeEach(() => {
  vi.useFakeTimers();
  chromeMock.tabs.__tabsById.clear();
  chromeMock.webNavigation.__committedListeners = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function fireOnCommitted(tabId: number, frameId: number): void {
  const listeners = chromeMock.webNavigation.__committedListeners.slice();
  for (const l of listeners) {
    l({
      tabId,
      frameId,
      url: "ignored-by-helper",
      timeStamp: Date.now(),
      processId: 0,
    } as Parameters<typeof l>[0]);
  }
}

describe("waitForUrlSettle", () => {
  it("resolves committed=true when onCommitted fires and origin matches", async () => {
    chromeMock.tabs.__tabsById.set(42, {
      id: 42,
      url: "https://example.com/page",
    });
    const p = waitForUrlSettle(42, "https://example.com", 5000);
    // Drain the microtask that adds the listener.
    await Promise.resolve();
    fireOnCommitted(42, 0);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual({
      committed: true,
      url: "https://example.com/page",
    });
  });

  it("resolves committed=false reason=origin-mismatch when origin diverges", async () => {
    chromeMock.tabs.__tabsById.set(42, {
      id: 42,
      url: "https://evil.example/landing",
    });
    const p = waitForUrlSettle(42, "https://example.com", 5000);
    await Promise.resolve();
    fireOnCommitted(42, 0);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual({
      committed: false,
      reason: "origin-mismatch",
      observedUrl: "https://evil.example/landing",
    });
  });

  it("resolves committed=false reason=timeout after timeoutMs without onCommitted", async () => {
    const p = waitForUrlSettle(42, "https://example.com", 5000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r).toEqual({ committed: false, reason: "timeout" });
  });

  it("resolves committed=false reason=tab-gone when chrome.tabs.get rejects", async () => {
    // tabs.get throws "No tab with id 42" by default for unknown ids in the mock.
    const p = waitForUrlSettle(42, "https://example.com", 5000);
    await Promise.resolve();
    fireOnCommitted(42, 0);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual({ committed: false, reason: "tab-gone" });
  });

  it("rejects with AbortError when signal is already aborted at call time", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      waitForUrlSettle(42, "https://example.com", 5000, ac.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError when signal aborts mid-wait", async () => {
    const ac = new AbortController();
    const p = waitForUrlSettle(42, "https://example.com", 5000, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes the onCommitted listener on every exit path (commit/timeout/tab-gone/abort)", async () => {
    // Sanity: every resolution path must reach removeListener so we don't leak
    // listeners across iterations (50-step task = up to 50 wait calls).
    const initialCount = () =>
      chromeMock.webNavigation.__committedListeners.length;

    // commit path
    chromeMock.tabs.__tabsById.set(1, { id: 1, url: "https://a.com/" });
    const p1 = waitForUrlSettle(1, "https://a.com", 5000);
    await Promise.resolve();
    expect(initialCount()).toBe(1);
    fireOnCommitted(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    expect(initialCount()).toBe(0);

    // timeout path
    const p2 = waitForUrlSettle(2, "https://a.com", 5000);
    await Promise.resolve();
    expect(initialCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await p2;
    expect(initialCount()).toBe(0);

    // tab-gone path
    const p3 = waitForUrlSettle(3, "https://a.com", 5000);
    await Promise.resolve();
    expect(initialCount()).toBe(1);
    fireOnCommitted(3, 0);
    await vi.advanceTimersByTimeAsync(0);
    await p3;
    expect(initialCount()).toBe(0);

    // abort path
    const ac = new AbortController();
    const p4 = waitForUrlSettle(4, "https://a.com", 5000, ac.signal);
    await Promise.resolve();
    expect(initialCount()).toBe(1);
    ac.abort();
    await expect(p4).rejects.toMatchObject({ name: "AbortError" });
    expect(initialCount()).toBe(0);
  });

  it("ignores sub-frame onCommitted events (frameId !== 0)", async () => {
    chromeMock.tabs.__tabsById.set(42, {
      id: 42,
      url: "https://example.com/page",
    });
    const p = waitForUrlSettle(42, "https://example.com", 5000);
    await Promise.resolve();
    fireOnCommitted(42, 1); // iframe / sub-frame — must be ignored
    fireOnCommitted(42, 2);
    await vi.advanceTimersByTimeAsync(100);
    // Helper must still be pending — drive the real top-frame commit now.
    fireOnCommitted(42, 0);
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(r).toEqual({
      committed: true,
      url: "https://example.com/page",
    });
  });

  it("supports concurrent waits on distinct tabIds without cross-talk", async () => {
    chromeMock.tabs.__tabsById.set(1, { id: 1, url: "https://a.com/" });
    chromeMock.tabs.__tabsById.set(2, { id: 2, url: "https://b.com/" });
    const pA = waitForUrlSettle(1, "https://a.com", 5000);
    const pB = waitForUrlSettle(2, "https://b.com", 5000);
    await Promise.resolve();
    expect(chromeMock.webNavigation.__committedListeners.length).toBe(2);

    // Fire commit for tab 2 only — pA must remain pending.
    fireOnCommitted(2, 0);
    await vi.advanceTimersByTimeAsync(0);
    const rB = await pB;
    expect(rB).toEqual({ committed: true, url: "https://b.com/" });

    // pA still pending; one listener remains.
    expect(chromeMock.webNavigation.__committedListeners.length).toBe(1);

    fireOnCommitted(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    const rA = await pA;
    expect(rA).toEqual({ committed: true, url: "https://a.com/" });
    expect(chromeMock.webNavigation.__committedListeners.length).toBe(0);
  });
});
