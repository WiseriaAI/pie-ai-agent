import {
  computeTargetSize,
  validateDecodedDimensions,
  validateInputBounds,
  type ValidateResult,
} from "./validate";
import type { ResizeResult } from "./types";

const JPEG_QUALITY = 0.85;

export type ResizePanelOutcome =
  | { ok: true; value: ResizeResult }
  // Use intersection to extract the reason from the failure variant of ValidateResult.
  // Conditional `ValidateResult extends {ok:false}` does NOT distribute and resolves to
  // never; intersection is the correct idiom here.
  | { ok: false; reason: (ValidateResult & { ok: false })["reason"] };

/**
 * Panel-side resize using DOM Canvas. EXIF stripped naturally because
 * canvas re-encode discards source metadata. JPEG quality 0.85.
 *
 * Budget: ≤ 1.5 s for 5 MB / 5000 px input on M1-class hardware.
 *
 * Note: gif uploads decode the first frame only. Animated content is
 * not preserved — this is an accepted v1 tradeoff (vision providers
 * generally accept first frame anyway).
 */
export async function resizePanel(file: File): Promise<ResizePanelOutcome> {
  const v0 = validateInputBounds({
    byteLength: file.size,
    mediaType: file.type,
  });
  if (!v0.ok) return { ok: false, reason: v0.reason };

  let dataUrl: string;
  try {
    dataUrl = await readAsDataURL(file);
  } catch {
    return { ok: false, reason: "decode-failed" };
  }
  const img = await decodeImage(dataUrl);
  if (!img) return { ok: false, reason: "decode-failed" };

  const v1 = validateDecodedDimensions({ width: img.width, height: img.height });
  if (!v1.ok) return { ok: false, reason: v1.reason };

  const target = computeTargetSize(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, reason: "decode-failed" };
  ctx.drawImage(img, 0, 0, target.width, target.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) return { ok: false, reason: "decode-failed" };

  let data: string;
  try {
    data = await blobToBase64(blob);
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
      byteLength: blob.size,
    },
  };
}

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await readAsDataURL(blob);
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}
