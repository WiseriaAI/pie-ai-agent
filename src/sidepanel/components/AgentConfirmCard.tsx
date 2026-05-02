import { useState } from "react";
import type { ResolvedElement, TabTarget, TabContentPreview } from "@/types";
import type { SkillDefinition } from "@/lib/skills";

interface AgentConfirmCardProps {
  tool: string;
  args: unknown;
  resolvedElement: ResolvedElement;
  riskReason: string;
  resolved?: "approved" | "rejected";
  onApprove: () => void;
  onReject: () => void;
  /** Phase 2.6 — for create_skill / update_skill confirms, the SW pre-computes
   *  the effective skill so the card can render full merged content. Without
   *  this, update_skill confirms would only show the patch fields and hide
   *  the persistent allowedTools / parameters / etc. (P0-D / adv-1). */
  metaSkillPreview?: {
    existing: SkillDefinition | null;
    effective: SkillDefinition;
  };
  /** Phase 3 — for cross-tab tools, the SW pre-computes a TabTarget per
   *  tabId in args. The card renders <TabTargetsList> with origin summary
   *  row above for K-1 informed-approval equivalence (P3-E). */
  tabTargets?: TabTarget[];
  /** Phase 3 — for get_tab_content (P3-U / R12). SW pre-fetches the page
   *  content; the panel renders the first chunk so the user can see what
   *  is being approved before clicking through. */
  contentPreview?: TabContentPreview;
}

/**
 * Redact sensitive values before display. The risk classifier already flagged
 * this as high-risk because the target is a sensitive field (password/CC/OTP).
 * Showing the plaintext value in the confirm card would defeat the redaction
 * that type.ts already applies to the tool_result observation.
 */
function redactArgsForDisplay(tool: string, args: unknown, riskReason: string): unknown {
  if (tool !== "type") return args;
  if (!riskReason.toLowerCase().includes("sensitive")) return args;
  if (!args || typeof args !== "object") return args;
  const redacted: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if ("text" in redacted) redacted.text = "[redacted]";
  return redacted;
}

function safeStringifyArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args, null, 2) ?? "null";
    return s.length > 2000 ? s.slice(0, 2000) + "\n... (truncated)" : s;
  } catch {
    return "(non-serializable)";
  }
}

/** Phase 2.6 — meta tool detection (P0-D). For create_skill / update_skill the
 *  args object IS the trust-decision artifact, so the 2000-char cap and the
 *  generic args block must be bypassed in favor of full-content per-field
 *  rendering. */
function isSkillMetaTool(tool: string): boolean {
  return tool === "create_skill" || tool === "update_skill";
}

/**
 * Phase 3 — origin summary row for tabTargets. Renders e.g.
 *   "2 origins: github.com (3), reddit.com (1)"
 *
 * This row stays above the tab list and never collapses, even when the list
 * itself is virtualized or truncated for large N. K-1 / I-4 equivalence
 * argument: informed approval requires the user to see the full origin set,
 * not just the per-row sample (D-2).
 */
