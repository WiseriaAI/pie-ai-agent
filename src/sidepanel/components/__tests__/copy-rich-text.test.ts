import { afterEach, describe, expect, it, vi } from "vitest";
import { copyRichText } from "../copy-rich-text";

const HTML = "<p>Hello <strong>world</strong></p>";
const TEXT = "Hello world";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("copyRichText", () => {
  it("writes both text/html and text/plain via a ClipboardItem when supported", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    const ok = await copyRichText(HTML, TEXT);

    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    const items = write.mock.calls[0][0] as ClipboardItem[];
    expect(items).toHaveLength(1);
    expect(items[0].types).toEqual(
      expect.arrayContaining(["text/html", "text/plain"]),
    );
  });

  it("falls back to writeText(plain) when the rich write path rejects", async () => {
    const write = vi.fn().mockRejectedValue(new Error("no rich clipboard"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    const ok = await copyRichText(HTML, TEXT);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(TEXT);
  });

  it("returns false (no throw) when the clipboard is fully unavailable", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    await expect(copyRichText(HTML, TEXT)).resolves.toBe(false);
  });
});
