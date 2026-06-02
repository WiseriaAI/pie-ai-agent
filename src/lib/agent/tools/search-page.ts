import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { searchPageInjected, type SearchPageResult } from "../../dom-actions/search-page";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import { isRestrictedSchemeForGrouping } from "./tabs";
import { isPdfTab } from "@/lib/pdf/detect";

const DEFAULT_MAX = 10;

function escapeSearchPageAttribute(value: string | null | undefined): string {
  return escapeWrapperAttribute(value).replace(/&(?!(?:amp|lt|gt|quot);)/g, "&amp;");
}

interface SearchPageArgs {
  tabId?: number;
  query?: string | string[];
  max_results?: number;
  mode?: "all" | "interactive" | "text";
  regex?: boolean;
  search_by?: "text" | "role" | "tag" | "attribute";
}

export const searchPageTool: Tool = {
  name: "search_page",
  description:
    "Search the given tab's visible text for one or more terms and return matches with the " +
    "nearest interactive element index (data-pie-idx) plus a surrounding snippet — across all " +
    "frames, without read_page's 50KB truncation. Pass an array of terms to OR-search (expand an " +
    "abstract intent into synonyms in one call). Each match's pie_idx is non-empty when the hit " +
    "is in a clickable element (use it directly with click/type) or empty for plain text. " +
    "Note: matching is per-element direct text, so a phrase split across inline tags (e.g. <a>) " +
    "may need shorter keywords. For PDF tabs use search_pdf instead.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "integer", description: "Tab id to search." },
      query: {
        description: "One term (string) or several terms (array, OR-matched). Case-insensitive.",
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      max_results: {
        type: "integer",
        description: "Default 10. Capped at 50.",
        default: DEFAULT_MAX,
        minimum: 1,
        maximum: 50,
      },
      mode: {
        type: "string",
        enum: ["all", "interactive", "text"],
        description:
          "all (default) = all text; interactive = only text inside clickable elements; " +
          "text = only non-interactive body text.",
      },
      regex: {
        type: "boolean",
        description: "Default false (literal substring). true = each term is a regex (flags gi).",
      },
      search_by: {
        type: "string",
        enum: ["text", "role", "tag", "attribute"],
        description:
          "text (default) searches visible text. role/tag/attribute search element summaries, useful for blank editors such as role=textbox or tag=contenteditable.",
      },
    },
    required: ["tabId", "query"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as SearchPageArgs;
    if (typeof a.tabId !== "number") {
      return { success: false, error: "search_page requires a numeric tabId" };
    }
    const rawQueries = Array.isArray(a.query)
      ? a.query
      : typeof a.query === "string"
        ? [a.query]
        : [];
    const queries = rawQueries
      .map((q) => (typeof q === "string" ? q.trim() : ""))
      .filter((q) => q.length > 0);
    if (queries.length === 0) {
      return { success: false, error: "empty_query: provide at least one non-empty search term" };
    }
    const rawMax =
      typeof a.max_results === "number" && Number.isFinite(a.max_results)
        ? a.max_results
        : DEFAULT_MAX;
    const maxResults = Math.min(50, Math.max(1, Math.floor(rawMax)));
    const mode: "all" | "interactive" | "text" =
      a.mode === "interactive" || a.mode === "text" ? a.mode : "all";
    const regex = a.regex === true;
    const searchBy: "text" | "role" | "tag" | "attribute" =
      a.search_by === "role" || a.search_by === "tag" || a.search_by === "attribute"
        ? a.search_by
        : "text";

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(a.tabId);
    } catch {
      return { success: false, error: "Tab not found" };
    }
    if (isPdfTab(tab)) {
      return { success: false, error: "pdf_tab: This tab is a PDF. Use search_pdf instead." };
    }
    if (!tab.url || isRestrictedSchemeForGrouping(tab.url)) {
      return { success: false, error: "restrictedUrl: cannot read restricted-scheme tabs" };
    }
    if (tab.discarded) {
      return { success: false, error: "discardedTabRequiresActivation" };
    }

    let results: chrome.scripting.InjectionResult<SearchPageResult>[];
    try {
      results = (await chrome.scripting.executeScript({
        target: { tabId: a.tabId, allFrames: true },
        func: searchPageInjected,
        args: [{ queries, regex, mode, maxResults, searchBy }],
      })) as chrome.scripting.InjectionResult<SearchPageResult>[];
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
    }

    for (const r of results) {
      if (r.result?.invalidRegex) {
        return { success: false, error: `invalid_regex: ${r.result.invalidRegex}` };
      }
    }
    for (const r of results) {
      if (r.result?.invalidAttribute) {
        return { success: false, error: `invalid_attribute_query: ${r.result.invalidAttribute}` };
      }
    }

    const sorted = [...results].sort((x, y) => (x.frameId ?? 0) - (y.frameId ?? 0));
    const rows: { frameId: number; m: SearchMatchRow }[] = [];
    let total = 0;
    let timedOut = false;
    for (const r of sorted) {
      const data = r.result;
      if (!data) continue;
      total += data.total;
      if (data.timedOut) timedOut = true;
      for (const m of data.matches) {
        rows.push({ frameId: r.frameId ?? 0, m });
      }
    }

    if (total === 0) {
      return {
        success: true,
        observation:
          `<search_page total_matches="0" mode="${mode}" search_by="${searchBy}">` +
          `no matches</search_page>`,
      };
    }

    const shown = rows.slice(0, maxResults);
    const truncated = total > shown.length;

    const lines = shown.map((row) => {
      const idxAttr = row.m.pieIdx === null ? "" : String(row.m.pieIdx);
      const attrs = [
        `frame_id="${row.frameId}"`,
        `pie_idx="${idxAttr}"`,
        `tag="${escapeSearchPageAttribute(row.m.tag)}"`,
        `matched="${escapeSearchPageAttribute(row.m.matched)}"`,
      ];
      if (row.m.role) attrs.push(`role="${escapeSearchPageAttribute(row.m.role)}"`);
      if (row.m.name) attrs.push(`name="${escapeSearchPageAttribute(row.m.name)}"`);
      if (row.m.label) attrs.push(`label="${escapeSearchPageAttribute(row.m.label)}"`);
      if (row.m.placeholder) {
        attrs.push(`placeholder="${escapeSearchPageAttribute(row.m.placeholder)}"`);
      }
      if (row.m.type) attrs.push(`type="${escapeSearchPageAttribute(row.m.type)}"`);
      if (row.m.contenteditable) attrs.push(`contenteditable="true"`);
      return (
        `  <untrusted_page_match ${attrs.join(" ")}>` +
        `${escapeUntrustedWrappers(row.m.snippet)}</untrusted_page_match>`
      );
    });

    const headerAttrs = [`total_matches="${total}"`, `mode="${mode}"`, `search_by="${searchBy}"`];
    if (truncated) headerAttrs.push(`truncated="true"`);
    if (timedOut) headerAttrs.push(`timed_out="true"`);

    const observation =
      `<search_page ${headerAttrs.join(" ")}>\n` + `${lines.join("\n")}\n` + `</search_page>`;
    return { success: true, observation };
  },
};

type SearchMatchRow = SearchPageResult["matches"][number];
