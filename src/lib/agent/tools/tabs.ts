import type { ActionResult } from "../../dom-actions/types";
import type { ConfirmedTabTarget, Tool, ToolHandlerContext } from "../types";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "../untrusted-wrappers";
import { waitForUrlSettle } from "../wait-for-url-settle";

/**
 * Phase 3 — parse a chrome.tabs.Tab.url into an origin string. Returns ""
 * for unparseable / restricted URLs so the caller can compare against the
 * confirm-time origin without false positives. Inline (not imported from
 * loop.ts) because tabs.ts handlers are agent-runtime code; loop.ts is the
 * SW dispatch surface — keeping origin parsing local avoids a cycle.
 */
function parseTabOrigin(url: string | undefined): string {
  if (!url) return "";
  try {
    const o = new URL(url).origin;
    if (!o || o === "null") return "";
    return o;
  } catch {
    return "";
  }
}

/**
 * Phase 3 K-8 — confirm-time origin re-verify. Compares the LIVE tab origin
 * (chrome.tabs.get inside the handler) against the map carried via ctx
 * (what the user saw on the confirm card). Returns:
 *   - { ok: true, tab } when the tab still exists AND its origin matches
 *     what the user approved
 *   - { ok: false, reason: "missing" | "navigated" | "no-confirm-record" }
 *     otherwise
 *
 * Handlers use this BEFORE calling chrome.tabs.{remove, group, ungroup,
 * move, update} on a target id — skip the id and report it in the
 * partial-completion observation when ok=false.
 */
async function verifyConfirmedOrigin(
  tabId: number,
  confirmed: Map<number, ConfirmedTabTarget> | undefined,
): Promise<
  | { ok: true; tab: chrome.tabs.Tab; origin: string }
  | { ok: false; reason: "missing" | "navigated" | "no-confirm-record" }
> {
  if (!confirmed) {
    // Confirm layer removed — no per-call confirmation record. Verify the
    // tab still exists but don't gate on origin.
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return { ok: false, reason: "missing" };
    }
    const currentOrigin = parseTabOrigin(tab.url);
    if (!currentOrigin) {
      return { ok: false, reason: "missing" };
    }
    return { ok: true, tab, origin: currentOrigin };
  }
  const expected = confirmed.get(tabId);
  if (!expected) {
    return { ok: false, reason: "no-confirm-record" };
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const live = parseTabOrigin(tab.url);
  if (!live || live !== expected.origin) {
    return { ok: false, reason: "navigated" };
  }
  return { ok: true, tab, origin: live };
}

/**
 * Phase 3 cross-tab tools. Implementation lands incrementally:
 *  - Unit 1 (this file's first version): list_tabs only
 *  - Unit 3 will add close_tabs, activate_tab
 *  - Unit 4 will add group_tabs, ungroup_tabs, move_tabs
 *
 * All tools share the per-call cross-origin args introspection in risk.ts
 * (Phase 3 invariant P3-A) — each handler is responsible for its own stale
 * tab detection and partial-completion semantics (P3-H), but the loop's
 * confirm wire shape (Unit 2) carries the multi-tab informed-approval
 * payload uniformly.
 *
 * G-1 acceptance gate: any new entry here MUST also be added to TAB_TOOL_NAMES
 * in tool-names.ts AND have a matching always-high (or args-introspection)
 * branch in risk.ts. If a future PR adds a low-risk cross-tab tool, it must
 * first upgrade SkillDefinition.allowedTools schema (see plan K-3 / G-1).
 */

const TITLE_MAX_LEN = 100;
const DOMAIN_MAX_LEN = 50;
// Intentional SUPERSET of the canonical `isRestrictedUrl`
// (src/lib/url/restricted.ts): this list adds `chrome-search://` and
// `view-source:` because tab-grouping operates on arbitrary user tabs that may
// sit on those schemes, whereas the loop's pin-gate never encounters them. It
// must remain a superset — every scheme rejected by the canonical check is also
// rejected here (a scheme rejected by the loop but accepted here would let
// group_tabs touch local-file / blob: pages the agent should never touch). The
// canonical list is NOT imported directly because this constant is also read
// inside a `chrome.scripting`-injected self-contained function (must stay
// closure-free); the file-PDF exception is deliberately dropped here since
// grouping a file PDF tab is harmless metadata-only.
//
// Follow-up (deferred, low risk): a build-time assertion that this array is a
// superset of the canonical scheme set would mechanically guard the invariant.
const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "chrome-search://",
  "edge://",
  "about:",
  "data:",
  "javascript:",
  "view-source:",
  "file://",
  "blob:",
];

// Strip control chars except tab (\x09) and the line breaks we replace
// before this — \n \r \v \f are handled separately because we replace
// them with spaces (preserves word boundaries) instead of stripping.
// \x7f is DEL.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const LINE_BREAK_RE = /[\n\r\v\f]/g;

interface ListTabsArgs {
  scope?: "currentWindow" | "allWindows";
  limit?: number;
}

interface TabMetadataEntry {
  id: number;
  title: string;
  domain: string;
  active: boolean;
  pinned: boolean;
  groupId: number; // -1 = no group
  lastAccessed?: number;
  windowId: number;
}

