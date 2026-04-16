import type { ActionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Locates an element by its data-ai-agent-idx attribute and clicks it.
 *
 * @param index - The index assigned by snapshotInteractiveElements
 */
export function clickByIndex(index: number): ActionResult {
  const el = document.querySelector(`[data-ai-agent-idx="${index}"]`);

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
