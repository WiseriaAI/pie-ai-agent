/**
 * Image attachment IR shared between panel upload + SW screenshot tools.
 *
 * `ImageAttachment`  — has bytes (panel→SW direction immediately after upload,
 *                       or SW→panel immediately after screenshot pre-capture).
 * `ImagePlaceholder` — bytes stripped (chrome.storage / archived bundle / cache
 *                       miss after evict). Preserves identity so SW can
 *                       hydrate from cache when bytes are still in memory.
 */
export interface ImageAttachment {
  kind: "image";
  id: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string; // base64, post-resize
  width: number;
  height: number;
  byteLength: number; // post-resize raw bytes (not base64-inflated)
}

export interface ImagePlaceholder {
  kind: "image_placeholder";
  id: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

export type Attachment = ImageAttachment | ImagePlaceholder;

/**
 * SW per-session image cache row. Indexed by sessionId, ordered by `addedAt`
 * (older first). LRU eviction when bytes total > 30 MB OR > 3 image-bearing
 * user turns.
 */
export interface ImageRef {
  id: string;
  userTurnId: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string;
  width: number;
  height: number;
  byteLength: number;
  addedAt: number;
}

export interface ResizeResult {
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
  byteLength: number;
}
