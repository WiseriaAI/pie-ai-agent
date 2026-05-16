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
 * Each line has a [详情] toggle that expands to args + observation +
 * resolvedElement, matching what the old AgentStepBubble showed but without
 * the surrounding card border + 14px padding.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n";
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
      <div className="flex items-center gap-2 text-[12px]">
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
        {status === "error" && observation && (
          <span className="truncate text-fg-3" title={observation}>
            · {firstLine(observation)}
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg-2"
        >
          {expanded ? t("agentStep.collapse") : t("agentStep.expand")}
        </button>
      </div>

      {expanded && (
        <div className="ml-4 flex flex-col gap-1.5 border-l border-line pl-2.5 text-[11px]">
          {resolvedElement && (
            <div className="font-mono leading-4 text-fg-2">
              <span className="text-fg-3">element </span>
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
              args
            </div>
            <pre className="mt-1 overflow-x-auto rounded border border-line bg-field p-2 font-mono leading-4 text-fg-2">
              {safeStringify(args)}
            </pre>
          </div>
          {image && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                screenshot
              </div>
              <img
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={`screenshot ${image.width}x${image.height}`}
                className="mt-1 max-w-full rounded border border-line"
              />
            </div>
          )}
          {observation && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                observation
              </div>
              <div className="mt-1 whitespace-pre-wrap leading-4 text-fg-2">
                {observation}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: "pending" | "ok" | "error" }) {
  if (status === "pending") {
    return (
      <span
        aria-label="running"
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
        aria-label="error"
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
      aria-label="ok"
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

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "(non-serializable)";
  }
}
