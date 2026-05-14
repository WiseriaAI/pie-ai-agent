type Input = {
  sourceDataUrl: string;
  bbox: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
};

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function cropBboxToJpegDataUrl({
  sourceDataUrl,
  bbox,
  devicePixelRatio,
}: Input): Promise<string> {
  const sourceBlob = await dataUrlToBlob(sourceDataUrl);
  const bitmap = await createImageBitmap(sourceBlob);
  const dpr = Math.max(devicePixelRatio, 1);
  const w = Math.max(1, Math.round(bbox.width * dpr));
  const h = Math.max(1, Math.round(bbox.height * dpr));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(
    bitmap,
    bbox.x * dpr,
    bbox.y * dpr,
    bbox.width * dpr,
    bbox.height * dpr,
    0,
    0,
    w,
    h,
  );
  (bitmap as ImageBitmap & { close?: () => void }).close?.();
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return blobToDataUrl(outBlob);
}
