import { describe, it, expect, vi, beforeEach } from "vitest";
import { cropBboxToJpegDataUrl } from "./crop-bbox";

const mockBitmap = { close: vi.fn() } as unknown as ImageBitmap;
const mockBlob = new Blob(["fake-jpeg"], { type: "image/jpeg" });

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.createImageBitmap = vi.fn(async () => mockBitmap) as unknown as typeof createImageBitmap;
  globalThis.OffscreenCanvas = vi.fn(function (this: OffscreenCanvas, w: number, h: number) {
    this.width = w;
    this.height = h;
    (this as unknown as { getContext: () => { drawImage: ReturnType<typeof vi.fn> } }).getContext = () => ({
      drawImage: vi.fn(),
    });
    (this as unknown as { convertToBlob: ReturnType<typeof vi.fn> }).convertToBlob = vi.fn(async () => mockBlob);
  }) as unknown as typeof OffscreenCanvas;
  globalThis.FileReader = vi.fn(function (this: FileReader) {
    (this as unknown as { readAsDataURL: (b: Blob) => void }).readAsDataURL = function (b: Blob) {
      setTimeout(() => {
        (this as unknown as { result: string }).result = "data:image/jpeg;base64,ZmFrZS1qcGVn";
        (this as unknown as { onload: (() => void) | null }).onload?.();
      }, 0);
    };
  }) as unknown as typeof FileReader;
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
