// src/lib/schedules/url-guard.test.ts
//
// Tests for the schedule-specific restricted-URL guard. This widens the
// scheme-only `isRestrictedUrl` (loop.ts) with the Chrome Web Store host check
// — spec §8.2 lists "Web Store" as restricted, but the Web Store is served over
// https:// so the scheme check alone lets it through.

import { describe, expect, it } from "vitest";
import { isRestrictedScheduleUrl } from "./url-guard";

describe("isRestrictedScheduleUrl", () => {
  it.each([
    // Scheme-restricted (inherited from isRestrictedUrl) → restricted
    ["chrome://settings", true],
    ["chrome-extension://abc/options.html", true],
    ["about:blank", true],
    ["edge://flags", true],
    ["file:///Users/me/notes.txt", true],
    ["data:text/html,<h1>hi</h1>", true],
    ["javascript:alert(1)", true],
    ["blob:https://example.com/uuid", true],

    // Web Store hosts (NEW — host check, both old + current) → restricted
    ["https://chromewebstore.google.com/detail/foo/abc", true],
    ["https://chrome.google.com/webstore/detail/bar", true],

    // Ordinary https pages → NOT restricted
    ["https://example.com", false],
    ["https://news.ycombinator.com/news", false],
    ["https://github.com/WiseriaAI/pie-ai-agent", false],
    // chrome.google.com on a NON-webstore path is a normal Google page
    ["https://chrome.google.com/", false],
  ])("isRestrictedScheduleUrl(%s) === %s", (url, expected) => {
    expect(isRestrictedScheduleUrl(url)).toBe(expected);
  });

  it("file://*.pdf は意図的に block しない（ユーザーのファイル権限で扱う surface）", () => {
    // file PDF is a deliberately-supported surface: it routes through the user's
    // "Allow access to file URLs" permission, NOT treated as a restricted page.
    // isRestrictedUrl returns false for file PDFs; isRestrictedScheduleUrl must
    // preserve that (no extra host that would re-block it).
    expect(isRestrictedScheduleUrl("file:///Users/me/report.pdf")).toBe(false);
  });
});
