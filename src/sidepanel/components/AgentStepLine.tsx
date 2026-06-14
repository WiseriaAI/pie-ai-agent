/**
 * AgentStepLine — compact single-row representation of one agent step.
 *
 * Three visual states:
 *   - pending: spinning dot + "正在调用 X..." (in-place text replaces between
 *     tool calls, so React reconciliation keeps the same DOM and the
 *     bubble-in animation does NOT replay each step)
 *   - ok:      check mark + tool name (faint)
 *   - error:   ✕ + tool name + first line of observation (always visible,
 *     never auto-collapsed — errors deserve attention)
 *
 * The whole header row is the toggle: clicking it expands args + observation
 * + resolvedElement. The affordance is a small ">" chevron sitting right after
 * the tool name (rotates 90° when open) — no "详情" label. The expanded block
 * fades/slides in (view-enter) and caps args/observation height with an inner
 * scroll so a long tool result no longer stretches the whole chat.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Collapse } from "./ui/Collapse";
import type { ResolvedElement } from "@/types";
import type { AgentStepImageExtras } from "@/types/messages";

interface AgentStepLineProps {
  tool: string;
  args: unknown;
  resolvedElement?: ResolvedElement;
  status: "pending" | "ok" | "error";
  observation?: string;
  /** Initial expanded state. Currently always false; kept for future
   *  per-step persistence if useful. */
  defaultExpanded?: boolean;
  /** Phase 5 follow-up — screenshot tools attach the captured JPEG so the
   *  details block renders the same image alongside the text observation. */
  image?: AgentStepImageExtras;
}

export default function AgentStepLine({
  tool,
  args,
  resolvedElement,
  status,
  observation,
  defaultExpanded = false,
  image,
}: AgentStepLineProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const t = useT();

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? t("agentStep.collapse") : t("agentStep.expand")}
        className="flex w-full items-center gap-2 text-left text-[12px]"
      >
        <StatusDot status={status} />
        <span className={statusTextClass(status)}>
          {status === "pending" ? (
            <>
              {t("agentStep.callingToolPrefix")} <code className="font-mono text-fg-1">{tool}</code>
              <span className="text-fg-3">…</span>
            </>
          ) : (
            <code className="font-mono text-fg-1">{tool}</code>
          )}
        </span>
        <span
          aria-hidden="true"
          className="inline-block flex-shrink-0 text-fg-3 transition-transform duration-200"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ›
        </span>
        {status === "error" && observation && (
          <span className="min-w-0 truncate text-fg-3" title={observation}>
            · {firstLine(observation)}
          </span>
        )}
      </button>

      <Collapse open={expanded} className="ml-4 flex flex-col gap-1.5 border-l border-line pl-2.5 text-[11px]">
          {resolvedElement && (
            <div className="font-mono leading-4 text-fg-2">
              <span className="text-fg-3">{t("agentStep.element")}</span>
              &lt;{resolvedElement.tag}&gt;
              {resolvedElement.text && (
                <span className="text-fg-3">
                  {" "}
                  "
                  {resolvedElement.text.length > 60
                    ? resolvedElement.text.slice(0, 57) + "..."
                    : resolvedElement.text}
                  "
                </span>
              )}
            </div>
          )}
          <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                {t("agentStep.args")}
              </div>
            <pre className="mt-1 max-h-60 overflow-auto rounded border border-line bg-field p-2 font-mono leading-4 text-fg-2">
              {safeStringify(args, t("agentStep.nonSerializable"))}
            </pre>
          </div>
          {image && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                {t("agentStep.screenshot")}
              </div>
              <img
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={t("agentStep.screenshotAlt", { width: image.width, height: image.height })}
                className="mt-1 max-w-full rounded border border-line"
              />
            </div>
          )}
          {observation && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                {t("agentStep.observation")}
              </div>
              <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words leading-4 text-fg-2">
                {observation}
              </div>
            </div>
          )}
      </Collapse>
    </div>
  );
}

function StatusDot({ status }: { status: "pending" | "ok" | "error" }) {
  const tLoc = useT();
  if (status === "pending") {
    return (
      <span
        aria-label={tLoc("agentStep.running")}
        className="relative flex h-3 w-3 flex-shrink-0 items-center justify-center"
      >
        <span className="absolute inset-0 rounded-full border border-accent-line" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        aria-label={tLoc("agentStep.error")}
        className="flex h-3 w-3 flex-shrink-0 items-center justify-center"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
            stroke="var(--c-warning)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-label={tLoc("agentStep.ok")}
      className="flex h-3 w-3 flex-shrink-0 items-center justify-center"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path
          d="M2 5L4.2 7L8 3"
          stroke="var(--c-fg-3)"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function statusTextClass(status: "pending" | "ok" | "error"): string {
  if (status === "pending") return "text-fg-1";
  if (status === "error") return "text-warning";
  return "text-fg-2";
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  const line = i === -1 ? s : s.slice(0, i);
  return line.length > 80 ? line.slice(0, 77) + "..." : line;
}

function safeStringify(v: unknown, fallback: string): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return fallback;
  }
}
