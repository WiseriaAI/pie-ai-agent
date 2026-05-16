import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ModelDropdown from "./ModelDropdown";

afterEach(() => {
  cleanup();
});

describe("ModelDropdown", () => {
  it("registry-listed provider: shows hardcoded models with capability tags", () => {
    render(
      <ModelDropdown
        provider="anthropic"
        value="claude-opus-4-7"
        customModels={[]}
        onChange={() => {}}
        onAddCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /claude-opus-4-7/i }));
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeTruthy();
  });

  it("custom models render with [custom] tag and × delete button", () => {
    const onChange = vi.fn();
    render(
      <ModelDropdown
        provider="anthropic"
        value="my-finetune"
        customModels={["my-finetune"]}
        onChange={onChange}
        onAddCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /my-finetune/i }));
    expect(screen.getAllByText(/my-finetune/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/^custom$/)).toBeTruthy();
  });

  it("OpenRouter: empty registry triggers onRefresh on first open if no fetchedModels", () => {
    const onRefresh = vi.fn();
    render(
      <ModelDropdown
        provider="openrouter"
        value=""
        customModels={[]}
        fetchedModels={undefined}
        onChange={() => {}}
        onAddCustom={() => {}}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
