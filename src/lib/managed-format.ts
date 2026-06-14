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