function sanitizeTabTitle(rawTitle: string | undefined): string {
  if (!rawTitle) return "(untitled)";
  // 1. Replace line breaks with spaces — wrapper output is line-oriented
  //    "[id] \"title\" | domain" and embedded newlines would let an attacker
  //    break the format.
  let cleaned = rawTitle.replace(LINE_BREAK_RE, " ");
  // 2. Strip remaining control chars.
  cleaned = cleaned.replace(CONTROL_CHARS_RE, "");
  // 3. Truncate.
  if (cleaned.length > TITLE_MAX_LEN) {
    cleaned = cleaned.slice(0, TITLE_MAX_LEN) + "…";
  }
  // 4. Escape wrapper-tag literals (P3-O).
  return escapeUntrustedWrappers(cleaned);
}

function computeDomain(rawUrl: string | undefined): string {
  if (!rawUrl) return "(no-url)";
  // Restricted URLs have no real hostname — surface them as "(restricted)" so
  // the LLM sees they exist as data but won't try to navigate / extract them.
  if (RESTRICTED_URL_PREFIXES.some((p) => rawUrl.startsWith(p))) {
    return "(restricted)";
  }
  let hostname = "";
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return "(invalid-url)";
  }
  // Take the last two labels: docs.rs → docs.rs, www.foo.com → foo.com.
  // Public-suffix list parsing isn't worth the dependency for confirm-card
  // display; the agent gets full URL context elsewhere.
  const parts = hostname.split(".");
  const tail = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  let cleaned = tail;
  if (cleaned.length > DOMAIN_MAX_LEN) {
    cleaned = cleaned.slice(0, DOMAIN_MAX_LEN) + "…";
  }
  return escapeUntrustedWrappers(cleaned);
}

/**
 * Wrap an array of tab metadata entries in <untrusted_tab_metadata> for the
 * LLM observation. Format (one tab per line):
 *
 *   <untrusted_tab_metadata>
 *   scope=currentWindow, total=12
 *   [12] "GitHub - foo/bar" | github.com (active, group:3, idle:5min)
 *   [13] "tokio docs"        | tokio.rs
 *   ...
 *   </untrusted_tab_metadata>
 *
 * Per Phase 3 invariant P3-C, every value inside this wrapper is third-party
 * data (page-controlled tab title, page-controlled URL); the LLM must treat
 * everything in this block as data, never instructions. The system prompt's
 * tab-tools section calls this out explicitly.
 */
export function wrapTabMetadata(
  tabs: TabMetadataEntry[],
  totals: { totalCount: number; truncated: boolean; scope: "currentWindow" | "allWindows" },
): string {
  const header = `scope=${totals.scope}, total=${totals.totalCount}${totals.truncated ? ", truncated=true" : ""}`;
  if (tabs.length === 0) {
    return `<untrusted_tab_metadata>\n${header}\n(no tabs visible to the agent)\n</untrusted_tab_metadata>`;
  }
  const now = Date.now();
  const lines = tabs.map((t) => {
    const tags: string[] = [];
    if (t.active) tags.push("active");
    if (t.pinned) tags.push("pinned");
    if (t.groupId !== -1) tags.push(`group:${t.groupId}`);
    if (t.lastAccessed) {
      const idleMs = now - t.lastAccessed;
      const mins = Math.floor(idleMs / 60_000);
      if (mins >= 1) tags.push(`idle:${mins}min`);
    }
    const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    return `[${t.id}] "${t.title}" | ${t.domain}${tagSuffix}`;
  });
  return `<untrusted_tab_metadata>\n${header}\n${lines.join("\n")}\n</untrusted_tab_metadata>`;
}

/**
 * list_tabs — return tab metadata for the agent to reason about.
 *
 * Risk classification (in risk.ts):
 *   - scope = "currentWindow" (default) → low (no confirm)
 *   - scope = "allWindows"              → high + reason "crossWindowTabExposure" (Phase 3 P3-T)
 *
 * Limits:
 *   - no default cap — return every visible tab
 *   - caller can still pass `limit` to cap the response; when the cap is hit
 *     the wrapper carries total_count + truncated:true
 *
 * Privacy invariant P3-K: incognito-window tabs are NOT visible because the
 * extension manifest deliberately omits "incognito": "spanning". Tested in
 * Unit 1 verification.
 */
const listTabsTool: Tool = {
  name: "list_tabs",
  description:
    "List open browser tabs with metadata (id, title, domain, active state, group). " +
    "Defaults to the current window; scope='allWindows' covers every browser window. " +
    "By default every visible tab is returned; pass `limit` to cap the response.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["currentWindow", "allWindows"],
        description:
          "currentWindow (default): tabs in the agent's window only. allWindows: tabs across every browser window.",
      },
      limit: {
        type: "number",
        description:
          "Optional cap on tabs returned. Omit to return every visible tab.",
      },
    },
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ListTabsArgs;
    const scope = a.scope === "allWindows" ? "allWindows" : "currentWindow";
    const requestedLimit =
      typeof a.limit === "number" && Number.isFinite(a.limit) && a.limit > 0
        ? Math.floor(a.limit)
        : Number.POSITIVE_INFINITY;

    const queryInfo: chrome.tabs.QueryInfo =
      scope === "currentWindow" ? { currentWindow: true } : {};
    const allTabs = await chrome.tabs.query(queryInfo);

    // Filter tabs without an addressable id or windowId. Chrome occasionally
    // surfaces partial tabs during navigation transitions, AND assigns
    // `chrome.tabs.TAB_ID_NONE` (= -1) to apps / DevTools windows / session-
    // restore tabs / detached tabs that aren't actually addressable via
    // chrome.tabs.{get,remove,update,...}. If we leak a -1 id into the
    // wrapTabMetadata observation, the LLM learns it as a valid tabId and
    // a follow-up tool call (close_tabs / etc.) will hit
    // chrome.tabs.get(-1) which throws synchronously with "Value must be at
    // least 0", crashing the loop with a raw API error and no recovery
    // observation. Filter both axes (id + windowId) at the source so phantom
    // tabs never enter the LLM's view.
    let usable = allTabs.filter(
      (t): t is chrome.tabs.Tab & { id: number; windowId: number } =>
        typeof t.id === "number" &&
        Number.isInteger(t.id) &&
        t.id >= 0 &&
        typeof t.windowId === "number" &&
        t.windowId >= 0,
    );

    // For allWindows scope, confirmedTabTargets is undefined (confirm layer
    // removed), so all tabs are returned without filtering.
    if (scope === "allWindows" && ctx.confirmedTabTargets) {
      const approvedIds = ctx.confirmedTabTargets;
      usable = usable.filter((t) => approvedIds.has(t.id));
    }

    const totalCount = usable.length;
    const truncated = totalCount > requestedLimit;
    const sliced = usable.slice(0, requestedLimit);

    const entries: TabMetadataEntry[] = sliced.map((t) => ({
      id: t.id,
      title: sanitizeTabTitle(t.title),
      domain: computeDomain(t.url),
      active: t.active,
      pinned: t.pinned,
      groupId: typeof t.groupId === "number" ? t.groupId : -1,
      lastAccessed: t.lastAccessed,
      windowId: t.windowId,
    }));

    const observation = wrapTabMetadata(entries, {
      totalCount,
      truncated,
      scope,
    });

    return {
      success: true,
      observation,
    };
  },
};

