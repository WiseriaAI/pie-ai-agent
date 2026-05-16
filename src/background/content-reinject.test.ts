import { describe, it, expect, vi } from "vitest";
import { reinjectAllTabs, shouldSkipUrl } from "./content-reinject";

const MANIFEST_FILES = ["assets/content-entry.js"];

function manifestStub(): chrome.runtime.Manifest {
  return {
    manifest_version: 3,
    name: "test",
    version: "0.0.0",
    content_scripts: [{ matches: ["<all_urls>"], js: MANIFEST_FILES }],
  } as unknown as chrome.runtime.Manifest;
}

describe("shouldSkipUrl", () => {
  it.each([
    ["chrome://extensions/", true],
    ["chrome-extension://abc/popup.html", true],
    ["edge://settings", true],
    ["about:blank", true],
    ["file:///tmp/x.html", true],
    ["view-source:https://x.com", true],
    ["https://chromewebstore.google.com/foo", true],
    ["https://chrome.google.com/webstore/x", true],
    ["https://example.com/page", false],
    ["http://localhost:3000", false],
    [undefined, true],
  ])("%s → %s", (url, expected) => {
    expect(shouldSkipUrl(url)).toBe(expected);
  });
});

describe("reinjectAllTabs", () => {
  it("injects to http/https tabs, skips chrome:// and missing id", async () => {
    const tabs = {
      query: vi.fn().mockResolvedValue([
        { id: 1, url: "https://example.com/" },
        { id: 2, url: "chrome://extensions/" },
        { id: undefined, url: "https://orphan.test/" },
        { id: 3, url: "https://docs.example.com/" },
      ]),
    };
    const executeScript = vi.fn().mockResolvedValue([{}]);
    const scripting = { executeScript };

    const res = await reinjectAllTabs({
      tabs,
      scripting,
      getManifest: manifestStub,
    });

    expect(res).toEqual({ injected: 2, skipped: 2, failed: 0 });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: MANIFEST_FILES });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 3 }, files: MANIFEST_FILES });
  });

  it("counts failed injections without throwing", async () => {
    const tabs = {
      query: vi.fn().mockResolvedValue([
        { id: 1, url: "https://example.com/" },
        { id: 2, url: "https://blocked.test/" },
      ]),
    };
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{}])
      .mockRejectedValueOnce(new Error("Cannot access contents of url"));
    const scripting = { executeScript };

    const res = await reinjectAllTabs({
      tabs,
      scripting,
      getManifest: manifestStub,
    });

    expect(res).toEqual({ injected: 1, skipped: 0, failed: 1 });
  });

  it("returns zero result when manifest has no content_scripts", async () => {
    const tabs = { query: vi.fn() };
    const scripting = { executeScript: vi.fn() };

    const res = await reinjectAllTabs({
      tabs,
      scripting,
      getManifest: () => ({
        manifest_version: 3,
        name: "x",
        version: "0",
      }) as unknown as chrome.runtime.Manifest,
    });

    expect(res).toEqual({ injected: 0, skipped: 0, failed: 0 });
    expect(tabs.query).not.toHaveBeenCalled();
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });
});
