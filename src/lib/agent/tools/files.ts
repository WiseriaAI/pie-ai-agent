import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import type { FileArtifact } from "@/background/output-cache";
import { sanitizeDownloadName } from "@/lib/files/download-name";
import { sendToOffscreen } from "@/background/offscreen-manager";
import { classifyFile, MAX_FILE_BYTES } from "@/lib/file-read/classify";
import { arrayBufferToBase64 } from "@/lib/files/base64";
import { escapeUntrustedWrappers } from "../untrusted-wrappers";
import { buildLocalFileWrapper } from "@/lib/files/inject";

interface OutputArgs { filename?: string; content?: string; mime?: string; }

// Allowlist of text-family MIME types. A hallucinating LLM could otherwise
// pass e.g. text/html; the eventual download builds a data: URL from this mime
// (SW download routing), so the broad `text/*` branch explicitly excludes
// html/xhtml to keep the saved file from being treated as renderable markup.
const SAFE_MIME = /^(text\/(?!html|xhtml)|application\/(json|xml|csv|x-ndjson))/;

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export interface OutputFileDeps {
  sessionId: string;
  store: (a: FileArtifact) => void;
}

/**
 * output_file — produce a downloadable text artifact. Stores content in the
 * SW output-cache and returns `fileOutput` so the panel can render a card;
 * the actual chrome.downloads call happens later when the user clicks the
 * card's download button (SW routes `download-output`). Dep-injected with
 * sessionId + store because it needs runtime state — NOT in the static
 * LOCAL_FILE_TOOLS array (mirrors buildRequestLocalFileTool).
 */
export function buildOutputFileTool(deps: OutputFileDeps): Tool {
  return {
    name: "output_file",
    description:
      "Produce a text file (report, code, markdown, CSV, JSON) and present it to the user " +
      "as a downloadable card in the side panel. The user decides whether to download it and " +
      "picks the save location themselves — you do NOT save to disk directly, so do not assume " +
      "the file was saved. Cannot write to arbitrary absolute paths; the name is always under pie/.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: 'Relative file name, e.g. "report.md" or "notes/summary.md". Always presented under pie/.' },
        content: { type: "string", description: "The text content of the file." },
        mime: { type: "string", description: 'MIME type. Default "text/plain".' },
      },
      required: ["filename", "content"],
      additionalProperties: false,
    },
    handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      const a = (args ?? {}) as OutputArgs;
      if (typeof a.content !== "string") return { success: false, error: "content is required (string)" };
      // Cap on actual UTF-8 byte size (not UTF-16 code-unit count) so the 5MB
      // limit is byte-accurate for multibyte content; byteLength is reused below.
      const byteLength = new Blob([a.content]).size;
      if (byteLength > MAX_CONTENT_BYTES) return { success: false, error: `content_too_large: max ${MAX_CONTENT_BYTES / 1024 / 1024}MB` };
      const rawFilename = typeof a.filename === "string" ? a.filename : "";
      const filename = sanitizeDownloadName(rawFilename);
      const mime = typeof a.mime === "string" && SAFE_MIME.test(a.mime) ? a.mime : "text/plain";
      const id = crypto.randomUUID();
      deps.store({ id, sessionId: deps.sessionId, filename, mime, content: a.content, byteLength, addedAt: Date.now() });
      const renameNote =
        filename === "pie/untitled.txt" && rawFilename !== "pie/untitled.txt"
          ? " (filename was sanitized to untitled.txt)"
          : "";
      return {
        success: true,
        observation:
          `Presented "${filename}" to the user as a downloadable card in the side panel. ` +
          `The user will choose whether to download it and where to save it. ` +
          `Do not assume it has been saved.${renameNote}`,
        fileOutput: { id, filename, mime, size: byteLength },
      };
    },
  };
}

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
        observation: buildLocalFileWrapper({ name, mime: mime || "text/plain", text: body, truncated }),
      };
    }

    // pdf
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) return { success: false, error: `too_large: exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB cap` };
    try {
      const parsed = (await sendToOffscreen({ type: "pdf:parse_bytes", base64: arrayBufferToBase64(bytes), cacheKey: uri })) as { pages: Array<{ page: number; text: string }>; total_pages: number };
      const joinedFull = parsed.pages.map((p) => p.text).join("\n");
      const truncated = joinedFull.length > READ_MAX_CHARS;
      const body = truncated ? `${joinedFull.slice(0, READ_MAX_CHARS)}\n…[truncated]` : joinedFull;
      return {
        success: true,
        observation: buildLocalFileWrapper({ name, mime: "application/pdf", text: body, truncated, totalPages: parsed.total_pages }),
      };
    } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  },
};

export const LOCAL_FILE_TOOLS: Tool[] = [readLocalFileTool];

// ── request_local_file — human-in-the-loop file picker ──────────────────────
//
// Unlike read_local_file (which fetches a file:// URI directly), this tool
// asks the user to pick a file via the side panel. The handler is dep-injected
// in loop.ts with `requestFile` bound to requestLocalFileFromPanel (the SW↔panel
// round-trip in src/lib/local-file-request.ts). Because it needs runtime deps,
// it is NOT part of the static LOCAL_FILE_TOOLS array.

export interface RequestLocalFileDeps {
  sessionId: string;
  requestFile: (sessionId: string) => Promise<{
    name: string;
    mime: string;
    text: string;
    truncated: boolean;
  }>;
}

export function buildRequestLocalFileTool(deps: RequestLocalFileDeps): Tool {
  return {
    name: "request_local_file",
    description:
      "Prompt the user to pick a local file (text/code or PDF) via the side panel, and return " +
      "its extracted text. Use this when you need a file's contents but don't have its path — " +
      "the user chooses the file themselves. Requires the side panel to be open. For images, " +
      "ask the user to attach them via the + menu instead (images can't be returned here).",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    handler: async (_args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
      try {
        const f = await deps.requestFile(deps.sessionId);
        return {
          success: true,
          observation: buildLocalFileWrapper({ name: f.name, mime: f.mime || "text/plain", text: f.text, truncated: f.truncated }),
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          error: `Could not get a file from the user (${reason}). You can ask them to attach the file using the attach (+) button in the chat, or if you know the file's path, call read_local_file with a file:// URI.`,
        };
      }
    },
  };
}
