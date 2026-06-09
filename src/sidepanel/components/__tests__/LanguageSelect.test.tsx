/**
 * LanguageSelect — custom dropdown component test
 *
 * Tests:
 * 1. Collapsed by default (menu options not visible).
 * 2. Clicking the trigger opens the menu.
 * 3. Clicking an option calls setLocale with that option's value.
 *
 * Locale-robustness: "English" is the same string in both dictionaries,
 * so we query options by text "English" to avoid locale flakiness.
 */

import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as i18n from "@/lib/i18n";
import LanguageSelect from "../LanguageSelect";

// Mock getConfig so the useEffect doesn't hit real IndexedDB
vi.mock("@/lib/idb/config-store", () => ({
  getConfig: vi.fn().mockResolvedValue("auto"),
}));

// chrome.i18n.getUILanguage — needed by locale-resolver used internally
(globalThis as unknown as { chrome: { i18n: { getUILanguage: () => string } } }).chrome = {
  ...((globalThis as unknown as { chrome: object }).chrome ?? {}),
  i18n: {
    getUILanguage: () => "en",
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LanguageSelect", () => {
  beforeEach(() => {
    vi.spyOn(i18n, "setLocale").mockResolvedValue(undefined);
  });

  it("is collapsed by default — listbox menu is not visible", () => {
    render(<LanguageSelect />);
    // The listbox (open menu) should NOT be in the document
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking the trigger button opens the menu", async () => {
    render(<LanguageSelect />);

    const trigger = screen.getByRole("button", { name: /auto|english|中文/i });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });
  });

  it("clicking 'English' option calls setLocale('en') and closes the menu", async () => {
    const spy = vi.spyOn(i18n, "setLocale").mockResolvedValue(undefined);

    render(<LanguageSelect />);

    // Open the dropdown
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());

    // Click the "English" option
    const englishOption = screen.getByText("English");
    fireEvent.click(englishOption);

    expect(spy).toHaveBeenCalledWith("en");

    // Menu should close after selection
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});
