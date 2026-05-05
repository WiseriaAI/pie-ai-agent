import { useState } from "react";
import type { ResolvedElement, TabTarget, TabContentPreview, ScreenshotConfirmExtras, OpenUrlConfirmExtras } from "@/types";
import type { SkillDefinition } from "@/lib/skills";

interface AgentConfirmCardProps {
  tool: string;
  args: unknown;
  resolvedElement: ResolvedElement;
  riskReason: string;
  resolved?: "approved" | "rejected";
  onApprove: () => void;
  onReject: () => void;
  metaSkillPreview?: {
    existing: SkillDefinition | null;
    effective: SkillDefinition;
  };
  tabTargets?: TabTarget[];
  contentPreview?: TabContentPreview;
  screenshotPreview?: ScreenshotConfirmExtras;
  openUrlPreview?: OpenUrlConfirmExtras;
}

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

function isSkillMetaTool(tool: string): boolean {
  return tool === "create_skill" || tool === "update_skill";
}

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
      className="rounded border border-line bg-field px-2.5 py-1.5 text-[12px] text-fg-1"
    >
      <span className="text-fg-3">
        {entries.length} {entries.length === 1 ? "origin" : "origins"}:
      </span>{" "}
      {entries.map(([origin, count], i) => {
        const host = origin.replace(/^https?:\/\//, "");
        return (
          <span key={origin}>
            <code className="font-mono">{host}</code>
            <span className="text-fg-3"> ({count})</span>
            {i < entries.length - 1 ? <span className="text-fg-3">, </span> : null}
          </span>
        );
      })}
    </div>
  );
}

