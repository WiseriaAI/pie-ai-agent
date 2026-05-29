import type { ImageAttachment } from "@/lib/images";
import { resizePanel } from "@/lib/images/resize-panel";
import type { FileAttachment } from "./types";
import { classifyFile, MAX_FILE_BYTES } from "@/lib/file-read/classify";
import { sendToOffscreen } from "@/background/offscreen-manager";

const READ_MAX_CHARS = 200_000;

export type ProcessResult =
  | { ok: true; kind: "image"; attachment: ImageAttachment }
  | { ok: true; kind: "file"; attachment: FileAttachment }
  | { ok: false; reason: "too_large" | "no_vision" | "unsupported" | "error"; message: string };

let counter = 0;
function newId(): string { return `f${Date.now()}_${counter++}`; }

export async function processPickedFile(
  file: File, opts: { supportsVision: boolean },
): Promise<ProcessResult> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: `${file.name} exceeds 5MB` };
  }
  const kind = classifyFile(file.name, file.type);
  if (kind === "unsupported") {
    return { ok: false, reason: "unsupported", message: `${file.name}: unsupported type` };
  }
  if (kind === "image") {
    if (!opts.supportsVision) return { ok: false, reason: "no_vision", message: "current model has no vision" };
    const r = await resizePanel(file);
    if (!r.ok) return { ok: false, reason: "error", message: `image rejected: ${r.reason}` };
    const att: ImageAttachment = {
      kind: "image", id: newId(),
      mediaType: r.value.mediaType, data: r.value.data,
      width: r.value.width, height: r.value.height, byteLength: r.value.byteLength,
    };
    return { ok: true, kind: "image", attachment: att };
  }
  if (kind === "text") {
    const raw = await file.text();
    const truncated = raw.length > READ_MAX_CHARS;
    return {
      ok: true, kind: "file",
      attachment: {
        kind: "file", id: newId(), name: file.name, mime: file.type || "text/plain",
        text: truncated ? `${raw.slice(0, READ_MAX_CHARS)}\n…[truncated]` : raw,
        truncated, totalChars: raw.length, source: "picker",
      },
    };
  }
  // pdf
  try {
    const bytes = await file.arrayBuffer();
    const parsed = (await sendToOffscreen({
      type: "pdf:parse_bytes", bytes, cacheKey: `${file.name}:${file.size}`,
    })) as { pages: Array<{ page: number; text: string }>; total_pages: number };
    const joined = parsed.pages.map((p) => p.text).join("\n");
    const truncated = joined.length > READ_MAX_CHARS;
    return {
      ok: true, kind: "file",
      attachment: {
        kind: "file", id: newId(), name: file.name, mime: "application/pdf",
        text: truncated ? `${joined.slice(0, READ_MAX_CHARS)}\n…[truncated]` : joined,
        truncated, totalChars: joined.length, source: "picker",
      },
    };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
