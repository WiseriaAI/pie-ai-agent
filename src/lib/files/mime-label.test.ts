import { describe, it, expect } from "vitest";
import { fileTypeLabel, humanSize } from "./mime-label";

describe("fileTypeLabel", () => {
  it("maps known extensions to friendly uppercase labels (from the filename)", () => {
    expect(fileTypeLabel("pie/report.md")).toBe("MARKDOWN");
    expect(fileTypeLabel("data.json")).toBe("JSON");
    expect(fileTypeLabel("table.csv")).toBe("CSV");
    expect(fileTypeLabel("notes.txt")).toBe("TEXT");
    expect(fileTypeLabel("doc.xml")).toBe("XML");
    expect(fileTypeLabel("script.py")).toBe("PYTHON");
  });
  it("is case-insensitive on the extension and uses the basename", () => {
    expect(fileTypeLabel("pie/sub/REPORT.MD")).toBe("MARKDOWN");
  });
  it("falls back to the uppercased extension for unknown types", () => {
    expect(fileTypeLabel("a.weirdext")).toBe("WEIRDEXT");
  });
  it("returns FILE when there is no usable extension", () => {
    expect(fileTypeLabel("pie/README")).toBe("FILE");
    expect(fileTypeLabel(".gitignore")).toBe("FILE");
    expect(fileTypeLabel("")).toBe("FILE");
  });
});

describe("humanSize", () => {
  it("formats bytes", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(12_300)).toBe("12.0 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
