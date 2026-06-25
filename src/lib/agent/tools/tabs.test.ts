import { describe, expect, it, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { TAB_TOOLS } from "./tabs";
import { openUrlTool } from "./tabs";

const focusTabTool = TAB_TOOLS.find((t) => t.name === "focus_tab")!;

const listTabsTool = TAB_TOOLS.find((t) => t.name === "list_tabs")!;
const closeTabsTool = TAB_TOOLS.find((t) => t.name === "close_tabs")!;
const unpinTabTool = TAB_TOOLS.find((t) => t.name === "unpin_tab")!;

describe("list_tabs — phantom-tabId filter (Chrome TAB_ID_NONE = -1)", () => {
  it("never surfaces tab.id === -1 to the LLM observation", async () => {
    // Chrome's TAB_ID_NONE (-1) is assigned to apps, DevTools windows,
    // and session-restore / detached tabs. They show up in
    // chrome.tabs.query results but are not addressable via the
    // chrome.tabs.{get,remove,update,...} surface; calling those with
    // tabId=-1 throws synchronously ("Value must be at least 0").
    //
    // The list_tabs handler must filter these phantom tabs out at source,
    // otherwise the LLM learns them as legitimate tabIds from the
    // observation block and a follow-up close_tabs
    // crashes the loop.
    chromeMock.tabs.__tabsById.set(100, {
      id: 100,
      url: "https://example.com/",
      title: "Real tab",
      active: true,
      windowId: 1,
    });
    chromeMock.tabs.__tabsById.set(-1, {
      id: -1,
      url: "chrome://devtools/",
      title: "DevTools window",
      active: false,
      windowId: -1,
    } as unknown as Parameters<typeof chromeMock.tabs.__tabsById.set>[1]);

    const result = await listTabsTool.handler(
      { scope: "currentWindow" },
      { tabId: 100 },
    );
    expect(result.success).toBe(true);
    const obs = result.observation ?? "";
    expect(obs).toContain("[100]");
    // The phantom -1 tab MUST NOT appear in the LLM observation.
    expect(obs).not.toContain("[-1]");
    // The total reflects ONLY usable tabs after filtering.
    expect(obs).toMatch(/total=1/);
  });

  it("filters out tabs with non-integer id (NaN / Infinity defense)", async () => {
    chromeMock.tabs.__tabsById.set(50, {
      id: 50,
      url: "https://example.com/",
      title: "Real",
      active: true,
      windowId: 1,
    });
    chromeMock.tabs.__tabsById.set(NaN as unknown as number, {
      id: NaN as unknown as number,
      url: "https://nan.example.com/",
      title: "NaN id",
      active: false,
      windowId: 1,
    } as unknown as Parameters<typeof chromeMock.tabs.__tabsById.set>[1]);

    const result = await listTabsTool.handler(
      { scope: "currentWindow" },
      { tabId: 50 },
    );
    expect(result.success).toBe(true);
    expect(result.observation ?? "").not.toContain("NaN");
  });
});

// ── Issue #110 — close_tabs protects ALL session pinned tabs (every mode) ────
// Previously only pinMode='user' was protected (K-9), so in task/auto mode the
// agent could close its own pinned tab. Now any tab in ctx.pinnedTabs[] is
// refused regardless of mode; the refusal message tells the LLM to unpin_tab
// first (task/auto) or use the PINNED dropdown (user).

describe("close_tabs (Issue #110) — pinned-tab protection across all modes", () => {
  it("REFUSES close when pinMode='user' and tabId is in pinnedTabs[]", async () => {
    const result = await closeTabsTool.handler(
      { tabIds: [42, 7] },
      {
        tabId: 42,
        pinMode: "user",
        pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot close user-pinned tab/i);
    expect(result.error).toMatch(/PINNED dropdown/i);
  });

  it("REFUSES close when pinMode='task' and tabId is in pinnedTabs[] (directs to unpin_tab)", async () => {
    // Issue #110 behavior change: task-mode pins are now protected. The agent
    // must unpin the tab before it can close it — so the call is refused and
    // chrome.tabs.remove is never reached.
    const removeSpy = vi.fn(async () => undefined);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;

    const result = await closeTabsTool.handler(
      { tabIds: [42] },
      {
        tabId: 42,
        pinMode: "task",
        pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unpin_tab/);
    expect(removeSpy).not.toHaveBeenCalled();

    delete (chromeMock.tabs as unknown as { remove?: unknown }).remove;
  });

  it("REFUSES close when pinMode='auto' and tabId is in pinnedTabs[] (directs to unpin_tab)", async () => {
    const removeSpy = vi.fn(async () => undefined);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;

    const result = await closeTabsTool.handler(
      { tabIds: [99] },
      {
        tabId: 99,
        pinMode: "auto",
        pinnedTabs: [{ tabId: 99, origin: "https://example.com" }],
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unpin_tab/);
    expect(removeSpy).not.toHaveBeenCalled();

    delete (chromeMock.tabs as unknown as { remove?: unknown }).remove;
  });

  it("ALLOWS close when the tab is NOT in pinnedTabs[] (auto mode)", async () => {
    chromeMock.tabs.__tabsById.set(99, {
      id: 99,
      url: "https://example.com/",
      title: "test",
      active: true,
      windowId: 1,
    });
    const removeSpy = vi.fn(async () => undefined);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;
    const confirmedTabTargets = new Map([
      [99, { origin: "https://example.com", title: "test" }],
    ]);

    const result = await closeTabsTool.handler(
      { tabIds: [99] },
      {
        tabId: 99,
        pinMode: "auto",
        // 99 is not in pinnedTabs → not protected
        confirmedTabTargets,
      },
    );
    expect(result.error ?? "").not.toMatch(/unpin_tab/);
    expect(removeSpy).toHaveBeenCalled();

    delete (chromeMock.tabs as unknown as { remove?: unknown }).remove;
  });

  it("ALLOWS close when pinMode is undefined (legacy callers / test harness)", async () => {
    chromeMock.tabs.__tabsById.set(11, {
      id: 11,
      url: "https://example.com/",
      title: "test",
      active: true,
      windowId: 1,
    });
    const removeSpy = vi.fn(async () => undefined);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;
    const confirmedTabTargets = new Map([
      [11, { origin: "https://example.com", title: "test" }],
    ]);

    const result = await closeTabsTool.handler(
      { tabIds: [11] },
      {
        tabId: 11,
        // pinMode omitted — legacy path
        confirmedTabTargets,
      },
    );
    expect(result.error ?? "").not.toMatch(/cannot close user-pinned tab/i);
    expect(removeSpy).toHaveBeenCalled();

    delete (chromeMock.tabs as unknown as { remove?: unknown }).remove;
  });

  it("user mode REFUSES even when other tabIds in the list are non-pinned", async () => {
    // K-9 is a hard refuse on the entire batch when any pinned tab is in it.
    // The agent must explicitly retry without the pinned tab.
    const result = await closeTabsTool.handler(
      { tabIds: [42, 7, 99] },
      {
        tabId: 42,
        pinMode: "user",
        pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot close user-pinned tab/i);
  });

  it("user mode ALLOWS close of non-pinned tabs when pinnedTabs doesn't include them", async () => {
    chromeMock.tabs.__tabsById.set(7, {
      id: 7,
      url: "https://other.com/",
      title: "Other",
      active: false,
      windowId: 1,
    });
    const removeSpy = vi.fn(async () => undefined);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;
    const confirmedTabTargets = new Map([
      [7, { origin: "https://other.com", title: "Other" }],
    ]);

    const result = await closeTabsTool.handler(
      { tabIds: [7] },
      {
        tabId: 42,
        pinMode: "user",
        // pinnedTabs only has tab 42, not tab 7
        pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
        confirmedTabTargets,
      },
    );
    // Tab 7 is not in pinnedTabs, so K-9 does not block
    expect(result.error ?? "").not.toMatch(/cannot close user-pinned tab/i);
    expect(removeSpy).toHaveBeenCalledWith([7]);

    delete (chromeMock.tabs as unknown as { remove?: unknown }).remove;
  });

  it("K-9 v1.5: user mode refuses close on any tab in pinnedTabs[]", async () => {
    const r = await closeTabsTool.handler(
      { tabIds: [12, 13] },
      {
        tabId: 12,
        pinMode: "user",
        pinnedTabs: [
          { tabId: 12, origin: "https://a.com" },
          { tabId: 13, origin: "https://b.com" },
        ],
      },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/cannot close user-pinned tab/);
  });
});

// ── Issue #110 — unpin_tab handler ──────────────────────────────────────────

describe("unpin_tab (Issue #110) — agent-initiated unpin", () => {
  it("removes the tab from pinnedTabs via removePinnedTab in task mode", async () => {
    const removePinnedTab = vi.fn(async () => undefined);
    const result = await unpinTabTool.handler(
      { tabId: 10 },
      {
        tabId: 10,
        pinMode: "task",
        pinnedTabs: [
          { tabId: 10, origin: "https://a.example.com" },
          { tabId: 11, origin: "https://b.example.com" },
        ],
        removePinnedTab,
      },
    );
    expect(result.success).toBe(true);
    expect(removePinnedTab).toHaveBeenCalledWith(10);
    // observation should point the LLM at the follow-up close_tabs.
    expect(result.observation ?? "").toMatch(/close_tabs/);
  });

  it("removes the tab in auto mode too", async () => {
    const removePinnedTab = vi.fn(async () => undefined);
    const result = await unpinTabTool.handler(
      { tabId: 10 },
      {
        tabId: 10,
        pinMode: "auto",
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
        removePinnedTab,
      },
    );
    expect(result.success).toBe(true);
    expect(removePinnedTab).toHaveBeenCalledWith(10);
  });

  it("REFUSES unpin in user mode (directs to the PINNED dropdown)", async () => {
    const removePinnedTab = vi.fn(async () => undefined);
    const result = await unpinTabTool.handler(
      { tabId: 10 },
      {
        tabId: 10,
        pinMode: "user",
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
        removePinnedTab,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PINNED dropdown/i);
    expect(removePinnedTab).not.toHaveBeenCalled();
  });

  it("FAILS when tabId is not one of the session's pinned tabs", async () => {
    const removePinnedTab = vi.fn(async () => undefined);
    const result = await unpinTabTool.handler(
      { tabId: 999 },
      {
        tabId: 10,
        pinMode: "task",
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
        removePinnedTab,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not pinned/i);
    expect(removePinnedTab).not.toHaveBeenCalled();
  });

  it("FAILS when the session has no pinned tabs", async () => {
    const result = await unpinTabTool.handler(
      { tabId: 10 },
      { tabId: 10, pinMode: "auto", pinnedTabs: [] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pinned tabs/i);
  });

  it("FAILS gracefully when removePinnedTab is absent (test/legacy harness)", async () => {
    const result = await unpinTabTool.handler(
      { tabId: 10 },
      {
        tabId: 10,
        pinMode: "task",
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
        // removePinnedTab intentionally omitted
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing removePinnedTab/i);
  });

  it("FAILS when tabId is not a number", async () => {
    const result = await unpinTabTool.handler(
      {},
      {
        tabId: 10,
        pinMode: "task",
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/numeric tabId/i);
  });
});

// ── v1.5 Task 6 — focus_tab handler ─────────────────────────────────────────
import type { ToolHandlerContext } from "@/lib/agent/types";

describe("focus_tab (v1.5 Task 6) — handler contract", () => {
  const snapshot = { url: "", title: "", elements: [] };

  it("SUCCEEDS and calls setCurrentFocusTabId when tabId is in pinnedTabs", async () => {
    const setCurrentFocusTabId = vi.fn(async () => undefined);
    const result = await focusTabTool.handler(
      { tabId: 10 },
      {
        tabId: 10,
        snapshot,
        pinnedTabs: [
          { tabId: 10, origin: "https://a.example.com" },
          { tabId: 20, origin: "https://b.example.com" },
        ],
        setCurrentFocusTabId,
      } as unknown as ToolHandlerContext,
    );
    expect(result.success).toBe(true);
    expect(setCurrentFocusTabId).toHaveBeenCalledWith(10);
    expect(result.observation).toContain("focus changed to tab 10");
    expect(result.observation).toContain("https://a.example.com");
    // Must warn the LLM not to batch operations on the new tab in the same response.
    expect(result.observation).toContain("next iteration");
  });

  it("FAILS with descriptive error when tabId is NOT in pinnedTabs", async () => {
    const setCurrentFocusTabId = vi.fn(async () => undefined);
    const result = await focusTabTool.handler(
      { tabId: 99 },
      {
        tabId: 10,
        snapshot,
        pinnedTabs: [
          { tabId: 10, origin: "https://a.example.com" },
          { tabId: 20, origin: "https://b.example.com" },
        ],
        setCurrentFocusTabId,
      } as unknown as ToolHandlerContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in pinnedTabs/i);
    // Error must list the valid tab ids so the LLM can self-correct.
    expect(result.error).toContain("10");
    expect(result.error).toContain("20");
    // setCurrentFocusTabId must NOT have been called.
    expect(setCurrentFocusTabId).not.toHaveBeenCalled();
  });

  it("FAILS with error when pinnedTabs is empty (auto / no-pin mode)", async () => {
    const result = await focusTabTool.handler(
      { tabId: 5 },
      {
        tabId: 5,
        snapshot,
        pinnedTabs: [],
      } as unknown as ToolHandlerContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pinned tabs/i);
  });

  it("FAILS gracefully when setCurrentFocusTabId is absent (test/legacy harness)", async () => {
    // Simulates a legacy ToolHandlerContext without the v1.5 setter.
    const result = await focusTabTool.handler(
      { tabId: 10 },
      {
        tabId: 10,
        snapshot,
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
        // setCurrentFocusTabId intentionally omitted
      } as unknown as ToolHandlerContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing setCurrentFocusTabId/i);
  });

  it("FAILS with error when tabId arg is missing or non-numeric", async () => {
    const result = await focusTabTool.handler(
      {},
      {
        tabId: 10,
        snapshot,
        pinnedTabs: [{ tabId: 10, origin: "https://a.example.com" }],
      } as unknown as ToolHandlerContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a numeric tabId/i);
  });
});

// ── v1.5 Task 7 — open_url tool ──────────────────────────────────────────────

describe("open_url tool", () => {
  beforeEach(() => {
    (chromeMock.tabs as unknown as { create: unknown }).create = vi
      .fn()
      .mockResolvedValue({ id: 999, url: "https://example.com/" });
  });

  it("rejects non-http/https schemes", async () => {
    const cases = [
      "javascript:alert(1)",
      "data:text/html,xxx",
      "file:///etc/passwd",
      "chrome://settings",
      "view-source:https://example.com",
      "mailto:foo@bar.com",
      "ftp://example.com",
      "ws://example.com",
      "blob:https://x/abc",
    ];
    for (const url of cases) {
      const r = await openUrlTool.handler(
        { url },
        { tabId: 12 },
      );
      expect(r.success).toBe(false);
      // Some of these throw in `new URL(input)` (e.g., "blob:https://x/abc"
      // parses, but "javascript:..." parses too — the protocol check catches all).
      // The "invalid URL" path also acceptable for unparseable forms.
      expect(r.error).toMatch(/unsafe-url-scheme|invalid URL/);
    }
  });

  it("rejects empty / non-string url", async () => {
    for (const url of ["", null, undefined, 42, {}]) {
      const r = await openUrlTool.handler(
        { url } as unknown as { url: string },
        { tabId: 12 },
      );
      expect(r.success).toBe(false);
    }
  });

  it("rejects URL longer than 4096 chars", async () => {
    const url = "https://example.com/" + "a".repeat(5000);
    const r = await openUrlTool.handler(
      { url },
      { tabId: 12 },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/url-too-long/);
  });

  it("rejects relative URL (URL constructor throws)", async () => {
    const r = await openUrlTool.handler(
      { url: "/example.com" },
      { tabId: 12 },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid URL/);
  });

  // ── Issue #50: open_url waits for navigation commit ──────────────────────
  //
  // chrome.tabs.create returns the instant a tab is allocated, with
  // url="about:blank". Before this change, openUrlTool would return
  // success immediately — leaving the loop's next-iteration origin check
  // to either race the commit or STOP on about:blank. Now the handler
  // awaits waitForUrlSettle and translates the result.

  function fireOnCommittedNext(tabId: number, frameId: number) {
    // Drain microtasks so the addListener call inside waitForUrlSettle
    // has executed, then fire onCommitted.
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const listeners = chromeMock.webNavigation.__committedListeners.slice();
        for (const l of listeners) {
          l({
            tabId,
            frameId,
            url: "ignored",
            timeStamp: Date.now(),
            processId: 0,
          } as Parameters<typeof l>[0]);
        }
        resolve();
      });
    });
  }

  it("creates tab and pushes pin on success", async () => {
    chromeMock.tabs.__tabsById.set(999, {
      id: 999,
      url: "https://example.com/page",
    });
    const append = vi.fn().mockResolvedValue(undefined);
    const handlerPromise = openUrlTool.handler(
      { url: "https://example.com/page" },
      {
        tabId: 12,
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
        appendPinnedTab: append,
      },
    );
    await fireOnCommittedNext(999, 0);
    const r = await handlerPromise;
    expect(r.success).toBe(true);
    expect(
      (chromeMock.tabs as unknown as { create: ReturnType<typeof vi.fn> })
        .create,
    ).toHaveBeenCalledWith({
      url: "https://example.com/page",
      active: false,
    });
    expect(append).toHaveBeenCalledWith({
      tabId: 999,
      origin: "https://example.com",
    });
    expect(r.observation).toMatch(/Opened tab 999/);
    expect(r.observation).toMatch(/focus_tab\(999\)/);
  });

  it("respects active=true", async () => {
    chromeMock.tabs.__tabsById.set(999, {
      id: 999,
      url: "https://example.com/",
    });
    const append = vi.fn().mockResolvedValue(undefined);
    const handlerPromise = openUrlTool.handler(
      { url: "https://example.com/", active: true },
      {
        tabId: 12,
        appendPinnedTab: append,
      },
    );
    await fireOnCommittedNext(999, 0);
    const r = await handlerPromise;
    expect(r.success).toBe(true);
    expect(
      (chromeMock.tabs as unknown as { create: ReturnType<typeof vi.fn> })
        .create,
    ).toHaveBeenCalledWith({
      url: "https://example.com/",
      active: true,
    });
    expect(r.observation).toMatch(/stole user's view/);
  });

  it("succeeds without appendPinnedTab writer (test/legacy harness)", async () => {
    chromeMock.tabs.__tabsById.set(999, {
      id: 999,
      url: "https://example.com/",
    });
    const handlerPromise = openUrlTool.handler(
      { url: "https://example.com/" },
      { tabId: 12 },
    );
    await fireOnCommittedNext(999, 0);
    const r = await handlerPromise;
    expect(r.success).toBe(true);
    // No appendPinnedTab present, but the tab was still created.
    expect(
      (chromeMock.tabs as unknown as { create: ReturnType<typeof vi.fn> })
        .create,
    ).toHaveBeenCalled();
  });

  it("Issue #50 — awaits navigation commit; appendPinnedTab fires only on success", async () => {
    chromeMock.tabs.__tabsById.set(999, {
      id: 999,
      url: "https://example.com/landing",
    });
    (chromeMock.tabs as unknown as { create: unknown }).create = vi
      .fn()
      .mockResolvedValue({ id: 999, url: "about:blank" });

    const append = vi.fn().mockResolvedValue(undefined);
    // Kick off the handler, then fire onCommitted concurrently.
    const handlerPromise = openUrlTool.handler(
      { url: "https://example.com/landing" },
      {
        tabId: 12,
        appendPinnedTab: append,
      },
    );
    await fireOnCommittedNext(999, 0);

    const r = await handlerPromise;
    expect(r.success).toBe(true);
    expect(append).toHaveBeenCalledWith({
      tabId: 999,
      origin: "https://example.com",
    });
    expect(r.observation).toMatch(/Opened tab 999/);
  });

  it("Issue #50 — handler fails when commit times out; appendPinnedTab is NOT called and tab is NOT removed", async () => {
    vi.useFakeTimers();
    try {
      (chromeMock.tabs as unknown as { create: unknown }).create = vi
        .fn()
        .mockResolvedValue({ id: 777, url: "about:blank" });
      const append = vi.fn().mockResolvedValue(undefined);
      const removeSpy = vi.fn();
      (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;

      const handlerPromise = openUrlTool.handler(
        { url: "https://example.com/page" },
        {
          tabId: 12,
          appendPinnedTab: append,
        },
      );

      // Let the timeout fire without ever emitting onCommitted.
      await vi.advanceTimersByTimeAsync(5000);
      const r = await handlerPromise;

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/did not commit/i);
      expect(r.error).toMatch(/timeout/i);
      expect(r.error).toMatch(/close_tabs\(\[777\]\)/);
      expect(append).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Issue #50 — handler fails with origin-mismatch reason when chrome navigates elsewhere", async () => {
    // chrome.tabs.create returned tab id 888, but the page that committed
    // ended up at a different origin (server-side redirect / typo'd URL).
    chromeMock.tabs.__tabsById.set(888, {
      id: 888,
      url: "https://other.example/redirected",
    });
    (chromeMock.tabs as unknown as { create: unknown }).create = vi
      .fn()
      .mockResolvedValue({ id: 888, url: "about:blank" });

    const append = vi.fn().mockResolvedValue(undefined);
    const handlerPromise = openUrlTool.handler(
      { url: "https://example.com/page" },
      {
        tabId: 12,
        appendPinnedTab: append,
      },
    );
    await fireOnCommittedNext(888, 0);

    const r = await handlerPromise;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/origin-mismatch/);
    expect(append).not.toHaveBeenCalled();
  });

  it("Issue #50 — chrome.tabs.create rejection path remains unchanged (no settle call)", async () => {
    (chromeMock.tabs as unknown as { create: unknown }).create = vi
      .fn()
      .mockRejectedValue(new Error("quota exceeded"));
    const beforeListenerCount =
      chromeMock.webNavigation.__committedListeners.length;
    const r = await openUrlTool.handler(
      { url: "https://example.com/" },
      { tabId: 12 },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/chrome\.tabs\.create failed/);
    // No settle attempt → no leaked listener.
    expect(chromeMock.webNavigation.__committedListeners.length).toBe(
      beforeListenerCount,
    );
  });
});

import { switchToNewTabTool } from "./tabs";

describe("switch_to_new_tab (v1.1 cross-tab replay)", () => {
  const baseCtx = () => {
    const calls: { pin?: { tabId: number; origin: string }; focus?: number } = {};
    return {
      ctx: {
        tabId: 10,
        pinnedTabs: [{ tabId: 10, origin: "https://shop.com" }],
        appendPinnedTab: async (p: { tabId: number; origin: string }) => {
          calls.pin = p;
        },
        setCurrentFocusTabId: async (id: number) => {
          calls.focus = id;
        },
      } as unknown as ToolHandlerContext,
      calls,
    };
  };

  type QueryResolved = Parameters<typeof chromeMock.tabs.query.mockResolvedValue>[0];
  type GetImpl = Parameters<typeof chromeMock.tabs.get.mockImplementation>[0];

  it("adopts the child tab matching the origin hint and focuses it", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 10, openerTabId: undefined, url: "https://shop.com/cart" },
      { id: 21, openerTabId: 10, url: "https://ads.example/x" },
      { id: 22, openerTabId: 10, url: "https://pay.stripe.com/checkout" },
    ] as unknown as QueryResolved);
    chromeMock.tabs.get.mockImplementation(((async (id: number) =>
      (({
        21: { id: 21, url: "https://ads.example/x" },
        22: { id: 22, url: "https://pay.stripe.com/checkout" },
      } as Record<number, unknown>)[id])) as unknown as GetImpl));
    const { ctx, calls } = baseCtx();
    const r = await switchToNewTabTool.handler({ origin: "https://pay.stripe.com" }, ctx);
    expect(r.success).toBe(true);
    expect(calls.pin).toEqual({ tabId: 22, origin: "https://pay.stripe.com" });
    expect(calls.focus).toBe(22);
  });

  it("falls back to the newest child when no origin matches", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 10, openerTabId: undefined, url: "https://shop.com/cart" },
      { id: 31, openerTabId: 10, url: "https://a.com/x" },
      { id: 33, openerTabId: 10, url: "https://b.com/y" },
    ] as unknown as QueryResolved);
    chromeMock.tabs.get.mockImplementation(((async (id: number) =>
      (({
        31: { id: 31, url: "https://a.com/x" },
        33: { id: 33, url: "https://b.com/y" },
      } as Record<number, unknown>)[id])) as unknown as GetImpl));
    const { ctx, calls } = baseCtx();
    const r = await switchToNewTabTool.handler({}, ctx);
    expect(r.success).toBe(true);
    expect(calls.focus).toBe(33); // highest tabId
  });

  it("returns a non-fatal observation when no child tab exists", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      { id: 10, openerTabId: undefined, url: "https://shop.com" },
    ] as unknown as QueryResolved);
    const { ctx } = baseCtx();
    const r = await switchToNewTabTool.handler({}, ctx);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("未检测到新标签页");
  });
});
