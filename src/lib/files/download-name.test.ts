import { describe, it, expect } from "vitest";
import { sanitizeDownloadName } from "./download-name";

describe("sanitizeDownloadName", () => {
  it("prefixes pie/ for a plain name", () => {
    expect(sanitizeDownloadName("report.md")).toBe("pie/report.md");
  });
  it("keeps an existing pie/ prefix without doubling", () => {
    expect(sanitizeDownloadName("pie/report.md")).toBe("pie/report.md");
  });
  it("strips leading slashes (no absolute paths)", () => {
    expect(sanitizeDownloadName("/etc/passwd")).toBe("pie/etc/passwd");
  });
  it("strips .. traversal segments", () => {
    expect(sanitizeDownloadName("../../secret.txt")).toBe("pie/secret.txt");
    expect(sanitizeDownloadName("pie/../../x")).toBe("pie/x");
  });
  it("collapses backslashes and empty segments", () => {
    expect(sanitizeDownloadName("a//b\\c")).toBe("pie/a/b/c");
  });
  it("falls back to a default when name is empty after cleaning", () => {
    expect(sanitizeDownloadName("../..")).toBe("pie/untitled.txt");
    expect(sanitizeDownloadName("")).toBe("pie/untitled.txt");
  });
});
