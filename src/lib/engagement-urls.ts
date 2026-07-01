// Destination URLs for the review/star nudge (issue #244). Kept as plain
// constants so the popup handlers just do chrome.tabs.create({ url }).

/** GitHub repo — the "Star" CTA opens this. */
export const GITHUB_STAR_URL = "https://github.com/WiseriaAI/pie-ai-agent";

/** Chrome Web Store reviews deep-link — the "Leave a review" CTA opens this.
 *  ⚠️ The /detail/<id>/reviews path lands directly on the reviews tab today;
 *  Chrome has changed this format before. If it stops resolving, fall back to
 *  the plain detail page (drop the trailing "/reviews") and let the user scroll. */
export const CHROME_STORE_REVIEW_URL =
  "https://chromewebstore.google.com/detail/gpccjhdgjkmalnepmeclooflliiocfed/reviews";
