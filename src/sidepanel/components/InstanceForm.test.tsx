import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
