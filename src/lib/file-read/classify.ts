export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB hard cap
export type FileKind = "text" | "pdf" | "image" | "unsupported";

const TEXT_EXTS = new Set([
  "txt","md","markdown","json","jsonl","csv","tsv","log","xml","yaml","yml",
  "html","htm","css","js","ts","tsx","jsx","py","rb","go","rs","java",
  "c","h","cpp","hpp","sh","toml","ini","env","sql",
]);
const IMAGE_MIMES = new Set(["image/jpeg","image/png","image/webp","image/gif"]);

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Decide how a picked/fetched file should be read. mime may be "" (file:// fetch often omits it). */
export function classifyFile(name: string, mime: string): FileKind {
  const e = ext(name);
  if (IMAGE_MIMES.has(mime) || ["jpg","jpeg","png","webp","gif"].includes(e)) return "image";
  if (mime === "application/pdf" || e === "pdf") return "pdf";
  if (mime.startsWith("text/") || TEXT_EXTS.has(e)) return "text";
  return "unsupported";
}
