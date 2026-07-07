import { useState } from "react";
import { useT } from "@/lib/i18n";

interface AgentOption {
  id: string;
  label: string;
}
interface Props {
  payload: { context: string; fileCount: number; agents: AgentOption[] };
  onDecision: (target: string | null) => void;
}

/**
 * Authorization gate shown before the SW hands a task OFF to a local interactive
 * agent session. The user picks the recipient here (the LLM cannot — recipient
 * choice and authorization are one step). Context is rendered verbatim so the
 * user sees exactly what will be written to context.md.
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  const [selected, setSelected] = useState(payload.agents[0]?.id ?? "");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("handoff.title")}</div>
      {/* 语义副文案：与 run_local_agent 卡的核心区分——任务移交出去，结果不回来 */}
      <div className="text-[12px] leading-relaxed text-warning/70">{t("handoff.semanticsNote")}</div>
      <div>
        <div className="text-warning/70">{t("handoff.targetLabel")}</div>
        <div className="mt-1 flex flex-col gap-1">
          {payload.agents.map((a) => (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-2 rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning"
            >
              <input
                type="radio"
                name="handoff-target"
                checked={selected === a.id}
                onChange={() => setSelected(a.id)}
              />
              <span>{a.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="text-warning/70">{t("handoff.contextLabel")}</div>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.context}
        </pre>
      </div>
      {payload.fileCount > 0 && (
        <div className="text-warning/70">
          {t("handoff.filesLabel")}: {payload.fileCount}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(selected)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("handoff.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(null)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("handoff.deny")}
        </button>
      </div>
    </div>
  );
}
