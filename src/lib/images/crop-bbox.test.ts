import { describe, it, expect, vi, beforeEach } from "vitest";
import { cropBboxToJpegDataUrl } from "./crop-bbox";

const mockBitmap = { close: vi.fn() } as unknown as ImageBitmap;
const mockBlob = new Blob(["fake-jpeg"], { type: "image/jpeg" });

beforeEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error mock
  globalThis.createImageBitmap = vi.fn(async () => mockBitmap);
  // @ts-expect-error mock
  globalThis.OffscreenCanvas = vi.fn(function (this: { width: number; height: number }, w: number, h: number) {
    this.width = w;
    this.height = h;
    this.getContext = () => ({
      drawImage: vi.fn(),
    });
    this.convertToBlob = vi.fn(async () => mockBlob);
  });
  // @ts-expect-error mock
  globalThis.FileReader = vi.fn(function (this: { result: string; onload: (() => void) | null }) {
    this.readAsDataURL = function (b: Blob) {
      setTimeout(() => {
        this.result = "data:image/jpeg;base64,ZmFrZS1qcGVn";
        this.onload?.();
      }, 0);
    };
  });
});

describe("cropBboxToJpegDataUrl", () => {
  it("returns JPEG dataURL", async () => {
    const out = await cropBboxToJpegDataUrl({
      sourceDataUrl: "data:image/png;base64,xxxx",
      bbox: { x: 10, y: 20, width: 100, height: 50 },
      devicePixelRatio: 2,
    });
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("multiplies bbox by devicePixelRatio for canvas size", async () => {
    const ctor = globalThis.OffscreenCanvas as unknown as ReturnType<typeof vi.fn>;
    await cropBboxToJpegDataUrl({
      sourceDataUrl: "data:image/png;base64,xxxx",
      bbox: { x: 0, y: 0, width: 100, height: 50 },
      devicePixelRatio: 2,
    });
    expect(ctor).toHaveBeenCalledWith(200, 100);
  });

  it("clamps zero-width bbox to 1x1", async () => {
    const ctor = globalThis.OffscreenCanvas as unknown as ReturnType<typeof vi.fn>;
    await cropBboxToJpegDataUrl({
      sourceDataUrl: "data:image/png;base64,xxxx",
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      devicePixelRatio: 1,
    });
    expect(ctor).toHaveBeenCalledWith(1, 1);
  });
});
