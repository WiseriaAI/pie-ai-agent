import { describe, expect, it, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { TAB_TOOLS } from "./tabs";
import { openUrlTool } from "./tabs";

const focusTabTool = TAB_TOOLS.find((t) => t.name === "focus_tab")!;

const listTabsTool = TAB_TOOLS.find((t) => t.name === "list_tabs")!;
const closeTabsTool = TAB_TOOLS.find((t) => t.name === "close_tabs")!;

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
    // observation block and a follow-up get_tab_content / close_tabs
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
      { tabId: 100, snapshot: { url: "", title: "", elements: [] } },
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
      { tabId: 50, snapshot: { url: "", title: "", elements: [] } },
    );
    expect(result.success).toBe(true);
    expect(result.observation ?? "").not.toContain("NaN");
  });
});

// ── M5 — close_tabs K-9 (user-locked pin protection only) ───────────────────

describe("close_tabs K-9 (M5/v1.5) — pinMode-aware pinned-tab protection", () => {
  it("REFUSES close when pinMode='user' and tabId is in pinnedTabs[]", async () => {
    const result = await closeTabsTool.handler(
      { tabIds: [42, 7] },
      {
        tabId: 42,
        snapshot: { url: "", title: "", elements: [] },
        pinMode: "user",
        pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot close user-pinned tab/i);
    expect(result.error).toMatch(/PINNED dropdown/i);
  });

  it("ALLOWS close past K-9 when pinMode='task' (proceeds to origin verify)", async () => {
    // Stub chrome.tabs.remove so we can detect the path past K-9. We also
    // populate confirmedTabTargets so verifyConfirmedOrigin succeeds and
    // the handler reaches chrome.tabs.remove.
    chromeMock.tabs.__tabsById.set(42, {
      id: 42,
      url: "https://example.com/",
      title: "test",
      active: true,
      windowId: 1,
    });
    const removeSpy = vi.fn(async () => undefined);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = removeSpy;

    const confirmedTabTargets = new Map([
      [42, { origin: "https://example.com", title: "test" }],
    ]);

    const result = await closeTabsTool.handler(
      { tabIds: [42] },
      {
        tabId: 42,
        snapshot: { url: "", title: "", elements: [] },
        pinMode: "task",
        confirmedTabTargets,
        pinnedTabs: [{ tabId: 42, origin: "https://example.com" }],
      },
    );

    // K-9 did NOT fire (task mode doesn't protect)
    expect(result.error ?? "").not.toMatch(/cannot close user-pinned tab/i);
    // Handler proceeded to chrome.tabs.remove
    expect(removeSpy).toHaveBeenCalledWith([42]);
    expect(result.success).toBe(true);

    delete (chromeMock.tabs as unknown as { remove?: unknown }).remove;
  });

  it("ALLOWS close when pinMode='auto' (transient pin, no protection)", async () => {
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
        snapshot: { url: "", title: "", elements: [] },
        pinMode: "auto",
        confirmedTabTargets,
      },
    );
    expect(result.error ?? "").not.toMatch(/cannot close user-pinned tab/i);
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
        snapshot: { url: "", title: "", elements: [] },
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
        snapshot: { url: "", title: "", elements: [] },
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
        snapshot: { url: "", title: "", elements: [] },
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
        snapshot: { url: "", title: "", elements: [] },
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

// ── v1.5 Task 6 — focus_tab handler ─────────────────────────────────────────

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
      },
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
      },
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
      },
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
      },
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
      },
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
        { tabId: 12, snapshot: { url: "", title: "", elements: [] } },
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
        { tabId: 12, snapshot: { url: "", title: "", elements: [] } },
      );
      expect(r.success).toBe(false);
    }
  });

  it("rejects URL longer than 4096 chars", async () => {
    const url = "https://example.com/" + "a".repeat(5000);
    const r = await openUrlTool.handler(
      { url },
      { tabId: 12, snapshot: { url: "", title: "", elements: [] } },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/url-too-long/);
  });

  it("rejects relative URL (URL constructor throws)", async () => {
    const r = await openUrlTool.handler(
      { url: "/example.com" },
      { tabId: 12, snapshot: { url: "", title: "", elements: [] } },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid URL/);
  });

  it("creates tab and pushes pin on success", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const r = await openUrlTool.handler(
      { url: "https://example.com/page" },
      {
        tabId: 12,
        snapshot: { url: "", title: "", elements: [] },
        pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
        appendPinnedTab: append,
      },
    );
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
    const append = vi.fn().mockResolvedValue(undefined);
    const r = await openUrlTool.handler(
      { url: "https://example.com/", active: true },
      {
        tabId: 12,
        snapshot: { url: "", title: "", elements: [] },
        appendPinnedTab: append,
      },
    );
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
    const r = await openUrlTool.handler(
      { url: "https://example.com/" },
      { tabId: 12, snapshot: { url: "", title: "", elements: [] } },
    );
    expect(r.success).toBe(true);
    // No appendPinnedTab present, but the tab was still created.
    expect(
      (chromeMock.tabs as unknown as { create: ReturnType<typeof vi.fn> })
        .create,
    ).toHaveBeenCalled();
  });
});
