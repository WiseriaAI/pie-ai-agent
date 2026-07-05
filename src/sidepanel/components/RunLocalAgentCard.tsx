import { useT } from "@/lib/i18n";

interface Props {
  payload: { prompt: string; cwd: string };
  onDecision: (ok: boolean) => void;
}

/**
 * Authorization gate shown before the SW spawns a local `claude -p` process
 * over the local-bridge unix socket. Prompt + cwd are rendered verbatim (not
 * paraphrased) so the user sees exactly what will run and where — mirrors
 * CdpOnboardingCard / LocalFileRequestCard's warning styling.
 */
export function RunLocalAgentCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">
        {t("runLocalAgent.title")}
      </div>
      <div>
        <div className="text-warning/70">{t("runLocalAgent.cwdLabel")}</div>
        <code className="mt-1 block break-all rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.cwd}
        </code>
      </div>
      <div>
        <div className="text-warning/70">{t("runLocalAgent.taskLabel")}</div>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.prompt}
        </pre>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("runLocalAgent.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("runLocalAgent.deny")}
        </button>
      </div>
    </div>
  );
}
