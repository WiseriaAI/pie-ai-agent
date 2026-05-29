/**
 * Normalize an agent-supplied download name into a safe relative path under
 * `pie/`. Strips absolute-path leading slashes and `..` traversal so a
 * download can never escape the Downloads root.
 */
export function sanitizeDownloadName(raw: string): string {
  const segments = (raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segments[0] === "pie") segments.shift();
  const rel = segments.join("/");
  return rel.length > 0 ? `pie/${rel}` : "pie/untitled.txt";
}
