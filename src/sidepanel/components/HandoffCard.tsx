import { useT } from "@/lib/i18n";

interface Props {
  payload: { context: string; target: string; fileCount: number };
  onDecision: (ok: boolean) => void;
}

/**
 * Authorization gate shown before the SW hands a task OFF to a local interactive
 * agent session (opens a real terminal). Context is rendered verbatim so the user
 * sees exactly what will be written to context.md — mirrors RunLocalAgentCard.
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("handoff.title")}</div>
      <div>
        <div className="text-warning/70">{t("handoff.targetLabel")}</div>
        <code className="mt-1 block break-all rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.target}
        </code>
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
          onClick={() => onDecision(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("handoff.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("handoff.deny")}
        </button>
      </div>
    </div>
  );
}
