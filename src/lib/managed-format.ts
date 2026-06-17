export type QuotaTier = "neutral" | "caution" | "critical";

/** 周额度告警三档：<80% 中性 / 80–95% 黄铜 / ≥95% 红。见 spec §5.4。 */
export function quotaTier(fraction: number): QuotaTier {
  if (fraction >= 0.95) return "critical";
  if (fraction >= 0.8) return "caution";
  return "neutral";
}

/** 进度条 fill 的 Tailwind 背景类（按档）。 */
export const TIER_FILL_CLASS: Record<QuotaTier, string> = {
  neutral: "bg-fg-1",
  caution: "bg-pending",
  critical: "bg-warning",
};

/** 百分比文字的 Tailwind 文本类（按档）。 */
export const TIER_TEXT_CLASS: Record<QuotaTier, string> = {
  neutral: "text-fg-1",
  caution: "text-pending",
  critical: "text-warning",
};

/** unix 秒 → "Jun 20, 2026"；null/非有限 → null（调用方据此省略整行）。 */
export function formatDate(unixSec: number | null | undefined, locale: string = "en"): string | null {
  if (unixSec == null || !Number.isFinite(unixSec)) return null;
  return new Date(unixSec * 1000).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** unix 秒 → "Mon, Jun 16"；null/非有限 → null。 */
export function formatResetDate(unixSec: number | null | undefined, locale: string = "en"): string | null {
  if (unixSec == null || !Number.isFinite(unixSec)) return null;
  return new Date(unixSec * 1000).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** 相对消耗档 → 3 个点的实心/空布尔数组（实心数 = clamp(level,1,3)）。渲染「消耗 ●●○」。 */
export function consumptionDots(costLevel: number): [boolean, boolean, boolean] {
  const filled = Math.max(1, Math.min(3, Math.round(costLevel)));
  return [filled >= 1, filled >= 2, filled >= 3];
}

/** 最小货币单位金额 → 本地化货币串，显示 ISO 货币码（如 "USD 5.99"）而非裸符号，
 *  避免 "$" 在 USD/CAD/AUD 间歧义。按货币小数位换算（USD=2→/100，JPY=0→/1），不写死 /100。
 *  仅格式化，不做任何定价计算（定价唯一事实源是后端/Stripe）。 */
export function formatMoney(minorAmount: number, currency: string, locale: string = "en"): string {
  const nf = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "code" });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  return nf.format(minorAmount / 10 ** digits);
}
