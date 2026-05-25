import type { ActionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Locates an element by its data-pie-idx attribute and clicks it.
 *
 * @param index - The index stamped by read_page (pageSnapshotInjected)
 */
export function clickByIndex(index: number): ActionResult {
  const el = document.querySelector(`[data-pie-idx="${index}"]`);

  if (!el) {
    return {
      success: false,
      error: `Element not found at index ${index}. The page may have changed; try snapshotting again.`,
    };
  }

  (el as HTMLElement).click();

  return {
    success: true,
    observation: `Clicked element [${index}]: <${el.tagName.toLowerCase()}> "${(el as HTMLElement).innerText?.trim().slice(0, 80) || el.getAttribute("aria-label") || ""}"`,
  };
}
