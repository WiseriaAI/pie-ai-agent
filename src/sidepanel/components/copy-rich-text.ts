/**
 * Copy a rendered reply to the clipboard as rich text.
 *
 * Writes both `text/html` (semantic tags — `<strong>`/`<ul>`/`<h1>`/`<table>`
 * …) and a `text/plain` fallback via a single `ClipboardItem`, so pasting into
 * a rich-text editor (Word / Notion / Gmail / Feishu) keeps formatting while a
 * plain-text editor still gets readable text. When `ClipboardItem` / the rich
 * `clipboard.write` path is unavailable (denied permission, older environment),
 * falls back to `clipboard.writeText` with the plain text.
 *
 * @returns `true` if either write path succeeded, `false` if the clipboard was
 *   fully unavailable (so callers can leave their "copied" affordance untouched).
 */
export async function copyRichText(html: string, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return true;
  } catch {
    // Rich write unavailable — fall back to plain text.
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
