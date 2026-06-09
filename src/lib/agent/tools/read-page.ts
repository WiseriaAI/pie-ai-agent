import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { probePageInjected, type ProbeResult } from "../../dom-actions/probe-core";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import { isRestrictedSchemeForGrouping } from "./tabs";
import { isPdfTab } from "@/lib/pdf/detect";
import { pageAtlasStore, parseOrigin, type PageAtlasState } from "./page-atlas";
import { renderPageAtlas } from "./page-atlas/render";

// read_page byte budgets per mode. Default is the hard cap — don't truncate
// by default; the LLM can still pass a smaller max_bytes to save tokens when
// it only needs a peek. interactive stays lower by design (it only needs the
// interactive index, not full body text).
const MODE_BUDGETS = {
  auto: { maxBytes: 500_000 },
  atlas: { maxBytes: 500_000 },
  interactive: { maxBytes: 200_000 },
  content: { maxBytes: 300_000 },
  full: { maxBytes: 500_000 },
} as const;

type ReadPageMode = keyof typeof MODE_BUDGETS;

interface ReadPageArgs {
  tabId: number;
  mode?: ReadPageMode;
  max_bytes?: number;
}

function normalizeMode(mode: unknown): ReadPageMode {
  return mode === "atlas" || mode === "interactive" || mode === "content" || mode === "full" ? mode : "auto";
}

function resolveHtmlBudget(mode: ReadPageMode, rawMaxBytes: unknown): number {
  const cfg = MODE_BUDGETS[mode];
  if (typeof rawMaxBytes !== "number" || !Number.isFinite(rawMaxBytes)) {
    return cfg.maxBytes;
  }
  return Math.max(1, Math.min(cfg.maxBytes, Math.floor(rawMaxBytes)));
}

function classifyUnreachable(url: string, errorOccurred?: boolean): string {
  if (url.startsWith("chrome-extension://")) return "extension-child";
  if (url === "about:blank" && !errorOccurred) return "about-blank";
  if (errorOccurred) return "frame-error";
  return "sandbox";
}

function attr(name: string, value: string | number | boolean): string {
  return `${name}="${escapeWrapperAttribute(String(value))}"`;
}

function elementText(value: string): string {
  return escapeWrapperAttribute(escapeUntrustedWrappers(value));
}

function wrapPageAtlasObservation(atlas: PageAtlasState, body: string): string {
  return [
    `<untrusted_page_content ${attr("tool", "read_page")} ${attr("mode", "atlas")} ${attr("atlas_id", atlas.atlasId)} ${attr("tab_id", atlas.tabId)}>`,
    body,
    "</untrusted_page_content>",
  ].join("\n");
}

function frameScopedId(frameId: number, id: string): string {
  return frameId === 0 ? id : `f${frameId}_${id}`;
}

function namespaceAtlasResult(data: Extract<ProbeResult, { op: "atlas" }>, frameId: number) {
  return {
    targets: data.targets.map((target) => ({
      ...target,
      id: frameScopedId(frameId, target.id),
      frameId,
      records: target.records?.map((record) => ({
        ...record,
        id: frameScopedId(frameId, record.id),
      })),
    })),
    controls: data.controls.map((control) => ({
      ...control,
      id: frameScopedId(frameId, control.id),
      frameId,
    })),
    forms: data.forms.map((form) => ({
      ...form,
      id: frameScopedId(frameId, form.id),
      frameId,
      fields: form.fields.map((field) => frameScopedId(frameId, field)),
      submitControlId: form.submitControlId ? frameScopedId(frameId, form.submitControlId) : undefined,
    })),
  };
}

type SnapshotResult = Extract<ProbeResult, { op: "snapshot" }>;

function interactivePriority(el: SnapshotResult["interactiveElements"][number]): number {
  const tag = el.tag.toLowerCase();
  const role = el.role.toLowerCase();
  if (el.contenteditable || tag === "input" || tag === "textarea" || role === "textbox") return 0;
  if (tag === "select" || role === "combobox" || role === "listbox") return 1;
  if (tag === "button" || role === "button") return 2;
  if (tag === "a" || role === "link") return 3;
  if (role || el.type || el.placeholder || el.label || el.name) return 4;
  return 5;
}

function renderInteractiveIndex(
  mode: ReadPageMode,
  frames: Array<{ frameId: number; crossOrigin: boolean; elements: SnapshotResult["interactiveElements"] }>,
): string {
  const all = frames.flatMap((f, frameOrder) =>
    f.elements.map((el, elementOrder) => ({
      frameId: f.frameId,
      crossOrigin: f.crossOrigin,
      el,
      order: frameOrder * 1_000_000 + elementOrder,
    })),
  );
  const selected = [...all].sort(
    (a, b) => interactivePriority(a.el) - interactivePriority(b.el) || a.order - b.order,
  );

  const lines = selected.slice(0, 300).map(({ frameId, crossOrigin, el }) => {
    const attrs = [
      attr("frame_id", frameId),
      attr("pie_idx", el.pieIdx),
      attr("tag", el.tag),
      attr("role", el.role),
    ];
    if (crossOrigin) attrs.push(attr("cross_origin", true));
    if (el.name) attrs.push(attr("name", el.name));
    if (el.placeholder) attrs.push(attr("placeholder", el.placeholder));
    if (el.label) attrs.push(attr("label", el.label));
    if (el.section) attrs.push(attr("section", el.section));
    if (el.type) attrs.push(attr("type", el.type));
    if (el.contenteditable) attrs.push(attr("contenteditable", true));
    if (el.disabled) attrs.push(attr("disabled", true));
    if (el.checked) attrs.push(attr("checked", true));
    if (el.selected) attrs.push(attr("selected", true));
    const text = el.text ? elementText(el.text) : "";
    return `  <interactive_element ${attrs.join(" ")}>${text}</interactive_element>`;
  });

  const header = [attr("mode", mode), attr("total", all.length)];
  if (all.length > lines.length) header.push(attr("truncated", true));
  return `<interactive_index ${header.join(" ")}>\n${lines.join("\n")}\n</interactive_index>`;
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function sliceUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let result = "";
  for (const ch of value) {
    const byteLength = utf8ByteLength(ch);
    if (used + byteLength > maxBytes) break;
    result += ch;
    used += byteLength;
  }
  return result;
}