function OriginSummaryRow({ tabs }: { tabs: TabTarget[] }) {
  const counts = new Map<string, number>();
  for (const t of tabs) {
    if (t.stale) continue;
    const key = t.origin || "(unknown)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = Array.from(counts.entries());
  if (entries.length === 0) return null;
  return (
    <div
      role="status"
      className="rounded bg-neutral-800/60 border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300"
    >
      <span className="text-neutral-500">
        {entries.length} {entries.length === 1 ? "origin" : "origins"}:
      </span>{" "}
      {entries.map(([origin, count], i) => {
        const host = origin.replace(/^https?:\/\//, "");
        return (
          <span key={origin}>
            <code className="font-mono">{host}</code>
            <span className="text-neutral-500"> ({count})</span>
            {i < entries.length - 1 ? <span className="text-neutral-600">, </span> : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Phase 3 — render a list of TabTarget entries inside the confirm card.
 *
 * Each row shows favicon (if safe per SEC-5) + sanitized title + domain +
 * cross-origin marker (text label, not a colored pill — appears across many
 * rows, must be low-noise). Stale tabs (chrome.tabs.get failed at SW pre-
 * compute time) render with "(closed)" prefix and reduced opacity.
 *
 * a11y (P3-V):
 *  - aria-label on each row includes title + domain + cross-origin state
 *    so screen-readers announce all the trust-relevant info per row.
 *  - favicon img has alt="" (decorative) — accessible name comes from row text.
 *  - cross-origin tag is visible text, not solely a visual badge.
 */
function TabTargetsList({ tabs }: { tabs: TabTarget[] }) {
  if (tabs.length === 0) {
    return (
      <div className="text-xs italic text-neutral-500">(no tabs to display)</div>
    );
  }
  return (
    <ul className="space-y-1" role="list">
      {tabs.map((t) => {
        const host = t.origin.replace(/^https?:\/\//, "") || "(unknown)";
        const stale = t.stale;
        const a11yLabel = stale
          ? `Tab ${t.id}: closed or inaccessible`
          : `Tab ${t.id}: ${t.title} on ${host}${t.crossOrigin ? ", cross-origin" : ""}`;
        return (
          <li
            key={t.id}
            aria-label={a11yLabel}
            className={`flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/50 px-2 py-1 text-xs ${stale ? "opacity-60" : ""}`}
          >
            {/* favicon — decorative; alt="" so screen-readers don't double-read */}
            {t.favIconUrl ? (
              <img
                src={t.favIconUrl}
                alt=""
                className="h-4 w-4 flex-shrink-0"
                aria-hidden="true"
              />
            ) : (
              <span className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            )}
            {/* title + domain (truncate ellipsis on title) */}
            <div className="min-w-0 flex-1">
              <div className="truncate text-neutral-200">
                {stale ? "(closed) " : ""}
                {t.title}
              </div>
              <div className="truncate font-mono text-neutral-500">{host}</div>
            </div>
            {/* cross-origin text tag — fixed-width, never wraps even on narrow widths.
                Tag text rather than colored pill: appears 10-50× per card and
                colored pills create visual noise (D-7). */}
            {t.crossOrigin && !stale ? (
              <code className="flex-shrink-0 font-mono text-amber-400">cross-origin</code>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Phase 3 — get_tab_content content preview (P3-U / SEC-2). Default shows
 * the first 100 chars; expand reveals up to ~200 (full preview the SW shipped).
 * The user sees what's being sent to the BYOK provider before approving.
 *
 * a11y: the expand toggle uses aria-expanded; the preview block has
 * role="region" + aria-label so screen-readers announce it as a distinct
 * landmark within the dialog.
 */
function TabContentPreviewDetails({ preview }: { preview: TabContentPreview }) {
  const [expanded, setExpanded] = useState(false);
  const host = preview.origin.replace(/^https?:\/\//, "") || "(unknown)";
  const SHORT_LEN = 100;
  const text = preview.previewText;
  const visible = expanded ? text : text.slice(0, SHORT_LEN);
  const truncatedView = !expanded && text.length > SHORT_LEN;
  return (
    <div
      role="region"
      aria-label="Tab content preview"
      className="rounded border border-neutral-800 bg-neutral-950/70 p-2 text-xs"
    >
      <div className="mb-1 text-neutral-500">
        Content preview from <code className="font-mono">{host}</code> — showing{" "}
        {visible.length} of {preview.totalBytes} bytes
        {preview.totalBytes > preview.truncatedAtBytes ? " (truncated)" : ""}
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-neutral-300">
        {visible}
        {truncatedView ? "…" : ""}
      </pre>
      {text.length > SHORT_LEN ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="mt-1 text-xs text-neutral-400 underline hover:text-neutral-200"
        >
          {expanded ? "Show less" : `Show full preview (${text.length} chars)`}
        </button>
      ) : null}
    </div>
  );
}

function safeStringifyForPanel(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "(non-serializable)";
  }
}

/**
 * Render the EFFECTIVE skill content under review for a create_skill /
 * update_skill confirm card — the merged result that will actually persist
 * if the user approves. NO 2000-char cap (P0-D). Each field is a dedicated
 * scrollable panel with max-h so the card stays manageable.
 *
 * For update_skill, fields whose value is unchanged from the existing skill
 * are tagged "(unchanged)" so the user can quickly see what is being
 * modified without losing sight of what is being re-approved (this closes
 * adv-1, where rendering only the patch hid persistent broad capabilities
 * the user implicitly retained).
 */
function SkillContentDetails({
  tool,
  metaSkillPreview,
}: {
  tool: string;
  metaSkillPreview: {
    existing: SkillDefinition | null;
    effective: SkillDefinition;
  };
}) {
  const isUpdate = tool === "update_skill";
  const eff = metaSkillPreview.effective;
  const existing = metaSkillPreview.existing;

  // Helper: is this field unchanged from existing? Only meaningful for update_skill.
  const unchanged = (key: "name" | "description" | "promptTemplate") =>
    isUpdate && existing !== null && existing[key] === eff[key];
  const parametersUnchanged =
    isUpdate &&
    existing !== null &&
    safeStringifyForPanel(existing.toolSchema.parameters) === safeStringifyForPanel(eff.toolSchema.parameters);
  const allowedToolsUnchanged =
    isUpdate &&
    existing !== null &&
    JSON.stringify(existing.allowedTools ?? null) === JSON.stringify(eff.allowedTools ?? null);

  const allowedTools = eff.allowedTools;

  return (
    <div className="space-y-2.5">
      <div className="rounded bg-amber-950/40 border border-amber-700/60 px-2 py-1 text-xs text-amber-300">
        {isUpdate ? (
          <>
            Updating <code className="font-mono">{existing?.id ?? eff.id}</code>. After approval the skill is re-marked as agent-authored and the user will be asked to re-confirm on its next execution. Fields tagged "(unchanged)" stay as they were.
          </>
        ) : (
          <>Creating a new agent-authored skill. The user will be asked to re-confirm on its first execution.</>
        )}
      </div>
      {isUpdate && existing !== null && (
        <div>
          <div className="text-xs text-neutral-500">id:</div>
          <code className="font-mono text-xs text-neutral-300 break-all">{existing.id}</code>
        </div>
      )}
      <div>
        <div className="text-xs text-neutral-500">
          name: {unchanged("name") && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <div className="text-neutral-200">{eff.name}</div>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          description: {unchanged("description") && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <div className="text-neutral-300 whitespace-pre-wrap break-words">{eff.description}</div>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          promptTemplate ({eff.promptTemplate.length} chars){" "}
          {unchanged("promptTemplate") && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <pre className="max-h-64 overflow-auto rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-300 whitespace-pre-wrap break-words">
          {eff.promptTemplate}
        </pre>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          parameters (JSON Schema):{" "}
          {parametersUnchanged && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        <pre className="max-h-48 overflow-auto rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-300">
          {safeStringifyForPanel(eff.toolSchema.parameters)}
        </pre>
      </div>
      <div>
        <div className="text-xs text-neutral-500">
          allowedTools: {allowedToolsUnchanged && <span className="text-neutral-600">(unchanged)</span>}
        </div>
        {allowedTools === null || allowedTools === undefined ? (
          <div className="text-xs italic text-neutral-500">(legacy: no scope restriction)</div>
        ) : allowedTools.length === 0 ? (
          <div className="text-xs italic text-neutral-500">(empty — only done / fail callable inside this skill's scope)</div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {allowedTools.map((t, i) => (
              <code
                key={i}
                className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-neutral-300"
              >
                {t}
              </code>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentConfirmCard({
  tool,
  args,
  resolvedElement,
  riskReason,
  resolved,
  onApprove,
  onReject,
  metaSkillPreview,
  tabTargets,
  contentPreview,
}: AgentConfirmCardProps) {
  function handleKeyDown(e: React.KeyboardEvent) {
    // Prevent Enter from accidentally triggering Approve
    if (e.key === "Enter") {
      e.preventDefault();
    }
  }

  const isMeta = isSkillMetaTool(tool);
  const hasTabTargets = !!tabTargets && tabTargets.length > 0;

  // a11y: stable id for aria-labelledby (P3-V).
  const headingId = `agent-confirm-heading-${tool}`;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      className="rounded bg-red-950/30 border border-red-800 p-3 text-sm"
      onKeyDown={handleKeyDown}
    >
      {/* Heading */}
      <div id={headingId} className="mb-2 font-semibold text-red-400">
        [!] Confirm action
      </div>

      {/* Risk reason */}
      <div className="mb-2 text-xs text-red-300">{riskReason}</div>

      {/* Tool name */}
      <div className="mb-2">
        <span className="text-neutral-400 text-xs">Tool: </span>
        <code className="font-mono text-neutral-200">{tool}</code>
      </div>

      {/* Phase 3 — origin summary row above the tab list. Stays visible
          even if tabTargets list is virtualized / truncated; protects K-1
          informed-approval invariant (D-2). */}
      {hasTabTargets ? (
        <div className="mb-2">
          <OriginSummaryRow tabs={tabTargets!} />
        </div>
      ) : null}

      {/* Resolved element — only for DOM-targeted tools (skip for meta tools whose
          resolvedElement is a placeholder, AND skip for cross-tab tools where
          tabTargets carries the trust-decision payload). */}
      {!isMeta && !hasTabTargets && (
        <div className="mb-2 space-y-0.5 text-xs">
          <div>
            <span className="text-neutral-500">tag: </span>
            <code className="font-mono text-neutral-300">
              {"<"}
              {resolvedElement.tag}
              {">"}
            </code>
          </div>
          {resolvedElement.text && (
            <div>
              <span className="text-neutral-500">text: </span>
              <span className="text-neutral-300">{resolvedElement.text}</span>
            </div>
          )}
          {resolvedElement.ariaLabel && (
            <div>
              <span className="text-neutral-500">aria-label: </span>
              <span className="text-neutral-300">{resolvedElement.ariaLabel}</span>
            </div>
          )}
          {resolvedElement.type && (
            <div>
              <span className="text-neutral-500">type: </span>
              <span className="text-neutral-300">{resolvedElement.type}</span>
            </div>
          )}
          {resolvedElement.href && (
            <div>
              <span className="text-neutral-500">href: </span>
              <span className="text-neutral-300 break-all">{resolvedElement.href}</span>
            </div>
          )}
        </div>
      )}

      {/* Phase 3 tabTargets list (P3-E) */}
      {hasTabTargets ? (
        <div className="mb-3">
          <TabTargetsList tabs={tabTargets!} />
        </div>
      ) : null}

      {/* Phase 3 content preview for get_tab_content (P3-U / SEC-2) */}
      {contentPreview ? (
        <div className="mb-3">
          <TabContentPreviewDetails preview={contentPreview} />
        </div>
      ) : null}

      {/* Args — meta tools render the EFFECTIVE merged skill (P0-D no cap,
          adv-1 closure: update_skill must show retained fields, not just
          the patch). Cross-tab tools render via tabTargets above. Falls
          back to the generic args dump only when none of those carry the
          trust-decision payload. */}
      {!hasTabTargets ? (
        <div className="mb-3">
          {isMeta && metaSkillPreview ? (
            <SkillContentDetails tool={tool} metaSkillPreview={metaSkillPreview} />
          ) : (
            <>
              <div className="mb-0.5 text-xs text-neutral-500">args:</div>
              <pre className="overflow-x-auto rounded bg-neutral-950 p-1.5 font-mono text-xs text-neutral-300">
                {safeStringifyArgs(redactArgsForDisplay(tool, args, riskReason))}
              </pre>
            </>
          )}
        </div>
      ) : null}

      {/* Action buttons or resolved status */}
      {resolved ? (
        <div
          className={`text-xs font-mono ${
            resolved === "approved" ? "text-green-400" : "text-neutral-400"
          }`}
        >
          {resolved === "approved" ? "Approved" : "Rejected"}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={onReject}
            autoFocus
            className="rounded bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600 focus:outline focus:outline-2 focus:outline-neutral-500"
          >
            Reject
          </button>
          <button
            onClick={onApprove}
            className="rounded bg-red-700 px-3 py-1.5 text-xs text-white hover:bg-red-600 focus:outline focus:outline-2 focus:outline-red-500"
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
