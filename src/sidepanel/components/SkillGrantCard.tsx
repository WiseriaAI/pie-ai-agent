import { useT } from "@/lib/i18n";
import type { SkillGrantRequest } from "@/lib/agent/tools/skill-script";

interface Props {
  payload: SkillGrantRequest;
  onDecision: (approved: boolean) => void;
}

/**
 * skill 信封授权卡：首跑 ungranted 磁盘 skill 时展示 daemon 权威给出的能力信封
 * （可执行脚本 + 联网域名 + 工作区外写路径）原文，用户批准后该 skill 免卡直到
 * 信封变化。内容不经 LLM 转述。
 */
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("skillGrant.title")}</div>
      <div>
        <div className="font-medium text-warning">{payload.displayName ?? payload.skillName}</div>
        <div className="mt-0.5 text-warning/70">{payload.description}</div>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.scriptsLabel")}</div>
        <ul className="mt-1 flex flex-col gap-0.5">
          {payload.scripts.map((s) => (
            <li key={s} className="rounded border border-warning-line/50 bg-black/5 px-2 py-0.5 font-mono">
              {s}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-warning/70">{t("skillGrant.networkLabel")}</div>
        {payload.network.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {payload.network.map((d) => (
              <li key={d} className="rounded border border-warning-line/50 bg-black/5 px-2 py-0.5 font-mono">
                {d}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-1 text-warning/70">{t("skillGrant.networkNone")}</div>
        )}
      </div>
      {payload.write.length > 0 && (
        <div>
          <div className="text-warning/70">{t("skillGrant.writeLabel")}</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {payload.write.map((w) => (
              <li key={w} className="rounded border border-warning-line/50 bg-black/5 px-2 py-0.5 font-mono">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-[12px] leading-relaxed text-warning/70">{t("skillGrant.disclosure")}</div>
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