export const readPageTool: Tool = {
  name: "read_page",
  description:
    "Inspect the given tab. Default/auto returns a compact Page Atlas for target discovery " +
    "and structured extraction. Do not use content/full as the first inspection step. " +
    "Use mode=interactive before click/type/select to get current element indices. " +
    "Use content/full only as an expensive fallback after atlas/target tools are insufficient, " +
    "or when the user explicitly asks to read or summarize full article/body text.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "integer", description: "Tab id to read." },
      mode: {
        type: "string",
        enum: ["auto", "atlas", "interactive", "content", "full"],
        description:
          "Read mode. auto is default and behaves like atlas. Use interactive for element indices. content/full are expensive fallbacks, not first-pass inspection modes.",
      },
      max_bytes: {
        type: "integer",
        minimum: 1,
        description: "Optional HTML/content byte budget hint, clamped by mode-specific hard caps.",
      },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ReadPageArgs;
    if (typeof a.tabId !== "number") {
      return { success: false, error: "read_page requires a numeric tabId" };
    }
    const mode = normalizeMode(a.mode);
    const totalBudgetBytes = resolveHtmlBudget(mode, a.max_bytes);

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

    if (mode === "atlas" || mode === "auto") {
      let atlasResults: chrome.scripting.InjectionResult<ProbeResult>[];
      try {
        atlasResults = await chrome.scripting.executeScript({
          target: { tabId: a.tabId, allFrames: true },
          func: probePageInjected,
          args: [{ op: "atlas" }],
        }) as chrome.scripting.InjectionResult<ProbeResult>[];
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
      }

      const frames = await chrome.webNavigation.getAllFrames({ tabId: a.tabId });
      if (!frames) return { success: false, error: "Tab unavailable" };

      const top = frames.find((f) => f.frameId === 0);
      const topUrl = top?.url ?? tab.url ?? "";
      const topAtlasResult = atlasResults.find((r) => r.frameId === 0)?.result;
      const topFingerprint = topAtlasResult?.op === "atlas"
        ? topAtlasResult.fingerprint
        : {
            url: topUrl,
            title: tab.title ?? "",
            bodyTextLengthBucket: 0,
            interactiveCountBucket: 0,
            topSectionCount: 0,
          };

      const atlasId = `atlas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const atlas: PageAtlasState = {
        atlasId,
        tabId: a.tabId,
        url: topUrl,
        origin: parseOrigin(topUrl),
        title: tab.title ?? topFingerprint.title,
        createdAt: Date.now(),
        fingerprint: topFingerprint,
        targets: [],
        controls: [],
        forms: [],
        controlGroups: [],
        navigation: [],
      };

      for (const result of atlasResults) {
        const data = result.result;
        if (data?.op !== "atlas") continue;
        const frameId = result.frameId;
        const scoped = namespaceAtlasResult(data, frameId);
        atlas.targets.push(...scoped.targets);
        atlas.controls.push(...scoped.controls);
        atlas.forms.push(...scoped.forms);
      }

      pageAtlasStore.save(atlas);
      return { success: true, observation: wrapPageAtlasObservation(atlas, renderPageAtlas(atlas)) };
    }

    let results: chrome.scripting.InjectionResult<ProbeResult>[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: a.tabId, allFrames: true },
        func: probePageInjected,
        args: [{ op: "snapshot" }],
      }) as chrome.scripting.InjectionResult<ProbeResult>[];
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
      // Regex depends on probe-core.ts stripping all non-whitelisted iframe
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
    const frameInteractive: Array<{
      frameId: number;
      crossOrigin: boolean;
      elements: SnapshotResult["interactiveElements"];
    }> = [];
    const blocks: string[] = [];
    const scrollableLines: string[] = [];
    let used = 0;
    let budgetExhausted = false;

    for (const f of sortedFrames) {
      const inj = results.find((r) => r.frameId === f.frameId);
      const rawData = inj?.result;
      const data = rawData?.op === "snapshot" ? rawData : undefined;
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
      frameInteractive.push({
        frameId: f.frameId,
        crossOrigin,
        elements: data.interactiveElements ?? [],
      });

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
      const remaining = totalBudgetBytes - used;
      let truncated = false;
      const bodyBytes = utf8ByteLength(body);
      if (bodyBytes > remaining) {
        // May cut mid-tag — LLM tolerates malformed HTML; truncation tradeoff
        // is documented in the spec.
        body = sliceUtf8(body, remaining);
        truncated = true;
        budgetExhausted = true;
      }
      used += utf8ByteLength(body);
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

    const observationParts = [
      headerLines.join("\n"),
      renderInteractiveIndex(mode, frameInteractive),
    ];
    if (scrollableLines.length > 0) {
      observationParts.push(`<scrollable_regions>\n${scrollableLines.join("\n")}\n</scrollable_regions>`);
    }
    observationParts.push(...blocks);

    const observation = observationParts.join("\n\n");
    return { success: true, observation };
  },
};
