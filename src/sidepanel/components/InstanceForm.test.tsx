import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import InstanceForm from "./InstanceForm";

afterEach(() => {
  cleanup();
});

describe("InstanceForm", () => {
  it("does NOT render a BaseURL field", () => {
    render(
      <InstanceForm
        mode="create"
        provider="anthropic"
        initialNickname="Anthropic"
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    expect(screen.queryByText(/base url/i)).toBeFalsy();
  });

  it("provider field is read-only in edit mode", () => {
    render(
      <InstanceForm
        mode="edit"
        provider="openai"
        initialNickname="Work"
        onSave={() => {}}
        onTest={() => {}}
        onDelete={() => {}}
      />,
    );
    const providers = screen.getAllByText(/openai/i);
    expect(providers.length).toBeGreaterThan(0);
    // No combobox / button for provider
    expect(screen.queryByRole("combobox", { name: /provider/i })).toBeFalsy();
  });

  it("fires onSave with form payload", () => {
    const onSave = vi.fn();
    render(
      <InstanceForm
        mode="create"
        provider="anthropic"
        initialNickname="Anthropic"
        onSave={onSave}
        onTest={() => {}}
      />,
    );
    // getByLabelText finds multiple because Field uses <label> wrapping; grab the input explicitly
    const apiKeyInput = screen.getAllByLabelText(/api key/i).find(
      (el) => el.tagName === "INPUT",
    )!;
    fireEvent.change(apiKeyInput, { target: { value: "sk-ant-test" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-ant-test" }));
  });

  it("edit mode pre-populates partial-reveal of existing apiKey + saves without retyping", () => {
    const onSave = vi.fn();
    render(
      <InstanceForm
        mode="edit"
        provider="anthropic"
        initialNickname="Anthropic"
        existingApiKey="sk-ant-1234567890abcdefXYZ"
        onSave={onSave}
        onTest={() => {}}
        onDelete={() => {}}
      />,
    );
    // partial reveal visible — starts with "sk-ant-"
    expect(screen.getByText(/sk-ant-/i)).toBeTruthy();
    // Save with no retype
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    // payload.apiKey should be empty (signals "keep existing")
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "" }));
  });

  it("edit mode Replace key reveals input", () => {
    render(
      <InstanceForm
        mode="edit"
        provider="anthropic"
        initialNickname="Anthropic"
        existingApiKey="sk-ant-1234567890abcdefXYZ"
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    // The button is inside a <label> so use getByText to locate it
    fireEvent.click(screen.getByText("Replace key"));
    // Now an input should appear with aria-label="api key"
    const input = screen.getAllByLabelText(/api key/i).find(
      (el) => el.tagName === "INPUT",
    );
    expect(input).toBeTruthy();
  });

  it("hides provider field when hideProviderField is set", () => {
    render(
      <InstanceForm
        mode="create"
        provider="anthropic"
        initialNickname="Anthropic"
        hideProviderField
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    // The PROVIDER field label must be gone
    expect(screen.queryByText(/^PROVIDER$/)).toBeFalsy();
    expect(screen.queryByText(/LOCKED/)).toBeFalsy();
  });

  it("still renders provider field by default (edit-instance unchanged)", () => {
    render(
      <InstanceForm
        mode="create"
        provider="anthropic"
        initialNickname="Anthropic"
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    expect(screen.getByText(/LOCKED/)).toBeTruthy();
  });
});

describe("endpoint variant switch", () => {
  const noop = () => {};
  const base = {
    mode: "create" as const,
    initialNickname: "n",
    onTest: noop,
  };

  it("renders the segmented switch only for providers with variants", () => {
    const { rerender } = render(<InstanceForm {...base} provider="zhipu" onSave={noop} />);
    expect(screen.getByRole("button", { name: "Pay-as-you-go" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Coding Plan" })).toBeTruthy();
    rerender(<InstanceForm {...base} provider="anthropic" onSave={noop} />);
    expect(screen.queryByRole("button", { name: "Pay-as-you-go" })).toBeNull();
  });

  it("renders [Plan, Pay-as-you-go] with Pay-as-you-go rightmost across providers", () => {
    // Default endpoint (Plan) is left, payg variant is right — uniform alignment.
    const { rerender } = render(<InstanceForm {...base} provider="zhipu" onSave={noop} />);
    let labels = within(screen.getByRole("group", { name: "ENDPOINT" }))
      .getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Coding Plan", "Pay-as-you-go"]);
    rerender(<InstanceForm {...base} provider="mimo" onSave={noop} />);
    labels = within(screen.getByRole("group", { name: "ENDPOINT" }))
      .getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Token Plan", "Pay-as-you-go"]);
  });

  it("selecting the payg variant flows into the onSave payload; default (Plan) = undefined", () => {
    const onSave = vi.fn();
    render(<InstanceForm {...base} provider="zhipu" onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("api key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay-as-you-go" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0].endpointVariant).toBe("payg");
    // 切回默认（Coding Plan）→ undefined
    fireEvent.click(screen.getByRole("button", { name: "Coding Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[1]![0].endpointVariant).toBeUndefined();
  });

  it("edit mode pre-selects initialEndpointVariant", () => {
    const onSave = vi.fn();
    render(
      <InstanceForm {...base} mode="edit" provider="zhipu" existingApiKey="sk-x"
        initialEndpointVariant="payg" onSave={onSave} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0].endpointVariant).toBe("payg");
  });

  it("variant placeholder overrides the provider placeholder (mimo payg)", () => {
    render(<InstanceForm {...base} provider="mimo" onSave={noop} />);
    expect(screen.getByLabelText("api key").getAttribute("placeholder")).toBe("tp-...");
    fireEvent.click(screen.getByRole("button", { name: "Pay-as-you-go" }));
    expect(screen.getByLabelText("api key").getAttribute("placeholder")).toBe("sk-...");
  });

  it("model list follows the endpoint: default Kimi Code → payg swaps to Moonshot models", () => {
    render(<InstanceForm {...base} provider="moonshot" onSave={noop} />);
    // Default = Kimi Code Plan → pinned single model.
    expect(screen.getByText("kimi-for-coding")).toBeTruthy();
    expect(screen.queryByText("kimi-k2.6")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pay-as-you-go" }));
    expect(screen.queryByText("kimi-for-coding")).toBeNull();
    expect(screen.getByText("kimi-k2.6")).toBeTruthy();
  });

  it("stale initialEndpointVariant (removed from registry) normalizes to undefined", () => {
    const onSave = vi.fn();
    render(
      <InstanceForm {...base} mode="edit" provider="zhipu" existingApiKey="sk-x"
        initialEndpointVariant="gone" onSave={onSave} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0].endpointVariant).toBeUndefined();
  });
});
