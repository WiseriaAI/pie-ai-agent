import { useT } from "@/lib/i18n/use-t";

interface Props {
  onAnswer: (enabled: boolean) => void;
}

export function CdpOnboardingCard({ onAnswer }: Props) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">{t("cdpOnboarding.title")}</div>
      <p className="text-warning/90">{t("cdpOnboarding.body1")}</p>
      <p className="text-warning/90">{t("cdpOnboarding.body2")}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onAnswer(true)}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("cdpOnboarding.enable")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(false)}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {t("cdpOnboarding.decline")}
        </button>
      </div>
    </div>
  );
}
