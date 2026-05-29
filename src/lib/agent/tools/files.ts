import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sanitizeDownloadName } from "@/lib/files/download-name";
import { sendToOffscreen } from "@/background/offscreen-manager";
import { classifyFile, MAX_FILE_BYTES } from "@/lib/file-read/classify";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "../untrusted-wrappers";

interface SaveArgs {
  filename?: string;
  content?: string;
  mime?: string;
  saveAs?: boolean;
}

// Allowlist of text-family MIME types. A hallucinating LLM could otherwise
// pass e.g. text/html, turning the data: URL into something renderable, so
// the broad `text/*` branch explicitly excludes html/xhtml.
const SAFE_MIME = /^(text\/(?!html|xhtml)|application\/(json|xml|csv|x-ndjson))/;

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export const saveToDownloadsTool: Tool = {
  name: "save_to_downloads",
  description:
    "Write text content to the user's local Downloads folder under a 'pie/' subfolder. " +
    "Use for saving generated reports, code, or markdown. Set save_as=true to let the user " +
    "pick the location via a Save As dialog. Cannot write to arbitrary absolute paths.",
  parameters: {
    type: "object",
    properties: {
      filename: { type: "string", description: 'Relative file name, e.g. "report.md" or "notes/summary.md". Always saved under pie/.' },
      content: { type: "string", description: "The text content to write." },
      mime: { type: "string", description: 'MIME type. Default "text/plain".' },
      save_as: { type: "boolean", description: "If true, prompt the user with a Save As dialog. Default false." },
    },
    required: ["filename", "content"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as SaveArgs & { save_as?: boolean };
    if (typeof a.content !== "string") {
      return { success: false, error: "content is required (string)" };
    }
    if (a.content.length > MAX_CONTENT_BYTES) {
      return { success: false, error: `content_too_large: max ${MAX_CONTENT_BYTES / 1024 / 1024}MB` };
    }
    const rawFilename = typeof a.filename === "string" ? a.filename : "";
    const filename = sanitizeDownloadName(rawFilename);
    const mime = typeof a.mime === "string" && SAFE_MIME.test(a.mime) ? a.mime : "text/plain";
    const saveAs = a.save_as === true || a.saveAs === true;
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(a.content)}`;
    try {
      await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs });
    } catch (e) {
      return { success: false, error: `download_failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    // Signal when the caller's name was discarded for the safe fallback so the
    // LLM knows the file isn't where it asked.
    const sanitizedToFallback = filename === "pie/untitled.txt" && rawFilename !== "pie/untitled.txt";
    const renameNote = sanitizedToFallback ? " (filename was sanitized to untitled.txt)" : "";
    return {
      success: true,
      observation: `Saved to Downloads/${filename}${
        saveAs
          ? " (user chose location via Save As)"
          : ". Note: if a same-named file existed, Chrome appended a numeric suffix."
      }${renameNote}`,
    };
  },
};

const READ_MAX_CHARS = 200_000; // injected-text safety ceiling (well below 5MB)

function normalizeFileUri(uri: string): string {
  const u = uri.trim();
  if (u.startsWith("file://")) return u;
  if (u.startsWith("/")) return `file://${u}`;
  return u;
}

function basename(uri: string): string {
  const noQuery = uri.split(/[?#]/)[0];
  const parts = noQuery.split("/").filter(Boolean);
  let raw = parts[parts.length - 1] ?? "file";
  if (raw.endsWith(":")) raw = "file"; // e.g. "file:" from file:///
  try { return decodeURIComponent(raw); } catch { return raw; }
}

interface ReadLocalArgs { uri?: string }

export const readLocalFileTool: Tool = {
  name: "read_local_file",
  description:
    "Read a local file by its file:// URI (or absolute path) and return its text. Works for " +
    "text/code files and PDFs. The user must have enabled 'Allow access to file URLs' for the " +
    "extension. For images, ask the user to attach them via the + menu instead.",
  parameters: {
    type: "object",
    properties: { uri: { type: "string", description: 'A file:// URI or absolute path, e.g. "file:///Users/me/notes.md".' } },
    required: ["uri"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadLocalArgs;
    if (typeof a.uri !== "string" || !a.uri.trim()) return { success: false, error: "uri is required" };
    const uri = normalizeFileUri(a.uri);
    if (!uri.startsWith("file://")) {
      return { success: false, error: `invalid_uri: read_local_file only accepts file:// URIs or absolute paths; got "${uri.slice(0, 80)}"` };
    }
    const allowed = await chrome.extension.isAllowedFileSchemeAccess();
    if (!allowed) return { success: false, error: "file_access_denied: enable 'Allow access to file URLs' in chrome://extensions to read local files" };
    let res: Response;
    try { res = await fetch(uri); }
    catch (e) { return { success: false, error: `fetch_failed: ${e instanceof Error ? e.message : String(e)}` }; }
    if (!res.ok) return { success: false, error: `fetch_failed: status ${res.status}` };

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_FILE_BYTES) {
      return { success: false, error: `too_large: exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB cap` };
    }

    const name = basename(uri);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const kind = classifyFile(name, mime);

    if (kind === "image") return { success: false, error: "image_via_picker: cannot return images through read_local_file; ask the user to attach the image via the + menu." };
    if (kind === "unsupported") return { success: false, error: `unsupported_type: ${escapeUntrustedWrappers(name)} (${escapeUntrustedWrappers(mime || "unknown")})` };

    if (kind === "text") {
      const text = await res.text();
      if (text.length > MAX_FILE_BYTES) {
        return { success: false, error: `too_large: exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB cap` };
      }
      const truncated = text.length > READ_MAX_CHARS;
      const body = truncated ? `${text.slice(0, READ_MAX_CHARS)}\n…[truncated]` : text;
      return {
        success: true,
        observation:
          `<untrusted_local_file name="${escapeWrapperAttribute(name)}" mime="${escapeWrapperAttribute(mime || "text/plain")}" truncated="${truncated}">\n` +
          `${escapeUntrustedWrappers(body)}\n</untrusted_local_file>`,
      };
    }

    // pdf
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) return { success: false, error: `too_large: exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB cap` };
    try {
      const parsed = (await sendToOffscreen({ type: "pdf:parse_bytes", bytes, cacheKey: uri })) as { pages: Array<{ page: number; text: string }>; total_pages: number };
      const joined = parsed.pages.map((p) => p.text).join("\n").slice(0, READ_MAX_CHARS);
      return {
        success: true,
        observation:
          `<untrusted_local_file name="${escapeWrapperAttribute(name)}" mime="application/pdf" total_pages="${parsed.total_pages}">\n` +
          `${escapeUntrustedWrappers(joined)}\n</untrusted_local_file>`,
      };
    } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  },
};

export const LOCAL_FILE_TOOLS: Tool[] = [saveToDownloadsTool, readLocalFileTool];
