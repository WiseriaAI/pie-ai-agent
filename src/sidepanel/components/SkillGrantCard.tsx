import { useT } from "@/lib/i18n";
import type { SkillGrantRequest } from "@/lib/agent/tools/skill-script";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";

interface Props {
  payload: SkillGrantRequest;
  onDecision: (approved: boolean) => void;
}

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
  </svg>
);

/**
 * skill 信封授权卡（#270 迁 HitlCardShell，warning 档）：展示 daemon 权威的
 * 能力信封原文（脚本 + 域名 + 工作区外写路径），内容不经 LLM 转述。批准后
 * 该 skill 免卡直到信封变化。
 */
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="local"
      icon={<ShieldIcon />}
      capsLabel={t("hitl.caps.skillGrant")}
      title={t("skillGrant.title", { name: payload.displayName ?? payload.skillName })}
      description={payload.description}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("skillGrant.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>
            {t("skillGrant.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("skillGrant.scriptsLabel")}>
          {payload.scripts.map((s) => (
            <span key={s} className="font-mono text-[12px] leading-[18px] text-fg-1">{s}</span>
          ))}
        </HitlDetailGroup>
        <HitlDetailGroup label={t("skillGrant.networkLabel")}>
          {payload.network.length > 0 ? (
            payload.network.map((d) => (
              <span key={d} className="font-mono text-[12px] leading-[18px] text-fg-1">{d}</span>
            ))
          ) : (
            <span className="text-[12px] leading-[18px] text-fg-3">{t("skillGrant.networkNone")}</span>
          )}
        </HitlDetailGroup>
        {payload.write.length > 0 && (
          <HitlDetailGroup label={t("skillGrant.writeLabel")}>
            {payload.write.map((w) => (
              <span key={w} className="font-mono text-[12px] leading-[18px] text-fg-1">{w}</span>
            ))}
          </HitlDetailGroup>
        )}
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-2">{t("skillGrant.disclosure")}</div>
    </HitlCardShell>
  );
}
