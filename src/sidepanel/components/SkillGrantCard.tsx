import { useT } from "@/lib/i18n";

interface Props {
  payload: { skillId: string; skillName: string; entry: string; perms: { fs: boolean; network: string[] } };
  onDecision: (approved: boolean) => void;
}

/**
 * Authorization gate before a skill's privileged (filesystem) script runs on the
 * local daemon. Perms are shown verbatim (spec §6.1: write-class local actions
 * have no silent path). Approving persists a grant keyed by skill + perms + script
 * content hash — a code change re-prompts.
 */
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("skillGrant.title")}</div>
      <div className="text-[12px] leading-relaxed text-warning/70">{t("skillGrant.semanticsNote")}</div>
      <div>
        <div className="text-warning/70">{t("skillGrant.skillLabel")}</div>
        <div className="mt-1 text-warning">{payload.skillName}</div>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.scriptLabel")}</div>
        <code className="mt-1 block break-all rounded border border-warning-line/50 bg-black/5 px-2 py-1 text-warning">
          {payload.entry}
        </code>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.permsLabel")}</div>
        <ul className="mt-1 list-disc pl-4 text-warning">
          {payload.perms.fs && <li>{t("skillGrant.permFs")}</li>}
        </ul>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("skillGrant.allow")}
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("skillGrant.deny")}
        </button>
      </div>
    </div>
  );
}
