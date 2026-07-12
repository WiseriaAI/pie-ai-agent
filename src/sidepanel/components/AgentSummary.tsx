import { useT } from "@/lib/i18n";
import MarkdownContent from "./Markdown";
import PieFace from "./PieFace";

interface AgentSummaryProps {
  success: boolean;
  summary: string;
  stepCount: number;
  /** Pie IP 完成庆祝（仅 success 时生效）；由 Chat 只对最后一行传 true。 */
  celebrating?: boolean;
}

export default function AgentSummary({
  success,
  summary,
  stepCount,
  celebrating = false,
}: AgentSummaryProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2.5 pt-2">
      <div className="flex items-center gap-2">
        <PieFace
          state={celebrating && success ? "success" : "static"}
          size={16}
        />
        <span
          className={`caps ${success ? "text-fg-2" : "text-warning"}`}
        >
          {success
            ? t("agentSummary.doneSteps", { count: stepCount })
            : t("agentSummary.failedAtStep", { step: stepCount })}
        </span>
      </div>
      <div className="text-[13px] leading-5 text-fg-1">
        <MarkdownContent content={summary} />
      </div>
    </div>
  );
}