// ── Unit 3 — close_tabs / activate_tab ──────────────────────────────────────

const CLOSE_TABS_MAX = 50;

interface CloseTabsArgs {
  tabIds: number[];
}

interface ActivateTabArgs {
  tabId: number;
}

interface PartialCompletionResult {
  ok: number[];
  skipped: Array<{ id: number; reason: string }>;
  errors: Array<{ id: number; message: string }>;
}

function summarizePartial(
  toolName: string,
  result: PartialCompletionResult,
): string {
  const lines: string[] = [];
  lines.push(`${toolName}: ${result.ok.length} succeeded`);
  if (result.skipped.length > 0) {
    lines.push(
      `skipped (${result.skipped.length}): ${result.skipped
        .map((s) => `[${s.id}: ${s.reason}]`)
        .join(", ")}`,
    );
  }
  if (result.errors.length > 0) {
    lines.push(
      `errors (${result.errors.length}): ${result.errors
        .map((e) => `[${e.id}: ${e.message}]`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

const closeTabsTool: Tool = {
  name: "close_tabs",
  description:
    "Close one or more tabs by id (batch into one call). Cannot close a tab that is " +
    "pinned to this conversation: call unpin_tab(id) first to release the pin, then " +
    "close_tabs(id). (User-pinned tabs can only be released from the PINNED dropdown — " +
    "ask the user.) Tabs that have navigated to a different origin since the task " +
    "started are skipped.",
  parameters: {
    type: "object",
    properties: {
      tabIds: {
        type: "array",
        items: { type: "integer" },
        description: `Tab ids to close (max ${CLOSE_TABS_MAX} per call).`,
      },
    },
    required: ["tabIds"],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as CloseTabsArgs;
    if (!Array.isArray(a.tabIds) || a.tabIds.length === 0) {
      return { success: false, error: "close_tabs requires a non-empty tabIds array" };
    }
    if (a.tabIds.length > CLOSE_TABS_MAX) {
      return {
        success: false,
        error: `close_tabs accepts at most ${CLOSE_TABS_MAX} tab ids per call (received ${a.tabIds.length}).`,
      };
    }

    // Issue #110 — refuse closing ANY tab pinned to this session, in EVERY
    // pinMode. Previously only 'user' mode was protected; in 'task'/'auto'
    // mode the agent could close its own anchored tab (its own open_url tab,
    // or the chat-start pin) and strand the loop. The advisory per-iteration
    // origin check tolerates a vanished pin, but the right fix is to stop the
    // agent shooting its own foot in the first place — and to make close_tabs
    // honour its own "cannot close the pinned tab" contract.
    //
    // Recovery differs by mode:
    //   - 'user': the user explicitly pinned these via the dropdown; the agent
    //     must NOT silently undo that choice → tell it to use the dropdown.
    //   - 'task'/'auto'/undefined: agent-managed pins → the agent unpins via
    //     unpin_tab first, then retries close_tabs.
    // Hard refuse on the whole batch (matches the prior K-9 semantics): the
    // agent must re-issue close_tabs without the pinned id(s), or unpin first.
    if (ctx.pinnedTabs && ctx.pinnedTabs.length > 0) {
      const pinnedIds = new Set(ctx.pinnedTabs.map((p) => p.tabId));
      const blocked = a.tabIds.filter((id) => pinnedIds.has(id));
      if (blocked.length > 0) {
        const ids = blocked.join(", ");
        if (ctx.pinMode === "user") {
          return {
            success: false,
            error:
              `close_tabs cannot close user-pinned tab(s) [${ids}] (pinMode=user). ` +
              `Use the PINNED dropdown to clear or change the pin, then retry.`,
          };
        }
        return {
          success: false,
          error:
            `close_tabs cannot close pinned tab(s) [${ids}] anchored to this conversation. ` +
            `Call unpin_tab(id) for each one first, then retry close_tabs.`,
        };
      }
    }

    const result: PartialCompletionResult = { ok: [], skipped: [], errors: [] };
    const survivors: number[] = [];

    // K-8: confirm-time origin re-verify per id. Skip stale; collect
    // survivors for a single chrome.tabs.remove batch call.
    for (const id of a.tabIds) {
      const verify = await verifyConfirmedOrigin(id, ctx.confirmedTabTargets);
      if (!verify.ok) {
        result.skipped.push({ id, reason: verify.reason });
        continue;
      }
      survivors.push(id);
    }

    if (survivors.length === 0) {
      return {
        success: false,
        observation: `close_tabs: no valid targets (all tabs were stale or unconfirmed).\n${summarizePartial("close_tabs", result)}`,
        error: "noValidTargets",
      };
    }

    try {
      await chrome.tabs.remove(survivors);
      result.ok.push(...survivors);
    } catch (e) {
      // Batch failed — record on every id so the agent sees what didn't go.
      const message = e instanceof Error ? e.message : String(e);
      for (const id of survivors) {
        result.errors.push({ id, message });
      }
    }

    return {
      success: result.ok.length > 0,
      observation: summarizePartial("close_tabs", result),
    };
  },
};

const activateTabTool: Tool = {
  name: "activate_tab",
  description:
    `Switch the USER's view to a specific tab. The agent's focused tab does NOT change — subsequent read_page/click/type still target the focused tab.

USE WHEN:
- You want to bring a tab into the user's view (show them something).

**DO NOT USE WHEN:**
- You want the agent to operate on that tab next — use focus_tab (activate_tab does NOT redirect your actions).`,
  parameters: {
    type: "object",
    properties: {
      tabId: {
        type: "integer",
        description: "Tab id to make active.",
      },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as ActivateTabArgs;
    if (typeof a.tabId !== "number") {
      return { success: false, error: "activate_tab requires a numeric tabId" };
    }

    // Verify the tab exists before updating.
    try {
      await chrome.tabs.get(a.tabId);
    } catch {
      return { success: false, error: `activate_tab: tab ${a.tabId} not found` };
    }

    try {
      await chrome.tabs.update(a.tabId, { active: true });
      return {
        success: true,
        observation: `Activated tab ${a.tabId}. Note: the agent's pinned tab is unchanged; subsequent click/type tools still target the original tab.`,
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "activate_tab failed",
      };
    }
  },
};

