import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ProviderModelList from "./ProviderModelList";

afterEach(() => cleanup());

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

  it("models-override variant replaces registry list AND skips fetchedModels", () => {
    render(
      <ProviderModelList
        provider="moonshot"
        endpointVariant="kimi-code"
        customModels={[]}
        fetchedModels={[{ id: "should-not-appear", vision: false, tools: true, maxContextTokens: 1000 }]}
      />,
    );
    expect(screen.getByText("kimi-for-coding")).toBeTruthy();
    expect(screen.queryByText("kimi-k2.6")).toBeNull();
    expect(screen.queryByText("should-not-appear")).toBeNull();
  });
});
