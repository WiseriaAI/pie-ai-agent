import { describe, it, expect, vi } from "vitest";
import { processPickedFile } from "./process-picked-file";

function fileOf(name: string, type: string, content = "x"): File {
  return new File([content], name, { type });
}

describe("processPickedFile", () => {
  it("returns a FileAttachment for text", async () => {
    const r = await processPickedFile(fileOf("a.md", "text/markdown", "# Hi"), { supportsVision: false });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "file") {
      expect(r.attachment.name).toBe("a.md");
      expect(r.attachment.text).toContain("# Hi");
    } else throw new Error("expected file");
  });

  it("rejects images when vision unsupported", async () => {
    const r = await processPickedFile(fileOf("a.png", "image/png"), { supportsVision: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_vision");
  });

  it("rejects files over the 5MB cap", async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.txt", { type: "text/plain" });
    const r = await processPickedFile(big, { supportsVision: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
  });

  it("rejects unsupported types", async () => {
    const r = await processPickedFile(fileOf("a.bin", "application/octet-stream"), { supportsVision: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported");
  });
});
