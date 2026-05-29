import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sanitizeDownloadName } from "@/lib/files/download-name";

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

export const LOCAL_FILE_TOOLS: Tool[] = [saveToDownloadsTool];
