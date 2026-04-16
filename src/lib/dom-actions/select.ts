import type { ActionResult } from "./types";

/**
 * Self-contained function injected via chrome.scripting.executeScript.
 * Selects an option in a <select> element by value.
 *
 * @param index - The index assigned by snapshotInteractiveElements
 * @param value - The option value to select
 */
export function selectByIndex(index: number, value: string): ActionResult {
  const el = document.querySelector(`[data-ai-agent-idx="${index}"]`);

  if (!el) {
    return {
      success: false,
      error: `Element not found at index ${index}. The page may have changed; try snapshotting again.`,
    };
  }

  if (el.tagName.toLowerCase() !== "select") {
    return {
      success: false,
      error: `Element [${index}] is a <${el.tagName.toLowerCase()}>, not a <select>.`,
    };
  }

  const selectEl = el as HTMLSelectElement;

  // Validate the option exists
  const optionExists = Array.from(selectEl.options).some(
    (opt) => opt.value === value,
  );

  if (!optionExists) {
    const availableValues = Array.from(selectEl.options)
      .map((o) => `"${o.value}"`)
      .join(", ");
    return {
      success: false,
      error: `Option value "${value}" not found in select [${index}]. Available values: ${availableValues}`,
    };
  }

  selectEl.value = value;
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));

  // Find the selected option label for the observation
  const selectedOption = Array.from(selectEl.options).find(
    (opt) => opt.value === value,
  );
  const label = selectedOption?.text?.trim() || value;

  return {
    success: true,
    observation: `Selected option "${label}" (value="${value}") in element [${index}]`,
  };
}