// ── Unit 4 — group_tabs / ungroup_tabs / move_tabs ──────────────────────────

const GROUP_TABS_MAX = 50;
const GROUP_NAME_CAP = 64;

const TAB_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;
type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

interface GroupTabsArgs {
  tabIds: number[];
  groupName?: string;
  color?: string;
}

interface UngroupTabsArgs {
  tabIds: number[];
}

interface MoveTabsArgs {
  tabIds: number[];
  index: number;
}

/**
 * SEC-1 — sanitize an LLM-supplied groupName before it flows into
 * chrome.tabGroups.update({title}). Without this, an LLM influenced by
 * prompt-injected tab titles could pick a groupName containing wrapper
 * literals or control chars; that name would render in Chrome's tab strip
 * AND echo back into the next list_tabs <untrusted_tab_metadata> block,
 * potentially escaping the wrapper.
 */
function sanitizeGroupName(raw: string | undefined): string {
  if (!raw) return "";
  let cleaned = raw.replace(LINE_BREAK_RE, " ").replace(CONTROL_CHARS_RE, "");
  if (cleaned.length > GROUP_NAME_CAP) {
    cleaned = cleaned.slice(0, GROUP_NAME_CAP);
  }
  return escapeUntrustedWrappers(cleaned);
}

/** Filter tabIds whose tab.url is a restricted scheme — chrome:// tabs
 *  can't be grouped (chrome.tabs.group rejects). The K-8 verify step
 *  has already confirmed origin equality with what the user saw, so the
 *  origin is real; we only need to reject the special schemes here.
 *  Exported so read_page can reuse the same scheme-restriction logic. */
export function isRestrictedSchemeForGrouping(url: string): boolean {
  return RESTRICTED_URL_PREFIXES.some((p) => url.startsWith(p));
}

