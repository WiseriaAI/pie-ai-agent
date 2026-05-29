import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sanitizeDownloadName } from "@/lib/files/download-name";

interface SaveArgs {
  filename?: string;
  content?: string;
  mime?: string;
  saveAs?: boolean;
}

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
    const filename = sanitizeDownloadName(typeof a.filename === "string" ? a.filename : "");
    const mime = typeof a.mime === "string" && a.mime ? a.mime : "text/plain";
    const saveAs = a.save_as === true || a.saveAs === true;
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(a.content)}`;
    try {
      await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs });
    } catch (e) {
      return { success: false, error: `download_failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return {
      success: true,
      observation: `Saved to Downloads/${filename}${saveAs ? " (user chose location via Save As)" : ""}. Note: if a same-named file existed, Chrome appended a numeric suffix.`,
    };
  },
};

export const LOCAL_FILE_TOOLS: Tool[] = [saveToDownloadsTool];
