import { describe, expect, it } from "vitest";
import { chromeMock } from "@/test/setup";
import { TAB_TOOLS } from "./tabs";

const listTabsTool = TAB_TOOLS.find((t) => t.name === "list_tabs")!;

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
