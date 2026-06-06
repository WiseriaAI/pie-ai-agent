const LABELS: Record<string, string> = {
  "text/markdown": "MARKDOWN",
  "text/plain": "TEXT",
  "text/csv": "CSV",
  "application/json": "JSON",
  "application/xml": "XML",
  "text/xml": "XML",
  "application/x-ndjson": "NDJSON",
};

/** mime → short uppercase label for the file card meta line. */
export function mimeLabel(mime: string): string {
  if (!mime) return "FILE";
  const known = LABELS[mime.toLowerCase()];
  if (known) return known;
  const sub = mime.split("/")[1]?.split(";")[0]?.trim();
  return sub ? sub.toUpperCase() : "FILE";
}

/** bytes → "12.0 KB" style human size. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