function TabTargetsList({ tabs }: { tabs: TabTarget[] }) {
  if (tabs.length === 0) {
    return <div className="text-[12px] italic text-fg-3">(no tabs to display)</div>;
  }
  return (
    <ul className="flex flex-col gap-1" role="list">
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
            className={`flex items-center gap-2 rounded border border-line bg-field px-2.5 py-1.5 text-[12px] ${
              stale ? "opacity-60" : ""
            }`}
          >
            {t.favIconUrl ? (
              <img
                src={t.favIconUrl}
                alt=""
                className="h-4 w-4 flex-shrink-0"
                aria-hidden="true"
              />
            ) : (
              <div
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-fg-3"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-fg-1">
                {stale ? "(closed) " : ""}
                {t.title}
              </div>
              <div className="truncate font-mono text-[10px] text-fg-3">{host}</div>
            </div>
            {t.crossOrigin && !stale ? (
              <code className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-accent">
                cross-origin
              </code>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

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
      className="rounded border border-line bg-field p-2.5 text-[12px]"
    >
      <div className="mb-1 text-fg-3">
        Content preview from <code className="font-mono">{host}</code> — showing{" "}
        {visible.length} of {preview.totalBytes} bytes
        {preview.totalBytes > preview.truncatedAtBytes ? " (truncated)" : ""}
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-2">
        {visible}
        {truncatedView ? "…" : ""}
      </pre>
      {text.length > SHORT_LEN ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="mt-1.5 text-[11px] text-fg-2 underline hover:text-fg-1"
        >
          {expanded ? "Show less" : `Show full preview (${text.length} chars)`}
        </button>
      ) : null}
    </div>
  );
}

const OPEN_URL_FOLD_THRESHOLD = 1024;

function OpenUrlConfirmContent({ preview }: { preview: OpenUrlConfirmExtras }) {
  const [expanded, setExpanded] = useState(false);
  const long = preview.url.length >= OPEN_URL_FOLD_THRESHOLD;
  return (
    <div
      role="region"
      aria-label="Open URL preview"
      className="flex flex-col gap-2 rounded border border-line bg-field p-2.5"
    >
      <div className="text-[12px] text-fg-2">Open new tab at:</div>
      <div className="font-mono text-[11px] break-all text-fg-1">
        {long && !expanded ? (
          <>
            {preview.url.slice(0, 256)}{"…"}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="ml-2 text-accent underline"
            >
              show full URL
            </button>
          </>
        ) : (
          preview.url
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-fg-3">
        <span className="font-mono">{preview.host}</span>
        {preview.active ? (
          <span className="rounded border border-warning-line bg-warning-tint px-1.5 py-0.5 text-warning font-medium">
            WILL STEAL FOCUS
          </span>
        ) : (
          <span className="rounded border border-line bg-field px-1.5 py-0.5 text-fg-3">
            loads in background
          </span>
        )}
      </div>
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
    <div className="flex flex-col gap-2.5">
      <div className="rounded border border-accent-line bg-accent-tint px-2.5 py-1.5 text-[12px] text-accent">
        {isUpdate ? (
          <>
            Updating <code className="font-mono">{existing?.id ?? eff.id}</code>. After
            approval the skill is re-marked as agent-authored and the user will be asked
            to re-confirm on its next execution. Fields tagged "(unchanged)" stay as they were.
          </>
        ) : (
          <>Creating a new agent-authored skill. The user will be asked to re-confirm on its first execution.</>
        )}
      </div>
      {isUpdate && existing !== null && (
        <div>
          <div className="text-[11px] text-fg-3">id:</div>
          <code className="break-all font-mono text-[12px] text-fg-2">{existing.id}</code>
        </div>
      )}
      <div>
        <div className="text-[11px] text-fg-3">
          name: {unchanged("name") && <span className="text-fg-3">(unchanged)</span>}
        </div>
        <div className="text-[13px] text-fg-1">{eff.name}</div>
      </div>
      <div>
        <div className="text-[11px] text-fg-3">
          description: {unchanged("description") && <span className="text-fg-3">(unchanged)</span>}
        </div>
        <div className="whitespace-pre-wrap break-words text-[12px] text-fg-1">{eff.description}</div>
      </div>
      <div>
        <div className="text-[11px] text-fg-3">
          promptTemplate ({eff.promptTemplate.length} chars){" "}
          {unchanged("promptTemplate") && <span className="text-fg-3">(unchanged)</span>}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-field p-2 font-mono text-[11px] text-fg-1">
          {eff.promptTemplate}
        </pre>
      </div>
      <div>
        <div className="text-[11px] text-fg-3">
          parameters (JSON Schema):{" "}
          {parametersUnchanged && <span className="text-fg-3">(unchanged)</span>}
        </div>
        <pre className="max-h-48 overflow-auto rounded border border-line bg-field p-2 font-mono text-[11px] text-fg-2">
          {safeStringifyForPanel(eff.toolSchema.parameters)}
        </pre>
      </div>
      <div>
        <div className="text-[11px] text-fg-3">
          allowedTools: {allowedToolsUnchanged && <span className="text-fg-3">(unchanged)</span>}
        </div>
        {allowedTools === null || allowedTools === undefined ? (
          <div className="text-[11px] italic text-fg-3">(legacy: no scope restriction)</div>
        ) : allowedTools.length === 0 ? (
          <div className="text-[11px] italic text-fg-3">
            (empty — only done / fail callable inside this skill's scope)
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {allowedTools.map((t, i) => (
              <code
                key={i}
                className="rounded border border-line bg-field px-1.5 py-0.5 font-mono text-[11px] text-fg-1"
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

/**
 * Build a one-line action summary that fits to the right of "⚠ X — high risk".
 * Different tools have different "what's at stake" — surface that on the
 * default-visible row so the user knows what they're approving without
 * having to expand details. (Informed-spending invariant.)
 */
function describeAction(
  tool: string,
  resolvedElement: ResolvedElement | undefined,
  tabTargets: TabTarget[] | undefined,
  openUrlPreview?: OpenUrlConfirmExtras,
): string {
  if (tabTargets && tabTargets.length > 0) {
    const live = tabTargets.filter((t) => !t.stale);
    return `${live.length} tab${live.length === 1 ? "" : "s"}`;
  }
  if (tool === "open_url" && openUrlPreview) return openUrlPreview.host;
  if (tool === "create_skill") return "create new skill";
  if (tool === "update_skill") return "update existing skill";
  if (resolvedElement) {
    const t = resolvedElement.text ?? resolvedElement.ariaLabel ?? "";
    const trimmed = t.length > 28 ? t.slice(0, 25) + "..." : t;
    if (trimmed) return `<${resolvedElement.tag}> "${trimmed}"`;
    return `<${resolvedElement.tag}>`;
  }
  return "";
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
  screenshotPreview,
  openUrlPreview,
}: AgentConfirmCardProps) {
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
    }
  }

  const isMeta = isSkillMetaTool(tool);
  const hasTabTargets = !!tabTargets && tabTargets.length > 0;
  const headingId = `agent-confirm-heading-${tool}`;
  const actionSummary = describeAction(tool, resolvedElement, tabTargets, openUrlPreview);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-warning-line bg-surface p-3"
      onKeyDown={handleKeyDown}
    >
      {/* Compact title row: ⚠ tool — high risk · action summary */}
      <div id={headingId} className="flex items-baseline gap-1.5 text-[13px] leading-[18px]">
        <span aria-hidden="true" className="text-warning">
          ⚠
        </span>
        <code className="font-mono text-fg-1">{tool}</code>
        {actionSummary && (
          <>
            <span className="text-fg-3">·</span>
            <span className="truncate text-fg-2" title={actionSummary}>
              {actionSummary}
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-warning">
          HIGH RISK
        </span>
      </div>

      {/* Risk reason — one short paragraph, never truncated. */}
      <div className="text-[12px] leading-[18px] text-fg-2">{riskReason}</div>

      {/* Phase 5 — screenshot preview thumbnail (K-1 informed-approval).
          Rendered BEFORE the foldable details block so the user sees the
          exact image the LLM will receive without having to expand anything.
          Absent when pre-capture failed or is not applicable to the tool. */}
      {screenshotPreview ? (
        <div className="screenshot-preview" style={{ marginBottom: 12 }}>
          <img
            src={`data:${screenshotPreview.mediaType};base64,${screenshotPreview.thumbnail}`}
            alt="Screenshot preview that the agent will receive"
            style={{
              maxWidth: "100%",
              height: "auto",
              borderRadius: 4,
              border: "1px solid var(--c-line)",
            }}
          />
          <p style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            Approving sends this exact image to the LLM. Re-prompts if &gt; 5 s elapses.
          </p>
        </div>
      ) : null}

      {/* Foldable details. All previously always-visible blocks (resolvedElement
          attributes, args JSON, skill diff, tab list, content preview) live
          here so the default card stays small. The user can still see
          everything before approving — informed-spending preserved. */}
      <details className="group">
        <summary className="flex cursor-pointer select-none items-center gap-1 self-start font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg-2">
          <span className="transition-transform group-open:rotate-90">›</span>
          <span>Details</span>
        </summary>

        <div className="mt-2 flex flex-col gap-2.5">
          {hasTabTargets ? <OriginSummaryRow tabs={tabTargets!} /> : null}

          {!isMeta && !hasTabTargets && (
            <div className="flex flex-col gap-1 rounded border border-line bg-field px-2.5 py-2 text-[12px]">
              <div>
                <span className="text-fg-3">tag </span>
                <code className="font-mono text-fg-1">
                  &lt;{resolvedElement.tag}&gt;
                </code>
              </div>
              {resolvedElement.text && (
                <div>
                  <span className="text-fg-3">text </span>
                  <span className="text-fg-1">{resolvedElement.text}</span>
                </div>
              )}
              {resolvedElement.ariaLabel && (
                <div>
                  <span className="text-fg-3">aria-label </span>
                  <span className="text-fg-1">{resolvedElement.ariaLabel}</span>
                </div>
              )}
              {resolvedElement.type && (
                <div>
                  <span className="text-fg-3">type </span>
                  <span className="text-fg-1">{resolvedElement.type}</span>
                </div>
              )}
              {resolvedElement.href && (
                <div>
                  <span className="text-fg-3">href </span>
                  <span className="break-all text-fg-1">{resolvedElement.href}</span>
                </div>
              )}
            </div>
          )}

          {hasTabTargets ? <TabTargetsList tabs={tabTargets!} /> : null}

          {contentPreview ? <TabContentPreviewDetails preview={contentPreview} /> : null}

          {tool === "open_url" && openUrlPreview ? (
            <OpenUrlConfirmContent preview={openUrlPreview} />
          ) : null}

          {!hasTabTargets ? (
            <>
              {isMeta && metaSkillPreview ? (
                <SkillContentDetails tool={tool} metaSkillPreview={metaSkillPreview} />
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                    args
                  </div>
                  <pre className="overflow-x-auto rounded border border-line bg-field p-2 font-mono text-[11px] leading-4 text-fg-2">
                    {safeStringifyArgs(redactArgsForDisplay(tool, args, riskReason))}
                  </pre>
                </div>
              )}
            </>
          ) : null}
        </div>
      </details>

      {resolved ? (
        <div
          className={`font-mono text-[10px] uppercase tracking-[0.12em] ${
            resolved === "approved" ? "text-fg-2" : "text-fg-3"
          }`}
        >
          {resolved === "approved" ? "✓ APPROVED" : "✕ REJECTED"}
        </div>
      ) : (
        <div className="flex gap-2 pt-0.5">
          <button
            onClick={onReject}
            autoFocus
            className="flex-1 rounded-md border border-line bg-transparent px-3 py-1.5 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1 focus:outline focus:outline-2 focus:outline-fg-3"
          >
            Reject
          </button>
          <button
            onClick={onApprove}
            className="flex-1 rounded-md border border-warning-line bg-transparent px-3 py-1.5 text-[12px] font-medium text-warning hover:bg-warning-tint focus:outline focus:outline-2 focus:outline-warning"
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
