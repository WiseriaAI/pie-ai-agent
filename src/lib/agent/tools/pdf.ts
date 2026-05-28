import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { sendToOffscreen } from "@/background/offscreen-manager";
import { isPdfTab } from "@/lib/pdf/detect";
import { parsePageRange } from "@/lib/pdf/page-range";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "../untrusted-wrappers";

const DEFAULT_MAX_CHARS = 8000;
const HARD_MAX_PAGES_PER_CALL = 50; // safety: huge spec like "1-9999" is sliced down

interface ReadPdfArgs {
  page_range?: string;
  max_chars?: number;
}

async function resolveActivePdfTab(
  tabId: number,
): Promise<
  | { ok: true; url: string }
  | { ok: false; error: string }
> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "tab_missing: pinned tab no longer exists" };
  }
  if (!isPdfTab(tab)) {
    return {
      ok: false,
      error: `not_a_pdf: tab url=${tab.url ?? "<unknown>"} does not look like a PDF`,
    };
  }
  if (tab.url!.startsWith("file://")) {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess();
    if (!allowed) {
      return {
        ok: false,
        error:
          "file_access_denied: enable Allow access to file URLs in chrome://extensions to read local PDFs",
      };
    }
  }
  return { ok: true, url: tab.url! };
}

function buildReadObservation(
  pages: Array<{ page: number; text: string }>,
  totalPages: number,
  maxChars: number,
): string {
  let used = 0;
  let truncated = false;
  const blocks: string[] = [];
  for (const p of pages) {
    if (used >= maxChars) {
      truncated = true;
      break;
    }
    const remaining = maxChars - used;
    if (p.text.length > remaining) {
      truncated = true;
      break; // cut at page boundary, don't take a partial page
    }
    used += p.text.length;
    blocks.push(
      `<untrusted_pdf_page page="${p.page}">\n${escapeUntrustedWrappers(p.text)}\n</untrusted_pdf_page>`,
    );
  }
  const header =
    `<read_pdf total_pages="${totalPages}" truncated="${truncated ? "true" : "false"}">`;
  return `${header}\n${blocks.join("\n")}\n</read_pdf>`;
}

export const readPdfTool: Tool = {
  name: "read_pdf",
  description:
    "Read text content from the PDF in the active pinned tab. Returns text per page, " +
    "preserving reading order. Use page_range to read specific pages. Use this instead of " +
    "read_page when the pinned tab is a PDF.",
  parameters: {
    type: "object",
    properties: {
      page_range: {
        type: "string",
        description:
          'Page range, 1-indexed. Examples: "1", "1-3", "1,3,5", "1-3,7". Omit for first page only.',
      },
      max_chars: {
        type: "integer",
        description: "Truncate result to this many characters total. Default 8000.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadPdfArgs;
    const tab = await resolveActivePdfTab(ctx.tabId);
    if (!tab.ok) return { success: false, error: tab.error };

    const maxChars =
      typeof a.max_chars === "number" && a.max_chars > 0
        ? Math.floor(a.max_chars)
        : DEFAULT_MAX_CHARS;

    // Need total_pages to drive parsePageRange. Ask offscreen for the outline
    // (cached after the first call), then issue the read_page call.
    let totalPages: number;
    try {
      const outline = (await sendToOffscreen({
        type: "pdf:outline",
        url: tab.url,
      })) as { total_pages: number };
      totalPages = outline.total_pages;
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    const wanted = parsePageRange(a.page_range, totalPages).slice(0, HARD_MAX_PAGES_PER_CALL);
    if (wanted.length === 0) {
      return {
        success: true,
        observation: `<read_pdf total_pages="${totalPages}" truncated="false"></read_pdf>`,
      };
    }

    let payload: { pages: Array<{ page: number; text: string }>; total_pages: number };
    try {
      payload = (await sendToOffscreen({
        type: "pdf:read_page",
        url: tab.url,
        pages: wanted,
      })) as typeof payload;
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    return {
      success: true,
      observation: buildReadObservation(payload.pages, payload.total_pages, maxChars),
    };
  },
};

const DEFAULT_SEARCH_MAX = 10;

interface SearchPdfArgs {
  query?: string;
  max_results?: number;
}

export const searchPdfTool: Tool = {
  name: "search_pdf",
  description:
    "Full-text search the PDF in the active pinned tab. Returns matching pages with " +
    "surrounding snippets. Use this to find specific terms in large PDFs before reading full pages.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term (case-insensitive substring match).",
      },
      max_results: {
        type: "integer",
        description: "Default 10. Capped at 50.",
        default: DEFAULT_SEARCH_MAX,
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as SearchPdfArgs;
    const query = typeof a.query === "string" ? a.query.trim() : "";
    if (!query) {
      return { success: false, error: "empty_query: provide a non-empty search term" };
    }
    const rawMax =
      typeof a.max_results === "number" && Number.isFinite(a.max_results)
        ? a.max_results
        : DEFAULT_SEARCH_MAX;
    const maxResults = Math.min(50, Math.max(1, Math.floor(rawMax)));

    const tab = await resolveActivePdfTab(ctx.tabId);
    if (!tab.ok) return { success: false, error: tab.error };

    let payload: {
      matches: Array<{ page: number; snippet: string; match_offset: number }>;
      total_matches: number;
    };
    try {
      payload = (await sendToOffscreen({
        type: "pdf:search",
        url: tab.url,
        query,
        maxResults,
      })) as typeof payload;
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (payload.matches.length === 0) {
      return {
        success: true,
        observation: `<search_pdf query="${escapeWrapperAttribute(query)}" total_matches="0">no matches</search_pdf>`,
      };
    }

    const rows = payload.matches
      .map(
        (m) =>
          `  <untrusted_pdf_match page="${m.page}" offset="${m.match_offset}">${escapeUntrustedWrappers(m.snippet)}</untrusted_pdf_match>`,
      )
      .join("\n");

    const observation =
      `<search_pdf query="${escapeWrapperAttribute(query)}" total_matches="${payload.total_matches}">\n` +
      `${rows}\n` +
      `</search_pdf>`;

    return { success: true, observation };
  },
};

export const PDF_TOOLS: Tool[] = [readPdfTool, searchPdfTool];
