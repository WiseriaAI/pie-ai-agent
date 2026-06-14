import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import LanguageSelect from "../LanguageSelect";

// chrome.i18n.getUILanguage — needed by locale-resolver used internally
(globalThis as unknown as { chrome: { i18n: { getUILanguage: () => string } } }).chrome = {
  ...((globalThis as unknown as { chrome: object }).chrome ?? {}),
  i18n: {
    getUILanguage: () => "en",
  },
};

afterEach(cleanup);

function renderLanguageSelect() {
  return render(
    <I18nProvider>
      <LanguageSelect />
    </I18nProvider>,
  );
}

describe("LanguageSelect", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("is collapsed by default — listbox menu is not visible", () => {
    renderLanguageSelect();

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking the trigger button opens the menu", async () => {
    renderLanguageSelect();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });
  });

  it("renders every registered launch locale", async () => {
    renderLanguageSelect();

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("English")).toBeTruthy();
    expect(screen.getByText("中文（简体）")).toBeTruthy();
    expect(screen.getByText("中文（繁體）")).toBeTruthy();
    expect(screen.getByText("Español (Latinoamérica)")).toBeTruthy();
    expect(screen.getByText("日本語")).toBeTruthy();
    expect(screen.getByText("Português (Brasil)")).toBeTruthy();
  });

  it("writes a selected locale to config and closes the menu", async () => {
    renderLanguageSelect();

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("日本語"));

    await waitFor(async () => {
      expect(await getConfig<string>(STORAGE_KEY_UI_LOCALE)).toBe("ja");
    });

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});