const groupTabsTool: Tool = {
  name: "group_tabs",
  description:
    "Move one or more tabs into a tab group. Creates a new group when no " +
    "groupId is supplied. Optional groupName + color let you label the group. " +
    "Tabs that have navigated to a different origin since the task started are skipped. " +
    "Restricted-URL tabs (chrome://, file://, etc.) are also skipped.",
  parameters: {
    type: "object",
    properties: {
      tabIds: {
        type: "array",
        items: { type: "integer" },
        description: `Tab ids to move into the group (max ${GROUP_TABS_MAX} per call).`,
      },
      groupName: {
        type: "string",
        description:
          `Optional human-readable group label (max ${GROUP_NAME_CAP} chars). ` +
          "Sanitized: line breaks become spaces, control chars stripped, " +
          "wrapper-tag literals escaped.",
      },
      color: {
        type: "string",
        enum: [...TAB_GROUP_COLORS],
        description: "Optional group accent color.",
      },
    },
    required: ["tabIds"],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as GroupTabsArgs;
    if (!Array.isArray(a.tabIds) || a.tabIds.length === 0) {
      return { success: false, error: "group_tabs requires a non-empty tabIds array" };
    }
    if (a.tabIds.length > GROUP_TABS_MAX) {
      return {
        success: false,
        error: `group_tabs accepts at most ${GROUP_TABS_MAX} tab ids per call.`,
      };
    }

    if (a.color !== undefined && !TAB_GROUP_COLORS.includes(a.color as TabGroupColor)) {
      return {
        success: false,
        error: `Invalid color "${a.color}". Must be one of: ${TAB_GROUP_COLORS.join(", ")}.`,
      };
    }

    const safeName = a.groupName ? sanitizeGroupName(a.groupName) : "";
    const result: PartialCompletionResult = { ok: [], skipped: [], errors: [] };
    const survivors: number[] = [];

    for (const id of a.tabIds) {
      const verify = await verifyConfirmedOrigin(id, ctx.confirmedTabTargets);
      if (!verify.ok) {
        result.skipped.push({ id, reason: verify.reason });
        continue;
      }
      // Reject restricted-scheme tabs — chrome.tabs.group would error on
      // them and abort the whole batch.
      if (verify.tab.url && isRestrictedSchemeForGrouping(verify.tab.url)) {
        result.skipped.push({ id, reason: "restricted-url" });
        continue;
      }
      survivors.push(id);
    }

    if (survivors.length === 0) {
      return {
        success: false,
        observation: `group_tabs: no valid targets.\n${summarizePartial("group_tabs", result)}`,
        error: "noValidTargets",
      };
    }

    let newGroupId: number;
    try {
      // survivors is non-empty (checked above); cast to the required non-empty tuple type.
      newGroupId = await chrome.tabs.group({ tabIds: survivors as [number, ...number[]] });
      result.ok.push(...survivors);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const id of survivors) {
        result.errors.push({ id, message });
      }
      return {
        success: false,
        observation: summarizePartial("group_tabs", result),
        error: message,
      };
    }

    // Apply name + color via chrome.tabGroups.update if either was supplied.
    if (safeName || a.color) {
      try {
        await chrome.tabGroups.update(newGroupId, {
          title: safeName || undefined,
          color: (a.color as TabGroupColor | undefined) ?? undefined,
        });
      } catch (e) {
        // Group itself created OK — name/color failure is a warning, not a
        // fatal failure. Surface it in observation but keep success=true.
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: true,
          observation: `${summarizePartial("group_tabs", result)}\nGroup ${newGroupId} created but title/color update failed: ${msg}`,
        };
      }
    }

    return {
      success: true,
      observation: `${summarizePartial("group_tabs", result)}\nGroup id: ${newGroupId}${safeName ? ` (name: ${safeName})` : ""}${a.color ? ` (color: ${a.color})` : ""}`,
    };
  },
};

const ungroupTabsTool: Tool = {
  name: "ungroup_tabs",
  description:
    "Remove one or more tabs from their current tab group. The group is " +
    "automatically deleted when the last tab leaves it. Tabs that have " +
    "navigated to a different origin since the task started are skipped.",
  parameters: {
    type: "object",
    properties: {
      tabIds: {
        type: "array",
        items: { type: "integer" },
        description: `Tab ids to remove from their groups (max ${GROUP_TABS_MAX} per call).`,
      },
    },
    required: ["tabIds"],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as UngroupTabsArgs;
    if (!Array.isArray(a.tabIds) || a.tabIds.length === 0) {
      return { success: false, error: "ungroup_tabs requires a non-empty tabIds array" };
    }
    if (a.tabIds.length > GROUP_TABS_MAX) {
      return {
        success: false,
        error: `ungroup_tabs accepts at most ${GROUP_TABS_MAX} tab ids per call.`,
      };
    }

    const result: PartialCompletionResult = { ok: [], skipped: [], errors: [] };
    const survivors: number[] = [];

    for (const id of a.tabIds) {
      const verify = await verifyConfirmedOrigin(id, ctx.confirmedTabTargets);
      if (!verify.ok) {
        result.skipped.push({ id, reason: verify.reason });
        continue;
      }
      survivors.push(id);
    }

    if (survivors.length === 0) {
      return {
        success: false,
        observation: `ungroup_tabs: no valid targets.\n${summarizePartial("ungroup_tabs", result)}`,
        error: "noValidTargets",
      };
    }

    try {
      // survivors is non-empty (checked above); cast to the required non-empty tuple type.
      await chrome.tabs.ungroup(survivors as [number, ...number[]]);
      result.ok.push(...survivors);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const id of survivors) {
        result.errors.push({ id, message });
      }
    }

    return {
      success: result.ok.length > 0,
      observation: summarizePartial("ungroup_tabs", result),
    };
  },
};

const moveTabsTool: Tool = {
  name: "move_tabs",
  description:
    "Reorder one or more tabs to a target index within their current window. " +
    "Cross-window moves are not supported — all tabIds must share a single " +
    "windowId. Tabs that have navigated to a different origin since the task " +
    "started are skipped.",
  parameters: {
    type: "object",
    properties: {
      tabIds: {
        type: "array",
        items: { type: "integer" },
        description: `Tab ids to move (max ${GROUP_TABS_MAX} per call).`,
      },
      index: {
        type: "integer",
        description: "Target index within the window (0-based; -1 to append).",
      },
    },
    required: ["tabIds", "index"],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as MoveTabsArgs;
    if (!Array.isArray(a.tabIds) || a.tabIds.length === 0) {
      return { success: false, error: "move_tabs requires a non-empty tabIds array" };
    }
    if (typeof a.index !== "number" || !Number.isInteger(a.index)) {
      return { success: false, error: "move_tabs requires an integer index" };
    }
    if (a.tabIds.length > GROUP_TABS_MAX) {
      return {
        success: false,
        error: `move_tabs accepts at most ${GROUP_TABS_MAX} tab ids per call.`,
      };
    }

    const result: PartialCompletionResult = { ok: [], skipped: [], errors: [] };
    const survivors: number[] = [];
    let sharedWindowId: number | undefined;

    for (const id of a.tabIds) {
      const verify = await verifyConfirmedOrigin(id, ctx.confirmedTabTargets);
      if (!verify.ok) {
        result.skipped.push({ id, reason: verify.reason });
        continue;
      }
      const wid = verify.tab.windowId;
      if (sharedWindowId === undefined) {
        sharedWindowId = wid;
      } else if (sharedWindowId !== wid) {
        // v1: cross-window move is acceptance-gated (G-2). Reject the id.
        result.skipped.push({ id, reason: "cross-window-not-supported" });
        continue;
      }
      survivors.push(id);
    }

    if (survivors.length === 0) {
      return {
        success: false,
        observation: `move_tabs: no valid targets.\n${summarizePartial("move_tabs", result)}`,
        error: "noValidTargets",
      };
    }

    try {
      await chrome.tabs.move(survivors, { index: a.index });
      result.ok.push(...survivors);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const id of survivors) {
        result.errors.push({ id, message });
      }
    }

    return {
      success: result.ok.length > 0,
      observation: summarizePartial("move_tabs", result),
    };
  },
};

