import { describe, it, expect } from "vitest";
import { resizeSW } from "./resize-sw";

describe("resizeSW (OffscreenCanvas)", () => {
  it("downscales 3000x2000 jpeg blob to 1568x1045", async () => {
    const blob = new Blob([new Uint8Array(5_000_000)], { type: "image/jpeg" });
    const res = await resizeSW(blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.width).toBe(1568);
      expect(res.value.height).toBe(1045);
      expect(res.value.mediaType).toBe("image/jpeg");
      expect(res.value.byteLength).toBe(245678);
    }
  });
  it("rejects > 25 MB blob", async () => {
    const blob = new Blob([new Uint8Array(26_000_000)], { type: "image/jpeg" });
    const res = await resizeSW(blob);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("byte-too-large");
  });
  it("returns {ok:false, decode-failed} when FileReader fails", async () => {
    const OriginalFileReader = (globalThis as { FileReader: unknown }).FileReader;
    (globalThis as unknown as { FileReader: unknown }).FileReader = class FakeErrorFileReader {
      onload: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      result: ArrayBuffer | string | null = null;
      readAsDataURL(_b: Blob) {
        Promise.resolve().then(() => this.onerror?.(new Error("boom")));
      }
    };
    try {
      const blob = new Blob([new Uint8Array(5_000_000)], { type: "image/jpeg" });
      const res = await resizeSW(blob);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("decode-failed");
    } finally {
      (globalThis as unknown as { FileReader: unknown }).FileReader = OriginalFileReader;
    }
  });
});
