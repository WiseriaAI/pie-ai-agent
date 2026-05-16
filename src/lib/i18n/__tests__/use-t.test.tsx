import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import { chromeMock } from "@/test/setup";
import { I18nProvider, useT, setLocale, getLocale } from "../use-t";

function Probe({ k, params }: { k: Parameters<ReturnType<typeof useT>>[0]; params?: Record<string, string | number> }) {
  const t = useT();
  return <span data-testid="probe">{t(k as never, params)}</span>;
}

afterEach(() => {
  cleanup();
});

describe("t / useT / I18nProvider", () => {
  beforeEach(() => {
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
    await chromeMock.storage.local.set({ ui_locale: "zh-CN" });
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("取消"));
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
    const stored = await chromeMock.storage.local.get("ui_locale");
    expect(stored.ui_locale).toBe("zh-CN");
  });

  it("cross-window sync: storage.onChanged update flips the tree", async () => {
    render(
      <I18nProvider>
        <Probe k="common.delete" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Delete"));

    await act(async () => {
      chromeMock.storage.local.__store["ui_locale"] = "zh-CN";
      chromeMock.storage.local.__emitChange({
        ui_locale: { oldValue: undefined, newValue: "zh-CN" },
      });
    });

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("删除"));
  });

  it("getLocale exposes the current effective locale", async () => {
    await chromeMock.storage.local.set({ ui_locale: "zh-CN" });
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
