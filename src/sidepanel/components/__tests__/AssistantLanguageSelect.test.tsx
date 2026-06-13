import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, STORAGE_KEY_ASSISTANT_LANGUAGE } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import AssistantLanguageSelect from "../AssistantLanguageSelect";

afterEach(cleanup);

describe("AssistantLanguageSelect", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("renders assistant language modes and explicit launch locales", async () => {
    render(
      <I18nProvider>
        <AssistantLanguageSelect />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("Follow UI language")).toBeTruthy();
    expect(screen.getByText("Detect from user message")).toBeTruthy();
    expect(screen.getByText("Español (Latinoamérica)")).toBeTruthy();
    expect(screen.getByText("日本語")).toBeTruthy();
    expect(screen.getByText("Português (Brasil)")).toBeTruthy();
  });

  it("stores explicit assistant language selection", async () => {
    render(
      <I18nProvider>
        <AssistantLanguageSelect />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("Português (Brasil)"));

    await waitFor(async () => {
      expect(await getConfig<string>(STORAGE_KEY_ASSISTANT_LANGUAGE)).toBe("pt-BR");
    });
  });

  it("stores auto-detect assistant language mode", async () => {
    render(
      <I18nProvider>
        <AssistantLanguageSelect />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("Detect from user message"));

    await waitFor(async () => {
      expect(await getConfig<string>(STORAGE_KEY_ASSISTANT_LANGUAGE)).toBe("auto-detect-user-message");
    });
  });
});
