import MarkdownContent from "./Markdown";

interface AgentSummaryProps {
  success: boolean;
  summary: string;
  stepCount: number;
}

export default function AgentSummary({
  success,
  summary,
  stepCount,
}: AgentSummaryProps) {
  return (
    <div
      className={`rounded bg-neutral-900 border-l-4 p-3 text-sm ${
        success ? "border-l-green-600" : "border-l-red-600"
      }`}
    >
      {/* Icon + status */}
      <div
        className={`mb-1 font-semibold ${
          success ? "text-green-400" : "text-red-400"
        }`}
      >
        {success ? "[OK]" : "[FAIL]"}{" "}
        {success ? "Task completed" : "Task failed"}
      </div>

      {/* Summary — rendered as markdown (LLM may produce structured output) */}
      <div className="mb-2 text-neutral-200">
        <MarkdownContent content={summary} />
      </div>

      {/* Step count footer */}
      <div className="text-xs text-neutral-500">
        {success
          ? `Completed in ${stepCount} step${stepCount !== 1 ? "s" : ""}`
          : `Failed at step ${stepCount}`}
      </div>
    </div>
  );
}
