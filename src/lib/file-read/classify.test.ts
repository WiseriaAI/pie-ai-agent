import { describe, it, expect } from "vitest";
import { classifyFile, MAX_FILE_BYTES } from "./classify";

describe("classifyFile", () => {
  it("classifies images by mime", () => { expect(classifyFile("a.png", "image/png")).toBe("image"); });
  it("classifies pdf by mime or extension", () => {
    expect(classifyFile("doc.pdf", "application/pdf")).toBe("pdf");
    expect(classifyFile("doc.pdf", "")).toBe("pdf");
  });
  it("classifies text by mime", () => { expect(classifyFile("a.txt", "text/plain")).toBe("text"); });
  it("classifies common code/text extensions when mime is empty", () => {
    for (const n of ["a.md", "a.ts", "a.json", "a.csv", "a.py", "a.log"]) expect(classifyFile(n, "")).toBe("text");
  });
  it("returns unsupported for unknown binary", () => {
    expect(classifyFile("a.bin", "application/octet-stream")).toBe("unsupported");
    expect(classifyFile("a.docx", "")).toBe("unsupported");
  });
  it("exposes a 5MB cap", () => { expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024); });
});