// ── v1.5 Unit 6 — focus_tab ───────────────────────────────────────────────────

/**
 * focus_tab — mutates the session's internal focus pointer so the NEXT
 * iteration's snapshot targets a different pinned tab. Low-risk: no
 * observable tab or page side effect; only the session agent state changes.
 *
 * Risk = always-low (ALWAYS_LOW_TAB_TOOLS in risk.ts, G-1 gate updated).
 * Class = read (mutates only the internal focus pointer, not tab state).
 *
 * Note: focus_tab updates the loop's focused-tab pointer; ctx.tabId is
 * re-resolved per iteration. CDP keyboard tools route to ctx.tabId, so
 * keyboard input correctly follows focus changes. The ownerToken.tabId
 * (loop.ts ownerToken) stays at task-start value but is metadata only —
 * it does not gate keyboard routing.
 */
const focusTabTool: Tool = {
  name: "focus_tab",
  description:
    `Switch the agent's focus to one of the session's pinned tabs (listed in the system prompt; open_url tabs are added there). Takes effect on the NEXT iteration — call focus_tab(N), then read_page/click/type against tab N on the following response.

USE WHEN:
- You need to operate (read_page/click/type) on a different pinned tab than the current one.
- You're working across multiple pinned tabs and need to switch which one your actions target.

**DO NOT USE WHEN:**
- You only want the USER to see a tab without changing where your actions go — use activate_tab.
- The tab isn't pinned yet — focus only works on session-pinned tabs (open a new one with open_url first).`,
  parameters: {
    type: "object",
    properties: {
      tabId: {
        type: "integer",
        description: "Tab id to switch focus to. Must already be one of the session's pinned tabs.",
      },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = (args ?? {}) as { tabId?: number };
    if (typeof a.tabId !== "number") {
      return { success: false, error: "focus_tab requires a numeric tabId" };
    }
    if (!ctx.pinnedTabs || ctx.pinnedTabs.length === 0) {
      return {
        success: false,
        error: "focus_tab: no pinned tabs in this session (auto mode?).",
      };
    }
    const target = ctx.pinnedTabs.find((p) => p.tabId === a.tabId);
    if (!target) {
      const ids = ctx.pinnedTabs.map((p) => p.tabId).join(", ");
      return {
        success: false,
        error: `focus_tab: tab ${a.tabId} not in pinnedTabs (current: [${ids}]). Use open_url to create a new pinned tab, or pick an existing one.`,
      };
    }
    if (!ctx.setCurrentFocusTabId) {
      return {
        success: false,
        error: "focus_tab: handler context missing setCurrentFocusTabId (test/legacy harness).",
      };
    }
    await ctx.setCurrentFocusTabId(a.tabId);
    return {
      success: true,
      observation:
        `focus changed to tab ${a.tabId} (origin ${target.origin}). ` +
        `The new tab's page snapshot will be available on the next iteration; ` +
        `do NOT batch click/type/scroll on this tab in the same response.`,
    };
  },
};

export { focusTabTool };

// ── Issue #110 — unpin_tab ────────────────────────────────────────────────────

/**
 * unpin_tab — removes a tab from the session's pinnedTabs[] so the agent can
 * subsequently close it (close_tabs refuses any still-pinned tab). Low-risk:
 * mutates only the session's internal pin list, no observable tab/page side
 * effect. Class = read (mirrors focus_tab).
 *
 * Scope:
 *   - task/auto-mode pins are agent-managed (chat-start anchor + open_url
 *     additions) → the agent may unpin them itself.
 *   - user-mode pins are the user's explicit choice → refused; the agent is
 *     told to ask the user to use the PINNED dropdown.
 *
 * After a successful unpin the removal is observed on the NEXT iteration's
 * pinnedTabs refresh (readFocusFromStorage); if the unpinned tab was the
 * current focus, resolveFocusedPin falls back to pinnedTabs[0].
 */
const unpinTabTool: Tool = {
  name: "unpin_tab",
  description:
    "Release a tab from this conversation's pinned tab list so it can be closed " +
    "with close_tabs. Typical use: clean up a tab you opened via open_url once " +
    "you're done — call unpin_tab(id), then close_tabs([id]). Only works on tabs " +
    "the agent pinned (open_url / chat-start anchor); user-pinned tabs must be " +
    "cleared from the PINNED dropdown by the user.",
  parameters: {
    type: "object",
    properties: {
      tabId: {
        type: "integer",
        description: "Tab id to remove from this session's pinned tabs.",
      },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = (args ?? {}) as { tabId?: unknown };
    if (typeof a.tabId !== "number") {
      return { success: false, error: "unpin_tab requires a numeric tabId" };
    }
    const tabId = a.tabId;
    if (!ctx.pinnedTabs || ctx.pinnedTabs.length === 0) {
      return {
        success: false,
        error: "unpin_tab: no pinned tabs in this session (nothing to unpin).",
      };
    }
    const target = ctx.pinnedTabs.find((p) => p.tabId === tabId);
    if (!target) {
      const ids = ctx.pinnedTabs.map((p) => p.tabId).join(", ");
      return {
        success: false,
        error: `unpin_tab: tab ${tabId} is not pinned in this session (current pins: [${ids}]).`,
      };
    }
    // user-mode pins are the user's explicit choice — the agent must not
    // silently undo them. Mirrors close_tabs' user-mode refusal.
    if (ctx.pinMode === "user") {
      return {
        success: false,
        error:
          `unpin_tab cannot unpin user-pinned tab ${tabId} (pinMode=user). ` +
          `Ask the user to clear it from the PINNED dropdown instead.`,
      };
    }
    if (!ctx.removePinnedTab) {
      return {
        success: false,
        error:
          "unpin_tab: handler context missing removePinnedTab (test/legacy harness).",
      };
    }
    await ctx.removePinnedTab(tabId);
    return {
      success: true,
      observation:
        `Unpinned tab ${tabId} from this conversation. You can now close it with ` +
        `close_tabs([${tabId}]) if you no longer need it. The pin list updates on ` +
        `the next iteration; if this was your focused tab, focus falls back to the ` +
        `primary pinned tab.`,
    };
  },
};

export { unpinTabTool };

// ── v1.5 Unit 7 — open_url ────────────────────────────────────────────────────

const OPEN_URL_MAX_LEN = 4096;

/**
 * open_url — creates a new browser tab loading the given http/https URL.
 *
 * Security invariants:
 *   - Strict http: / https: allowlist via URL constructor + protocol check.
 *     All other schemes (javascript:, data:, file:, chrome:, blob:, ftp:,
 *     ws:, mailto:, view-source:, etc.) are rejected with "unsafe-url-scheme".
 *   - URL length capped at OPEN_URL_MAX_LEN (4096) chars.
 *   - Must be an absolute URL (relative paths throw in `new URL()`).
 *
 * Pin integration:
 *   - On success, calls ctx.appendPinnedTab to push the new tab into the
 *     session's pinnedTabs array. The agent must then call
 *     focus_tab(newTabId) on the NEXT iteration to operate on the tab.
 *   - If appendPinnedTab is absent (test/legacy harness), the tab is still
 *     created; the observation mentions the gap so the harness caller is aware.
 *
 * Risk: always high (ALWAYS_HIGH_TAB_TOOLS). Each call requires user
 * approval. Confirm card UI variant is Task 8.
 *
 * G-1 gate: open_url is in TAB_TOOL_NAMES AND ALWAYS_HIGH_TAB_TOOLS.
 */
const openUrlTool: Tool = {
  name: "open_url",
  description:
    `Open a new browser tab at the given URL (http/https only; other schemes rejected). The new tab auto-joins this session's pinned tab list — call focus_tab(newTabId) on the next iteration to operate on it.

USE WHEN:
- You need to visit a URL that isn't open in any current tab.

**DO NOT USE WHEN:**
- The page is already open in a pinned tab — use focus_tab to switch to it instead of opening a duplicate.
- You only want to surface an already-open tab to the user — use activate_tab.`,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: `Absolute http: or https: URL to open. Max ${OPEN_URL_MAX_LEN} chars.`,
      },
      active: {
        type: "boolean",
        description:
          "If true, the new tab takes focus (steals the user's view). Default false (loads in background).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = (args ?? {}) as { url?: unknown; active?: unknown };
    if (typeof a.url !== "string" || a.url.length === 0) {
      return { success: false, error: "open_url: url must be a non-empty string" };
    }
    if (a.url.length > OPEN_URL_MAX_LEN) {
      return {
        success: false,
        error: `open_url: url-too-long (>${OPEN_URL_MAX_LEN} chars)`,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(a.url);
    } catch {
      return { success: false, error: "open_url: invalid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        success: false,
        error: `open_url: unsafe-url-scheme "${parsed.protocol}" (only http: and https: are allowed)`,
      };
    }
    const active = a.active === true;
    let newTab: chrome.tabs.Tab;
    try {
      newTab = await chrome.tabs.create({ url: a.url, active });
    } catch (e) {
      return {
        success: false,
        error: `open_url: chrome.tabs.create failed — ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (typeof newTab.id !== "number" || newTab.id < 0) {
      return { success: false, error: "open_url: chrome returned no tab id" };
    }

    // Issue #50 — wait for the new tab to actually commit to the
    // requested origin before declaring success and writing the pin.
    // chrome.tabs.create resolves immediately with url="about:blank";
    // returning success at that point would race the loop's next-
    // iteration origin check. On commit failure we leave the tab open
    // (the LLM can close_tabs([id]) explicitly) and skip appendPinnedTab
    // so pinnedTabs[] never holds an entry that won't pass origin check.
    const newTabId = newTab.id;
    const settle = await waitForUrlSettle(newTabId, parsed.origin, 5000);
    if (!settle.committed) {
      return {
        success: false,
        error:
          `open_url: tab ${newTabId} created but navigation did not commit to ${parsed.origin} ` +
          `within 5s (${settle.reason}). The tab is left open — use close_tabs([${newTabId}]) to clean up ` +
          `or retry with a different URL.`,
      };
    }

    if (ctx.appendPinnedTab) {
      try {
        await ctx.appendPinnedTab({ tabId: newTabId, origin: parsed.origin });
      } catch (e) {
        return {
          success: true,
          observation:
            `Opened tab ${newTabId} at ${parsed.origin}, but failed to add it ` +
            `to the session's pinnedTabs (${e instanceof Error ? e.message : String(e)}). ` +
            `Use focus_tab(${newTabId}) anyway; if it fails, retry open_url next iteration.`,
        };
      }
    }
    return {
      success: true,
      observation:
        `Opened tab ${newTabId} at ${parsed.origin}` +
        (active ? " (focused: stole user's view)" : " (background)") +
        `. Added to pinnedTabs[]; call focus_tab(${newTabId}) on the next iteration to operate on it.`,
    };
  },
};

export { openUrlTool };

// ── v1.1 cross-tab replay — switch_to_new_tab ────────────────────────────────

/** 有界轮询：等候选标签页 url 脱离 about:blank/空（origin 未知，故不用 waitForUrlSettle）。 */
async function readSettledUrl(tabId: number, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // ponytail: 50ms 轮询；spawn 子页通常下一迭代已 commit，循环极少超过 1-2 轮。
  for (;;) {
    let url = "";
    try {
      url = (await chrome.tabs.get(tabId)).url ?? "";
    } catch {
      return ""; // tab gone
    }
    if (url && url !== "about:blank") return url;
    if (Date.now() >= deadline) return url;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function originOf(url: string): string {
  try {
    const o = new URL(url).origin;
    return !o || o === "null" ? "" : o;
  } catch {
    return "";
  }
}

/**
 * switch_to_new_tab — adopt a tab THIS session spawned (openerTabId ∈ pinned,
 * not yet pinned; cross-window included) and focus it. For replay of a step
 * whose original click opened a new tab. Read-class (no page mutation; only
 * pins+focuses a tab the session already caused to exist).
 */
const switchToNewTabTool: Tool = {
  name: "switch_to_new_tab",
  description:
    `Adopt and focus a tab that one of your pinned tabs just opened (e.g. the previous click opened a new tab/popup, including in another window). Pass the expected site origin as a hint when known. Takes effect on the NEXT iteration — call it, then read_page/click on the new tab afterwards.

USE WHEN:
- A step's click opened a new tab/popup and you need to continue inside it.

**DO NOT USE WHEN:**
- The tab is already pinned — use focus_tab.
- You know the exact URL and no tab was opened — use open_url.`,
  parameters: {
    type: "object",
    properties: {
      origin: {
        type: "string",
        description:
          "Optional expected origin of the newly-opened tab (e.g. https://pay.stripe.com), used to disambiguate when several tabs were opened.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as { origin?: unknown };
    const wantOrigin = typeof a.origin === "string" ? a.origin : "";
    const pinnedIds = new Set((ctx.pinnedTabs ?? []).map((p) => p.tabId));
    if (pinnedIds.size === 0) {
      return { success: false, error: "switch_to_new_tab: no pinned tabs in this session." };
    }
    let all: chrome.tabs.Tab[];
    try {
      all = await chrome.tabs.query({});
    } catch (e) {
      return {
        success: false,
        error: `switch_to_new_tab: chrome.tabs.query failed — ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Candidates: opened by a tab we own, not yet pinned.
    const candidates = all.filter(
      (t) =>
        typeof t.id === "number" &&
        t.openerTabId !== undefined &&
        pinnedIds.has(t.openerTabId) &&
        !pinnedIds.has(t.id),
    );
    if (candidates.length === 0) {
      return {
        success: true,
        observation: "未检测到新标签页（上一步可能没有打开新标签页）。可在当前标签页继续，或调 fail。",
      };
    }
    // Settle URLs, then prefer origin match → newest (highest id) fallback.
    const settled = await Promise.all(
      candidates.map(async (t) => ({ id: t.id!, origin: originOf(await readSettledUrl(t.id!)) })),
    );
    const byOrigin = wantOrigin ? settled.filter((c) => c.origin === wantOrigin) : [];
    const pool = byOrigin.length > 0 ? byOrigin : settled;
    pool.sort((x, y) => y.id - x.id);
    const chosen = pool[0]!;

    if (ctx.appendPinnedTab) {
      try {
        await ctx.appendPinnedTab({ tabId: chosen.id, origin: chosen.origin });
      } catch {
        // non-fatal; continue to focus
      }
    }
    if (ctx.setCurrentFocusTabId) await ctx.setCurrentFocusTabId(chosen.id);

    const others = settled
      .filter((c) => c.id !== chosen.id)
      .map((c) => `${c.id}@${c.origin || "?"}`);
    return {
      success: true,
      observation:
        `Adopted tab ${chosen.id} (origin ${chosen.origin || "?"}) and set focus; its snapshot is available next iteration.` +
        (others.length ? ` Other new tabs: [${others.join(", ")}] — if wrong, use list_tabs + focus_tab.` : ""),
    };
  },
};

export { switchToNewTabTool };

export const TAB_TOOLS: Tool[] = [
  listTabsTool,
  closeTabsTool,
  activateTabTool,
  groupTabsTool,
  ungroupTabsTool,
  moveTabsTool,
  focusTabTool,
  unpinTabTool,
  openUrlTool,
  switchToNewTabTool,
];
