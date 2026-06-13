import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { I18nProvider, STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { setConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import ProviderModelList from "./ProviderModelList";

afterEach(() => cleanup());

beforeEach(async () => {
  await _resetForTests();
});

describe("ProviderModelList", () => {
  it("renders builtin models read-only (no edit/remove buttons)", () => {
    render(<ProviderModelList provider="openai" customModels={[]} />);
    expect(screen.getByText("gpt-4o")).toBeTruthy();
    expect(screen.queryByLabelText("edit")).toBeNull();
    expect(screen.queryByLabelText("remove")).toBeNull();
  });

  it("renders custom models with edit + remove", () => {
    render(
      <ProviderModelList
        provider="openai"
        customModels={["ft-x"]}
        onRemoveCustom={() => {}}
        onUpdateCustomMeta={() => {}}
      />,
    );
    expect(screen.getByText("ft-x")).toBeTruthy();
    expect(screen.getByLabelText("edit")).toBeTruthy();
    expect(screen.getByLabelText("remove")).toBeTruthy();
  });

  it("calls onRemoveCustom when × clicked", () => {
    const onRemove = vi.fn();
    render(<ProviderModelList provider="openai" customModels={["ft-x"]} onRemoveCustom={onRemove} />);
    fireEvent.click(screen.getByLabelText("remove"));
    expect(onRemove).toHaveBeenCalledWith("ft-x");
  });

  it("opens ModelMetaEditor on + add", () => {
    render(<ProviderModelList provider="openai" customModels={[]} onAddCustom={() => {}} />);
    fireEvent.click(screen.getByText(/add custom model/i));
    expect(screen.getByPlaceholderText("model id")).toBeTruthy();
  });

  it("models-override variant (payg) replaces the default list AND skips fetchedModels", () => {
    render(
      <ProviderModelList
        provider="moonshot"
        endpointVariant="payg"
        customModels={[]}
        fetchedModels={[{ id: "should-not-appear", vision: false, tools: true, maxContextTokens: 1000 }]}
      />,
    );
    // payg variant pool = MOONSHOT_MODELS; default (Plan) model is replaced; fetched skipped.
    expect(screen.getByText("kimi-k2.6")).toBeTruthy();
    expect(screen.queryByText("kimi-for-coding")).toBeNull();
    expect(screen.queryByText("should-not-appear")).toBeNull();
  });

  it("formats fetched time with the effective locale", async () => {
    await setConfig(STORAGE_KEY_UI_LOCALE, "pt-BR");
    const fetchedAt = Date.UTC(2026, 5, 12, 9, 30, 0);

    render(
      <I18nProvider>
        <ProviderModelList
          provider="openrouter"
          customModels={[]}
          fetchedAt={fetchedAt}
          onRefresh={() => {}}
        />
      </I18nProvider>,
    );

    expect(await screen.findByText(new Date(fetchedAt).toLocaleString("pt-BR"))).toBeTruthy();
  });
});
