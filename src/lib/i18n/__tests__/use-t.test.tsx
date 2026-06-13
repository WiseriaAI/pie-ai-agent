import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import { chromeMock } from "@/test/setup";
import { I18nProvider, useT, useI18n, setLocale, getLocale } from "../use-t";
import { STORAGE_KEY_UI_LOCALE } from "../types";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import { publishChange } from "@/lib/store-bus";
import { _resetForTests } from "@/lib/idb/db";

function Probe({ k, params }: { k: Parameters<ReturnType<typeof useT>>[0]; params?: Record<string, string | number> }) {
  const t = useT();
  return <span data-testid="probe">{t(k as never, params)}</span>;
}

function LocaleProbe() {
  const { locale, t } = useI18n();
  return (
    <span data-testid="locale-probe">
      {locale}:{t("common.cancel")}
    </span>
  );
}

afterEach(() => {
  cleanup();
});

describe("t / useT / I18nProvider", () => {
  beforeEach(async () => {
    await _resetForTests();
    chromeMock.i18n.__uiLanguage = "en";
  });

  it("renders English by default", async () => {
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Cancel"));
  });

  it("renders Chinese when ui_locale=zh-CN in storage", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "zh-CN");
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("取消"));
  });

  it("renders Spanish from the registry dictionary", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "es-419");
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Cancelar"));
  });

  it("renders Japanese from the registry dictionary", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "ja");
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("キャンセル"));
  });

  it("useI18n exposes the effective locale and translator", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "pt-BR");
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("locale-probe").textContent).toBe("pt-BR:Cancelar"),
    );
  });

  it("useI18n falls back to English outside I18nProvider", () => {
    render(<LocaleProbe />);
    expect(screen.getByTestId("locale-probe").textContent).toBe("en:Cancel");
  });

  it("setLocale writes storage and re-renders the tree", async () => {
    render(
      <I18nProvider>
        <Probe k="common.save" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Save"));

    await act(async () => {
      await setLocale("zh-CN");
    });

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("保存"));
    expect(await getConfig<string>(STORAGE_KEY_UI_LOCALE)).toBe("zh-CN");
  });

  it("cross-window sync: store-bus config update flips the tree", async () => {
    render(
      <I18nProvider>
        <Probe k="common.delete" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Delete"));

    // Another window wrote ui_locale to IDB and the store-bus broadcast its
    // change. I18nProvider re-resolves on the config change event.
    await act(async () => {
      await setConfig(STORAGE_KEY_UI_LOCALE, "zh-CN");
      publishChange("config", "put", STORAGE_KEY_UI_LOCALE);
    });

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("删除"));
  });

  it("getLocale exposes the current effective locale", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "zh-CN");
    render(
      <I18nProvider>
        <span />
      </I18nProvider>,
    );
    await waitFor(() => expect(getLocale()).toBe("zh-CN"));
  });
});

describe("t — fallback behavior", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("unknown key returns the key itself and warns", async () => {
    render(
      <I18nProvider>
        <Probe k={"nonexistent.key" as never} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("nonexistent.key"));
    expect(warnSpy).toHaveBeenCalled();
  });

  it("substitutes {name} params", async () => {
    render(
      <I18nProvider>
        <Probe k="common.copy" params={{ name: "X" }} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Copy"));
  });
});
