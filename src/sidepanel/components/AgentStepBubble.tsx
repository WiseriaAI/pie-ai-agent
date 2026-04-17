import type { ResolvedElement } from "@/types";

interface AgentStepBubbleProps {
  stepIndex: number;
  tool: string;
  args: unknown;
  resolvedElement?: ResolvedElement;
  status: "pending" | "ok" | "error";
  observation?: string;
}

export default function AgentStepBubble({
  stepIndex,
  tool,
  args,
  resolvedElement,
  status,
  observation,
}: AgentStepBubbleProps) {
  const statusBadge =
    status === "pending"
      ? "bg-yellow-900/60 text-yellow-400 border border-yellow-700"
      : status === "ok"
        ? "bg-green-900/60 text-green-400 border border-green-700"
        : "bg-red-900/60 text-red-400 border border-red-700";

  const statusLabel =
    status === "pending" ? "pending" : status === "ok" ? "ok" : "error";

  const elementText = resolvedElement
    ? resolvedElement.text.length > 60
      ? resolvedElement.text.slice(0, 57) + "..."
      : resolvedElement.text
    : null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded bg-neutral-900 border border-neutral-700 p-2 text-xs">
        {/* Header row */}
        <div className="flex items-center gap-2">
          <span className="text-neutral-500 tabular-nums">{stepIndex}.</span>
          <code className="font-mono text-neutral-200">{tool}</code>
          <span
            className={`ml-auto rounded px-1.5 py-0.5 text-xs font-mono ${statusBadge}`}
          >
            {statusLabel}
          </span>
        </div>

        {/* Resolved element */}
        {resolvedElement && (
          <div className="mt-1 font-mono text-neutral-400">
            {"<"}
            {resolvedElement.tag}
            {">"}{" "}
            {elementText ? `"${elementText}"` : ""}
          </div>
        )}

        {/* Args */}
        <details className="mt-1">
          <summary className="cursor-pointer text-neutral-500 select-none">
            args
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-neutral-950 p-1 font-mono text-neutral-300">
            {JSON.stringify(args, null, 2)}
          </pre>
        </details>

        {/* Observation */}
        {observation && (
          <div className="mt-2 border-t border-neutral-700 pt-1.5 italic text-neutral-400">
            {observation}
          </div>
        )}
      </div>
    </div>
  );
}
