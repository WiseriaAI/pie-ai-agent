import { describe, it, expect } from "vitest";
import { mimeLabel, humanSize } from "./mime-label";

describe("mimeLabel", () => {
  it("maps known mimes to friendly uppercase labels", () => {
    expect(mimeLabel("text/markdown")).toBe("MARKDOWN");
    expect(mimeLabel("application/json")).toBe("JSON");
    expect(mimeLabel("text/csv")).toBe("CSV");
    expect(mimeLabel("text/plain")).toBe("TEXT");
    expect(mimeLabel("application/xml")).toBe("XML");
    expect(mimeLabel("text/xml")).toBe("XML");
    expect(mimeLabel("application/x-ndjson")).toBe("NDJSON");
  });
  it("falls back to the subtype uppercased", () => {
    expect(mimeLabel("text/x-python")).toBe("X-PYTHON");
    expect(mimeLabel("")).toBe("FILE");
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
