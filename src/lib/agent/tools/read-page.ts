import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { pageSnapshotInjected, type PageSnapshotResult } from "../../dom-actions/page-snapshot";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import { isRestrictedSchemeForGrouping } from "./tabs";
import { isPdfTab } from "@/lib/pdf/detect";

const TOTAL_BUDGET_BYTES = 50_000;

interface ReadPageArgs { tabId: number; }

function classifyUnreachable(url: string, errorOccurred?: boolean): string {
  if (url.startsWith("chrome-extension://")) return "extension-child";
  if (url === "about:blank" && !errorOccurred) return "about-blank";
  if (errorOccurred) return "frame-error";
  return "sandbox";
}

export const readPageTool: Tool = {
  name: "read_page",
  description:
    "Read the given tab's HTML structure (interactive elements stamped with data-pie-idx, " +
    "shadow DOM traversed, scrollable regions noted). Returns per-frame HTML inside " +
    "<untrusted_page_content> wrappers plus a <frame_map>. " +
    "Call this before any click/type/select to get current element indices.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "integer", description: "Tab id to read." },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadPageArgs;
    if (typeof a.tabId !== "number") {
      return { success: false, error: "read_page requires a numeric tabId" };
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(a.tabId);
    } catch {
      return { success: false, error: "Tab not found" };
    }
    if (isPdfTab(tab)) {
      return {
        success: false,
        error:
          "pdf_tab: This tab is a PDF. Use read_pdf / search_pdf / get_pdf_outline instead.",
      };
    }
    if (!tab.url || isRestrictedSchemeForGrouping(tab.url)) {
      return { success: false, error: "restrictedUrl: cannot read restricted-scheme tabs" };
    }
    if (tab.discarded) {
      return { success: false, error: "discardedTabRequiresActivation" };
    }

    let results: chrome.scripting.InjectionResult<PageSnapshotResult>[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: a.tabId, allFrames: true },
        func: pageSnapshotInjected,
      }) as chrome.scripting.InjectionResult<PageSnapshotResult>[];
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
    }

    const frames = await chrome.webNavigation.getAllFrames({ tabId: a.tabId });
    if (!frames) return { success: false, error: "Tab unavailable" };

    const top = frames.find((f) => f.frameId === 0);
    const topUrl = top?.url ?? tab.url ?? "";

    function rewriteIframePlaceholders(parentFrameId: number, html: string): string {
      const childFrames = frames!
        .filter((f) => f.parentFrameId === parentFrameId)
        // Assumes child frame IDs increase in DOM iframe-position order. Chrome
        // assigns frameIds sequentially on first parse — holds in practice; may
        // drift if a child navigates and gets a new frameId.
        .sort((x, y) => x.frameId - y.frameId);
      // Regex depends on page-snapshot.ts stripping all non-whitelisted iframe
      // attributes — only data-pie-iframe-position survives, so [^>]* is safe.
      return html.replace(
        /<iframe([^>]*)data-pie-iframe-position="(\d+)"([^>]*)>([\s\S]*?)<\/iframe>/g,
        (_match, before, pos, after, _inner) => {
          const idx = Number(pos);
          const child = childFrames[idx];
          if (!child) {
            return `<iframe${before}${after}>[内容见 frame_map]</iframe>`;
          }
          const cleanedBefore = before.replace(/\s*data-pie-iframe-position="\d+"/g, "").trimEnd();
          const cleanedAfter = after.replace(/\s*data-pie-iframe-position="\d+"/g, "").trimEnd();
          const prefix = cleanedBefore ? `${cleanedBefore} ` : "";
          return `<iframe ${prefix}data-frame-id="${child.frameId}"${cleanedAfter}>[内容见 frame_id=${child.frameId}]</iframe>`;
        },
      );
    }

    let topOrigin: string | null = null;
    try { topOrigin = new URL(topUrl).origin; } catch { topOrigin = null; }

    const sortedFrames = [...frames].sort((a, b) => a.frameId - b.frameId);
    const frameMapLines: string[] = [];
    const blocks: string[] = [];
    const scrollableLines: string[] = [];
    let used = 0;
    let budgetExhausted = false;

    for (const f of sortedFrames) {
      const inj = results.find((r) => r.frameId === f.frameId);
      const data = inj?.result;
      let origin: string | null = null;
      try { origin = new URL(f.url).origin; if (origin === "null") origin = null; } catch {}
      const crossOrigin = topOrigin !== null && origin !== null && origin !== topOrigin;

      if (!data) {
        const reason = classifyUnreachable(f.url, f.errorOccurred);
        frameMapLines.push(
          `  frame_id="${f.frameId}" url="${escapeWrapperAttribute(f.url)}" unreachable="true" reason="${reason}"`,
        );
        const attrs = [
          `frame_id="${f.frameId}"`,
          `frame_url="${escapeWrapperAttribute(f.url)}"`,
          `unreachable="true"`,
          `reason="${reason}"`,
        ];
        blocks.push(`<untrusted_page_content ${attrs.join(" ")}></untrusted_page_content>`);
        continue;
      }

      const mapAttrs = [
        `frame_id="${f.frameId}"`,
        `url="${escapeWrapperAttribute(f.url)}"`,
      ];
      if (crossOrigin) mapAttrs.push(`cross_origin="true"`);
      frameMapLines.push("  " + mapAttrs.join(" "));

      for (const hint of data.scrollableHints) {
        scrollableLines.push(
          `  - ${hint.region}${hint.pieIdx !== null ? ` at data-pie-idx=${hint.pieIdx}` : ""}: ${hint.visibleCount} visible, estimated ${hint.estimatedTotal} total (frame_id=${f.frameId})`,
        );
      }

      const blockAttrs: string[] = [
        `frame_id="${f.frameId}"`,
      ];
      if (crossOrigin) blockAttrs.push(`cross_origin="true"`);

      if (budgetExhausted) {
        blockAttrs.push(`unread="budget"`);
        blocks.push(`<untrusted_page_content ${blockAttrs.join(" ")}></untrusted_page_content>`);
        continue;
      }

      let body = rewriteIframePlaceholders(f.frameId, data.html);
      const remaining = TOTAL_BUDGET_BYTES - used;
      let truncated = false;
      if (body.length > remaining) {
        // May cut mid-tag — LLM tolerates malformed HTML; truncation tradeoff
        // is documented in the spec.
        body = remaining > 0 ? body.slice(0, remaining) : "";
        truncated = true;
        budgetExhausted = true;
      }
      used += body.length;
      if (truncated) blockAttrs.push(`truncated="true"`);

      blocks.push(
        `<untrusted_page_content ${blockAttrs.join(" ")}>\n${escapeUntrustedWrappers(body)}\n</untrusted_page_content>`,
      );
    }

    const headerLines = [
      `Current URL: ${topUrl}`,
      `Page title: ${tab.title ?? ""}`,
      ``,
      `<frame_map>`,
      ...frameMapLines,
      `</frame_map>`,
    ];
    if (scrollableLines.length > 0) {
      headerLines.push("", "<scrollable_regions>", ...scrollableLines, "</scrollable_regions>");
    }

    const observation = headerLines.join("\n") + "\n\n" + blocks.join("\n");
    return { success: true, observation };
  },
};
