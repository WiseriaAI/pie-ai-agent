import type { ActionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Scrolls the page up or down by a given amount.
 *
 * @param direction - "up" or "down"
 * @param amount    - Pixels to scroll (default: 80% of viewport height)
 */
export function scroll(
  direction: "up" | "down",
  amount?: number,
): ActionResult {
  const delta = amount ?? window.innerHeight * 0.8;
  const scrollAmount = direction === "down" ? delta : -delta;

  window.scrollBy(0, scrollAmount);

  const scrollY = Math.round(window.scrollY);
  const maxScroll = Math.round(
    document.documentElement.scrollHeight - window.innerHeight,
  );

  return {
    success: true,
    observation: `Scrolled ${direction} by ${Math.round(Math.abs(scrollAmount))}px. Current position: ${scrollY}px / ${maxScroll}px`,
  };
}
