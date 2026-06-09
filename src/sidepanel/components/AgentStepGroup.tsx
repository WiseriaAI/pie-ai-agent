/**
 * AgentStepGroup — collapses a run of consecutive agent-step messages into
 * a compact section. The user wants in-place "正在调用 X..." status instead
 * of stacked cards.
 *
 * Layout (top to bottom):
 *   1. Optional "N STEPS DONE" toggle row that expands a tight list of all
 *      finished steps. Hidden when there are 0 done steps.
 *   2. Active step row (or last error/ok step if no pending step). Always
 *      visible.
 *
 * The active row uses React reconciliation for in-place text replacement:
 *   - We render a single AgentStepLine at this slot, keyed by a stable id
 *     (the group itself, not the per-step index). When the SW pushes a new
 *     pending step that replaces the previous pending, React reuses the same
 *     DOM node — so the bubble-in keyframe applied at the wrapper level does
 *     NOT replay.
 *   - When the pending step finishes (status pending → ok), the same line
 *     transitions colors in place; no remount.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n";
import AgentStepLine from "./AgentStepLine";
import type { ResolvedElement } from "@/types";
import type { AgentStepImageExtras } from "@/types/messages";

export interface AgentStepData {
  stepIndex: number;
  tool: string;
  args: unknown;
  resolvedElement?: ResolvedElement;
  status: "pending" | "ok" | "error";
  observation?: string;
  image?: AgentStepImageExtras;
}

interface AgentStepGroupProps {
  /** Done steps (status ok or error, but NOT the trailing active step). */
  doneSteps: AgentStepData[];
  /** The current step. May be pending, ok, or error. Always rendered. */
  currentStep: AgentStepData;
}

export default function AgentStepGroup({
  doneSteps,
  currentStep,
}: AgentStepGroupProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const t = useT();

  return (
    <div className="flex w-full flex-col gap-1.5">
      {doneSteps.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            className="flex items-center gap-1.5 self-start font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg-2"
          >
            <span
              className="inline-block transition-transform"
              style={{ transform: historyOpen ? "rotate(90deg)" : "rotate(0deg)" }}
            >
              ›
            </span>
            <span>
              {doneSteps.length}{" "}
              {doneSteps.length === 1 ? t("agentStepGroup.step") : t("agentStepGroup.steps")}
              {t("agentStepGroup.done")}
            </span>
          </button>
          {historyOpen && (
            <div className="ml-3 flex flex-col gap-1.5 border-l border-line pl-2.5">
              {doneSteps.map((s) => (
                <AgentStepLine
                  key={s.stepIndex}
                  tool={s.tool}
                  args={s.args}
                  resolvedElement={s.resolvedElement}
                  status={s.status}
                  observation={s.observation}
                  image={s.image}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Current step. Keyed only by the group's identity (not stepIndex)
          so React reuses this DOM across pending → next-pending transitions
          and the wrapper bubble-in animation never replays. */}
      <AgentStepLine
        tool={currentStep.tool}
        args={currentStep.args}
        resolvedElement={currentStep.resolvedElement}
        status={currentStep.status}
        observation={currentStep.observation}
        image={currentStep.image}
      />
    </div>
  );
}
