/**
 * EngagementReviewPopup — 参考实现（design-to-code，非编译产物）
 *
 * 来源原型：Paper「Pie Frontend」/ artboard「P6 — 评价引导浮窗 · Dark / Light」
 *   https://app.paper.design/file/01KQH5T49RW8RTNMMSTKD1EQEZ
 * 设计 spec：docs/specs/2026-07-01-engagement-review-nudge-design.md
 *
 * 这是纯展示组件。达阈值（activeDays≥2 且 messageCount≥8）+ 本轮回复流式结束后，
 * 由 useEngagementPrompt 决定是否挂载它；状态机（pending/snoozed/done、30d snooze、
 * 累计 2 次转 done）与本地计数逻辑见 spec，本文件只负责“长什么样 + 三个回调”。
 *
 * 配色全部走生产 token（bg-field / text-fg-1 / text-fg-2 / bg-accent-tint / text-accent /
 * bg-fg-1 text-canvas / border-line），浅/深随主题自动切换——无需两套 hex。
 * 注：浅色原型浮窗底色用了纯白以显“抬起”，落地统一用 bg-field（与 CtaCard 一致），靠 shadow 出层次。
 *
 * 放在 docs/ 下不进 tsc/vite 编译；落地时移到 src/sidepanel/components/EngagementReviewPopup.tsx。
 */
import { useI18n } from "@/lib/i18n";

export interface EngagementReviewPopupProps {
  /** 点“在商店评价” → 打开 Chrome 商店评价页，并标记 done */
  onRate: () => void;
  /** 点“Star” → 打开 GitHub 仓库，并标记 done */
  onStar: () => void;
  /** 点右上角 × → snooze（30 天；累计 2 次后转 done） */
  onDismiss: () => void;
}

export default function EngagementReviewPopup({ onRate, onStar, onDismiss }: EngagementReviewPopupProps) {
  const { t } = useI18n();
  return (
    // 底部浮窗：父组件挂在侧栏底部、composer 之上。inset/bottom 按真实 composer 高度微调。
    <div className="absolute inset-x-3 bottom-[84px] z-20">
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-field p-3.5 shadow-lg">
        {/* 头部：星标 + 标题 + 关闭（×= 稍后/snooze） */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-accent-tint text-accent">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2.5l2.9 6.06 6.6.86-4.86 4.55 1.25 6.58L12 18.9l-5.99 3.16 1.25-6.58L2.4 9.42l6.6-.86L12 2.5z" />
            </svg>
          </div>
          <div className="flex-1 text-[14px] font-semibold leading-[18px] text-fg-1">
            {t("engagement.reviewCard.title")}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("engagement.reviewCard.dismiss")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:text-fg-2"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* 正文 */}
        <div className="text-[13px] leading-[18px] text-fg-2">{t("engagement.reviewCard.body")}</div>

        {/* 动作：主“在商店评价” + 次级“Star” */}
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={onRate}
            className="flex h-[38px] flex-[1.5] items-center justify-center rounded-[10px] bg-fg-1 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 active:opacity-80"
          >
            {t("engagement.reviewCard.rate")}
          </button>
          <button
            type="button"
            onClick={onStar}
            className="flex h-[38px] flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-line text-[13px] font-medium text-fg-1 transition-opacity hover:opacity-80"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3.5l2.6 5.35 5.9.78-4.3 4.05 1.1 5.87L12 16.9l-5.3 2.65 1.1-5.87-4.3-4.05 5.9-.78L12 3.5z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            {t("engagement.reviewCard.star")}
          </button>
        </div>
      </div>
    </div>
  );
}
