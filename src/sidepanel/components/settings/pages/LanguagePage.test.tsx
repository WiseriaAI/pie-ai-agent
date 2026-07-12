/**
 * LanguagePage — settings sub-pages replacing the old LanguageSelect /
 * AssistantLanguageSelect dropdowns: grouped radio lists, select persists.
 */
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE, getAssistantLanguageSetting } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import { UiLanguagePage, AssistantLanguagePage } from "./LanguagePage";

// chrome.i18n.getUILanguage — needed by locale-resolver used internally
(globalThis as unknown as { chrome: { i18n: { getUILanguage: () => string } } }).chrome = {
  ...((globalThis as unknown as { chrome: object }).chrome ?? {}),
  i18n: {
    getUILanguage: () => "en",
  },
};

afterEach(cleanup);

describe("UiLanguagePage", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("renders every registered launch locale as a radio option", () => {
    render(
      <I18nProvider>
        <UiLanguagePage />
      </I18nProvider>,
    );
    for (const label of [
      "English",
      "中文（简体）",
      "中文（繁體）",
      "Español (Latinoamérica)",
      "日本語",
      "Português (Brasil)",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByRole("radio").length).toBeGreaterThanOrEqual(7); // auto + locales
  });

  it("selecting a locale persists it and checks the row", async () => {
    render(
      <I18nProvider>
        <UiLanguagePage />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText("日本語"));
    await waitFor(async () => {
      expect(await getConfig<string>(STORAGE_KEY_UI_LOCALE)).toBe("ja");
    });
    expect(screen.getByText("日本語").closest("button")?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("AssistantLanguagePage", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("renders the two auto modes plus locales; selecting persists", async () => {
    render(
      <I18nProvider>
        <AssistantLanguagePage />
      </I18nProvider>,
    );
    expect(screen.getAllByRole("radio").length).toBeGreaterThanOrEqual(8); // 2 auto modes + locales
    fireEvent.click(screen.getByText("中文（简体）"));
    await waitFor(async () => {
      expect(await getAssistantLanguageSetting()).toBe("zh-CN");
    });
  });
});
