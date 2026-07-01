// EngagementReviewPopup — bottom nudge inviting the user to leave a Chrome Web
// Store review or drop a GitHub Star (issue #244). Pure presentational
// component: useEngagementPrompt decides whether to mount it and owns the
// state-machine (pending/snoozed/done, 30d snooze, 2× → done). This file is
// just "what it looks like + three callbacks".
//
// Colors use production tokens (bg-field / text-fg-1 / text-fg-2 / text-fg-3 /
// bg-accent-tint / text-accent / bg-fg-1 text-canvas / border-line) so light /
// dark follow the theme automatically.
//
// Traced from docs/specs/assets/engagement-review-popup.reference.tsx.

import { useT } from "@/lib/i18n";

export interface EngagementReviewPopupProps {
  /** "Leave a review" → open Chrome Web Store reviews + mark done. */
  onRate: () => void;
  /** "Star" → open the GitHub repo + mark done. */
  onStar: () => void;
  /** × ("maybe later") → snooze (30 days; second dismissal → done). */
  onDismiss: () => void;
}

export default function EngagementReviewPopup({
  onRate,
  onStar,
  onDismiss,
}: EngagementReviewPopupProps) {
  const t = useT();
  return (
    // Bottom nudge: mounted inside a position:relative parent, floating just
    // above the composer.
    <div className="absolute inset-x-3 bottom-[84px] z-20">
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-field p-3.5 shadow-lg">
        {/* Header: star + title + close (× = snooze) */}
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

        {/* Body */}
        <div className="text-[13px] leading-[18px] text-fg-2">
          {t("engagement.reviewCard.body")}
        </div>

        {/* Actions: primary "Leave a review" + secondary "Star" */}
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
