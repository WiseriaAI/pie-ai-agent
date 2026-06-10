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
});
