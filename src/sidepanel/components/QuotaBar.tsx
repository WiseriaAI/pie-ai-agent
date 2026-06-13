import { quotaTier, TIER_FILL_CLASS, TIER_TEXT_CLASS, formatResetDate } from "@/lib/managed-format";
import { useI18n } from "@/lib/i18n";

export default function QuotaBar({ usedFraction, resetAt }: { usedFraction: number; resetAt: number }) {
  const { t, locale } = useI18n();
  const f = Math.max(0, Math.min(1, usedFraction));
  const pct = Math.round(f * 100);
  const tier = quotaTier(f);
  const reset = formatResetDate(resetAt, locale);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <div className="caps text-fg-3">{t("managed.quota.thisWeek")}</div>
        <div className="flex items-baseline gap-1">
          <span className={`text-[14px] font-semibold tabular ${TIER_TEXT_CLASS[tier]}`}>{pct}%</span>
          <span className="text-[11px] text-fg-3">{t("managed.quota.used")}</span>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-field">
        <div className={`h-2 rounded-full ${TIER_FILL_CLASS[tier]}`} style={{ width: `${pct}%` }} />
      </div>
      {reset && <div className="text-[11px] text-fg-3">{t("managed.quota.resets", { date: reset })}</div>}
    </div>
  );
}
