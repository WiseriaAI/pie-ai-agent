import {
  computeTargetSize,
  validateDecodedDimensions,
  validateInputBounds,
  type ValidateResult,
} from "./validate";
import type { ResizeResult } from "./types";

const JPEG_QUALITY = 0.85;

export type ResizeSWOutcome =
  | { ok: true; value: ResizeResult }
  // Use intersection to extract the reason from the failure variant of ValidateResult.
  // Conditional `ValidateResult extends {ok:false}` does NOT distribute and resolves to
  // never; intersection is the correct idiom here.
  | { ok: false; reason: (ValidateResult & { ok: false })["reason"] };

/**
 * SW-side resize using OffscreenCanvas + createImageBitmap. Used by:
 *   - capture_visible_tab handler (post chrome.tabs.captureVisibleTab)
 *   - capture_fullpage_tab handler (post CDP Page.captureScreenshot)
 *
 * Budget: ≤ 0.5 s for 5 MB input on M1-class hardware. EXIF stripped via
 * re-encode (createImageBitmap discards EXIF). JPEG quality 0.85.
 *
 * MV3 SW has no DOM, so DOM Canvas is unavailable here.
 *
 * Totality contract: every failure path resolves to {ok:false, reason},
 * never throws. Mirrors resizePanel's discriminated-union shape.
 */
export async function resizeSW(blob: Blob): Promise<ResizeSWOutcome> {
  const v0 = validateInputBounds({
    byteLength: blob.size,
    mediaType: blob.type || "image/jpeg",
  });
  if (!v0.ok) return { ok: false, reason: v0.reason };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { ok: false, reason: "decode-failed" };
  }

  const v1 = validateDecodedDimensions({ width: bitmap.width, height: bitmap.height });
  if (!v1.ok) {
    bitmap.close();
    return { ok: false, reason: v1.reason };
  }

  const target = computeTargetSize(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    bitmap.close();
    return { ok: false, reason: "decode-failed" };
  }
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();

  let out: Blob;
  try {
    out = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  } catch {
    return { ok: false, reason: "decode-failed" };
  }

  let data: string;
  try {
    data = await blobToBase64(out);
  } catch {
    return { ok: false, reason: "decode-failed" };
  }

  return {
    ok: true,
    value: {
      data,
      mediaType: "image/jpeg",
      width: target.width,
      height: target.height,
      byteLength: out.size,
    },
  };
}

// I-2 pattern from Task 2 follow-up: reuse FileReader.readAsDataURL + prefix
// slice instead of String.fromCharCode loop. FileReader is available in MV3
// SW (Web Workers API global, not DOM-specific).
function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await readAsDataURL(blob);
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}
