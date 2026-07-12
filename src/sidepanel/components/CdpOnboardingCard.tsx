import { useT } from "@/lib/i18n/use-t";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./hitl/HitlCardShell";

interface Props {
  onAnswer: (enabled: boolean) => void;
}

const CursorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 4l7 17 2.5-7L21 11 4 4z" />
  </svg>
);

/** CDP 输入模拟授权卡（#270 迁 HitlCardShell，browser/accent 档）。 */
export function CdpOnboardingCard({ onAnswer }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="browser"
      icon={<CursorIcon />}
      capsLabel={t("hitl.caps.cdp")}
      title={t("cdpOnboarding.title")}
      description={t("cdpOnboarding.body1")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onAnswer(false)}>
            {t("cdpOnboarding.decline")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="browser" onClick={() => onAnswer(true)}>
            {t("cdpOnboarding.enable")}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="text-[11px] leading-[17px] text-fg-2">{t("cdpOnboarding.body2")}</div>
    </HitlCardShell>
  );
}
