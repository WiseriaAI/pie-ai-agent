import type { ElementInfo, PageSnapshot } from "../dom-actions/types";
import type { RiskAssessment, RiskLevel } from "./types";
import { KEYBOARD_TOOL_NAMES } from "./tools/keyboard";
import { TAB_TOOL_NAMES, SCREENSHOT_TOOL_NAMES } from "./tool-names";

/**
 * Phase 3 — context for cross-origin args introspection. Loop dispatch
 * passes pinnedTabs (task-level pins) and a cache of tab origins it has
 * already fetched (chrome.tabs.get) so risk classifier can detect when a
 * tab tool's args.tabIds touch tabs whose origin differs from any pinned tab
 * and escalate.
 *
 * allTabsCache may be partial — for tabIds not in the cache, the classifier
 * conservatively treats them as cross-origin (worst case is an extra
 * confirm; never under-classifies).
 */
export interface RiskClassifyContext {
  /**
   * v1.5 — full session pinned tabs. The classifier flags any tabId not in
   * this list as cross-origin (conservative). When pinnedTabs is empty/absent,
   * any args.tabIds touching a tab is considered cross-origin (fail-high).
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  allTabsCache?: Map<number, { origin: string }>;
}

/**
 * Phase 3 / v1.5 — does any of args.tabIds (or args.tabId) touch a tab
 * that is not in pinnedTabs? Returns crossOrigin=true on any unowned tab OR
 * on any tab whose origin we couldn't determine (conservative fail-high).
 * When pinnedTabs is empty, any tab reference is treated as cross-origin
 * (auto mode safety / fail-high).
 *
 * Used by tab tools (close_tabs / activate_tab / group_tabs / ungroup_tabs /
 * move_tabs / get_tab_content). Each tool's risk branch decides what to do
 * with the result — most are always-high regardless and just fold the
 * cross-origin signal into the reason string.
 *
 * INVARIANT: agent execution should never reach this code path with an empty
 * pinnedTabs (loop.ts always resolves a pin before classifyRisk runs). The
 * empty-pin branch is a fail-safe — if the invariant ever breaks, every
 * cross-tab op gets escalated to confirm rather than silently allowed.
 */
export function hasCrossOriginTab(
  args: { tabIds?: number[]; tabId?: number },
  ctx: RiskClassifyContext | undefined,
): { crossOrigin: boolean; offendingOrigins: string[] } {
  if (!ctx?.allTabsCache) {
    return { crossOrigin: false, offendingOrigins: [] };
  }
  const ownedByTabId = new Map<number, string>();
  if (ctx.pinnedTabs && ctx.pinnedTabs.length > 0) {
    for (const p of ctx.pinnedTabs) ownedByTabId.set(p.tabId, p.origin);
  }
  const ids = collectIds(args);
  if (ownedByTabId.size === 0) {
    // No pin → conservative fail-high so any tab tool target is cross-origin.
    const offending = new Set<string>();
    for (const id of ids) {
      const info = ctx.allTabsCache.get(id);
      offending.add(info?.origin ?? "(unknown)");
    }
    return {
      crossOrigin: ids.length > 0,
      offendingOrigins: Array.from(offending),
    };
  }
  const offending = new Set<string>();
  for (const id of ids) {
    if (ownedByTabId.has(id)) continue; // owned tab, same-origin by definition
    const info = ctx.allTabsCache.get(id);
    offending.add(info?.origin ?? "(unknown)");
  }
  return {
    crossOrigin: offending.size > 0,
    offendingOrigins: Array.from(offending),
  };
}

function collectIds(args: { tabIds?: number[]; tabId?: number }): number[] {
  const ids: number[] = [];
  if (Array.isArray(args.tabIds)) ids.push(...args.tabIds);
  if (typeof args.tabId === "number") ids.push(args.tabId);
  return ids;
}

/**
 * Returns true when the element is a sensitive input field
 * (password, credit card, OTP, verification code, etc.).
 *
 * Uses only fields available in ElementInfo: type, text, placeholder, ariaLabel.
 * Note: autocomplete/name/id are not in ElementInfo, so detection is intentionally
 * more conservative than the inline check in type.ts.
 */
export function isSensitiveInputTarget(element: ElementInfo): boolean {
  // type="password"
  if (element.type === "password") return true;

  const sensitivePattern =
    /password|密码|cvv|cvc|otp|验证码|card.*number|card.*code/i;
  const ccPattern = /cc-(number|cvc|exp|csc)/i;

  // Check placeholder
  if (element.placeholder) {
    if (sensitivePattern.test(element.placeholder)) return true;
    if (ccPattern.test(element.placeholder)) return true;
  }

  // Check text (innerText / aria-label — whichever getElementText returned)
  if (element.text) {
    if (sensitivePattern.test(element.text)) return true;
    if (ccPattern.test(element.text)) return true;
  }

  // Check ariaLabel (stored separately from text)
  if (element.ariaLabel) {
    if (sensitivePattern.test(element.ariaLabel)) return true;
    if (ccPattern.test(element.ariaLabel)) return true;
  }

  return false;
}

// Keyword regex for click / select risk classification
const DANGEROUS_KEYWORD_RE =
  /submit|delete|confirm|buy|pay|purchase|确认|删除|支付|购买|提交/i;

function getElement(
  snapshot: PageSnapshot,
  elementIndex?: number,
): ElementInfo | undefined {
  if (elementIndex === undefined || elementIndex === null) return undefined;
  return snapshot.elements.find((el) => el.index === elementIndex);
}

/**
 * Pure function. Classifies the risk of a tool call based on static rules.
 * Default is low; structural signals elevate to high.
 *
 * The args parameter accepts optional fields for every tool that introspects
 * its args during classification (DOM tools use elementIndex/value; Phase 3
 * tab tools use tabIds/tabId/scope). The cast site in loop.ts widens the
 * incoming `unknown` args to this shape; new tools that introspect args must
 * extend this type union (or change to Record<string, unknown> + narrowing).
 */
export function classifyRisk(
  toolName: string,
  args: {
    elementIndex?: number;
    value?: string;
    // Phase 3 cross-tab tools
    tabIds?: number[];
    tabId?: number;
    scope?: string;
  },
  snapshot: PageSnapshot,
  ctx?: RiskClassifyContext,
): RiskAssessment {
  // Phase 2.5 keyboard simulation tools — ALWAYS high risk. CDP keyboard
  // events bypass all DOM safety checks (visibility, readonly, disabled);
  // any call could trigger arbitrary keyboard-bound logic in the page.
  //
  // INVARIANT: keyboard tools must opt out of any future "approve all in
  // task" / "remember decision" shortcut in the confirm UI. Each call
  // must remain its own independent user decision point. If such a
  // shortcut ever lands, exclude these tool names by reference.
  if (toolName === "dispatch_keyboard_input" || toolName === "press_key") {
    return {
      level: "high",
      reason: "Keyboard simulation via CDP bypasses DOM safety checks",
    };
  }

  // Phase 2.6 — Skill autonomous CRUD meta tools.
  //
  // create_skill / update_skill grant the agent new persistent capabilities
  // (write to chrome.storage.local; the new skill becomes a callable tool on
  // subsequent turns). They are ALWAYS high until the user has reviewed the
  // proposed skill content. Future降级 (e.g. low risk when allowedTools is
  // entirely low-risk) can use riskOfAllowedTools below; the conservative
  // default for now is unconditional high.
  //
  // delete_skill / list_skills are low: delete reduces capabilities (blast
  // radius shrinks), list is a pure read.
  if (toolName === "create_skill" || toolName === "update_skill") {
    return {
      level: "high",
      reason:
        "Persists a skill the agent can later invoke; review promptTemplate, parameters, and allowedTools before approving.",
    };
  }
  if (toolName === "delete_skill" || toolName === "list_skills") {
    return { level: "low" };
  }

  // Phase 5 — screenshot tools always high (R5/R6).
  // Pixel-grain capture cannot be sanitized; each call requires user approval.
  if (ALWAYS_HIGH_SCREENSHOT_TOOLS.has(toolName)) {
    return {
      level: "high",
      reason: "Screenshot tools require explicit user approval per capture (R5/R6) — pixel data cannot be sanitized.",
    };
  }

  // Terminal / always-low tools
  if (
    toolName === "done" ||
    toolName === "fail" ||
    toolName === "scroll" ||
    toolName === "wait"
  ) {
    return { level: "low" };
  }

  // ── Phase 3 — Cross-tab write tools ──────────────────────────────────────
  //
  // close_tabs / group_tabs / ungroup_tabs / move_tabs are always high. The
  // confirm card carries tabTargets (Unit 2) so the user sees every affected
  // tab; cross-origin among the target set is folded into reason text but
  // does NOT change the level (P3-P invariant: write-class tab tools always
  // high, mechanically locked by the build-time check in Unit 7's G-1 gate).
  if (
    toolName === "close_tabs" ||
    toolName === "group_tabs" ||
    toolName === "ungroup_tabs" ||
    toolName === "move_tabs"
  ) {
    const co = hasCrossOriginTab(args, ctx);
    const reason = co.crossOrigin
      ? `Cross-tab write touching ${co.offendingOrigins.length} non-pinned origin(s): ${co.offendingOrigins.join(", ")}`
      : `Cross-tab write — review the affected tabs in the confirm card.`;
    return { level: "high", reason };
  }

  // get_tab_content — always high, even same-origin (P3-S). Same-tab content
  // can carry credentials the user typed via CDP keyboard into a canvas
  // editor; the user must see the content preview before approval.
  if (toolName === "get_tab_content") {
    const co = hasCrossOriginTab(args, ctx);
    const reason = co.crossOrigin
      ? `Reading content from a tab whose origin (${co.offendingOrigins.join(", ")}) differs from the pinned tab — review the preview.`
      : `Reading visible page content — review the preview before sending it to the LLM.`;
    return { level: "high", reason };
  }

  // activate_tab — same-origin is a navigation aid (low risk, no confirm).
  // Cross-origin activation could be used to set up a phishing handoff, so
  // it is high. The pinned-tab pin is NOT changed by activate_tab regardless
  // (P3-M).
  if (toolName === "activate_tab") {
    const co = hasCrossOriginTab(args, ctx);
    if (!co.crossOrigin) {
      return { level: "low" };
    }
    return {
      level: "high",
      reason: `Activating a tab on a different origin (${co.offendingOrigins.join(", ")}) — verify the target.`,
    };
  }

  // Phase 3 — list_tabs is the single tab tool with args-dependent risk.
  // currentWindow (default) is low; allWindows triggers high because it
  // exposes tab metadata across windows the user has not chosen as the
  // agent conversation context (P3-T / SEC-3).
  if (toolName === "list_tabs") {
    const scope = typeof args.scope === "string" ? args.scope : "currentWindow";
    if (scope === "allWindows") {
      return {
        level: "high",
        reason:
          "Cross-window tab metadata exposure to BYOK provider — confirm scope.",
      };
    }
    return { level: "low" };
  }

  if (toolName === "type") {
    const target = getElement(snapshot, args.elementIndex);
    if (!target) return { level: "low" };
    if (isSensitiveInputTarget(target)) {
      const fieldName = target.text || target.placeholder || target.ariaLabel || "field";
      return { level: "high", reason: `Sensitive field: ${fieldName}` };
    }
    return { level: "low" };
  }

  if (toolName === "click") {
    const target = getElement(snapshot, args.elementIndex);
    if (!target) return { level: "low" };

    // button[type="submit"]
    if (target.tag === "button" && target.type === "submit") {
      return { level: "high", reason: "Submit button" };
    }

    // input[type="submit"]
    if (target.tag === "input" && target.type === "submit") {
      return { level: "high", reason: "Submit input" };
    }

    // Keyword match on text or ariaLabel
    const textHaystack = [target.text, target.ariaLabel]
      .filter(Boolean)
      .join(" ");
    const match = textHaystack.match(DANGEROUS_KEYWORD_RE);
    if (match) {
      return { level: "high", reason: `Keyword match: ${match[0]}` };
    }

    return { level: "low" };
  }

  if (toolName === "select") {
    const target = getElement(snapshot, args.elementIndex);
    if (!target) return { level: "low" };

    // Check the option value/label being selected
    if (args.value) {
      const match = args.value.match(DANGEROUS_KEYWORD_RE);
      if (match) {
        return { level: "high", reason: `Keyword match: ${match[0]}` };
      }
    }

    return { level: "low" };
  }

  // Default
  return { level: "low" };
}

/**
 * Compute the aggregate risk of a tool whitelist by taking the max risk of any
 * named tool. Used by the R5 inference path — currently exported for future降级
 * of create_skill / update_skill (e.g. lowering risk when allowedTools is
 * entirely low-risk). classifyRisk's hardcoded 'high' for those tools is the
 * conservative default until降级 is enabled.
 *
 * Conservative: unknown names default to 'low' to avoid accidental escalation
 * from typos (the meta tool handler already P1-G-rejects unknown names at
 * write time).
 */
const ALWAYS_HIGH_RISK_TOOL_NAMES = new Set<string>([
  ...KEYBOARD_TOOL_NAMES,
  "create_skill",
  "update_skill",
]);

export function riskOfAllowedTools(names: string[]): RiskLevel {
  for (const n of names) {
    if (ALWAYS_HIGH_RISK_TOOL_NAMES.has(n)) return "high";
  }
  return "low";
}

// ── Phase 5 screenshot tools — always-high constant + build-time check ──────
//
// ALWAYS_HIGH_SCREENSHOT_TOOLS mirrors the G-1 pattern: every name in
// SCREENSHOT_TOOL_NAMES must appear here. Pixel-grain captures cannot be
// sanitized via extractPageContentHardened-style credential field strip, so
// every capture must traverse user-explicit confirm (R5/R6).
const ALWAYS_HIGH_SCREENSHOT_TOOLS = new Set<string>(SCREENSHOT_TOOL_NAMES);

// Build-time exhaustive check (mirrors G-1 pattern):
for (const name of SCREENSHOT_TOOL_NAMES) {
  if (!ALWAYS_HIGH_SCREENSHOT_TOOLS.has(name)) {
    throw new Error(
      `[Phase 5] screenshot tool "${name}" is in SCREENSHOT_TOOL_NAMES ` +
        `but not in ALWAYS_HIGH_SCREENSHOT_TOOLS. Every screenshot tool ` +
        `must be high-risk by R5/R6 — no sanitization is possible against ` +
        `pixel data.`,
    );
  }
}

// ── Phase 3 G-1 acceptance gate — build-time exhaustive check ──────────────
//
// The K-3 decision (do not upgrade SkillDefinition.allowedTools schema in v1)
// rests on a load-bearing claim: every cross-tab write tool returns high risk
// every time it's called. If a future PR introduces a low-risk cross-tab
// tool (a "peek_tab_metadata", "read_tab_title", etc.) without first
// upgrading the allowedTools schema to (name, scope) tuple, the K-3 defense
// silently breaks — agent-authored skills could thereafter add the new
// low-risk tool to allowedTools and R10 first-run-confirm would only fire
// once, granting indefinite access.
//
// This block enforces the gate at build time: every name in TAB_TOOL_NAMES
// must be classified as either always-high (write/read tools) or
// args-conditional (the two existing tools whose risk depends on args).
// A new entry that doesn't appear in either set throws at module load —
// the PR introducing it cannot be shipped without consciously updating
// this list, which is the prompt to revisit G-1.
const ALWAYS_HIGH_TAB_TOOLS = new Set<string>([
  "close_tabs",
  "group_tabs",
  "ungroup_tabs",
  "move_tabs",
  "get_tab_content",
]);

// activate_tab: high if cross-origin, low if same-origin (ADV-3).
// list_tabs:   high if scope=allWindows, low if scope=currentWindow (P3-T).
const ARGS_CONDITIONAL_TAB_TOOLS = new Set<string>([
  "activate_tab",
  "list_tabs",
]);

for (const name of TAB_TOOL_NAMES) {
  if (
    !ALWAYS_HIGH_TAB_TOOLS.has(name) &&
    !ARGS_CONDITIONAL_TAB_TOOLS.has(name)
  ) {
    throw new Error(
      `[Phase 3 G-1] cross-tab tool "${name}" is in TAB_TOOL_NAMES but ` +
        `not classified in risk.ts (ALWAYS_HIGH_TAB_TOOLS or ARGS_CONDITIONAL_TAB_TOOLS). ` +
        `If this is a new low-risk cross-tab tool, you MUST first upgrade ` +
        `SkillDefinition.allowedTools schema from string[] to (name, scope) ` +
        `tuple — see plan G-1 acceptance gate / K-3.`,
    );
  }
}
