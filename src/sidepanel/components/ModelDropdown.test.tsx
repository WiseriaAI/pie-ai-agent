import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ModelDropdown from "./ModelDropdown";
import type { StoredCustomModelMeta } from "@/lib/provider-custom-model-meta";

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

  it("custom model with vision meta shows vision badge, never tools badge", () => {
    const metas: Record<string, StoredCustomModelMeta> = {
      "my-model": { vision: true, maxContextTokens: 256_000 },
    };
    render(
      <ModelDropdown
        provider="minimax"
        value=""
        customModels={["my-model"]}
        customModelMetas={metas}
        onChange={() => {}}
        onAddCustom={() => {}}
        onUpdateCustomMeta={() => {}}
        onRemoveCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    const row = screen.getByRole("button", { name: /my-model/i });
    expect(within(row).getByText(/vision/i)).toBeTruthy();
    expect(within(row).queryByText(/^tools$/i)).toBeNull();
    // sanity: it IS marked custom
    expect(within(row).getByText(/^custom$/)).toBeTruthy();
  });

  it("+add opens ModelMetaEditor modal and save emits (id, meta)", () => {
    const onAddCustom = vi.fn();
    render(
      <ModelDropdown
        provider="minimax"
        value=""
        customModels={[]}
        customModelMetas={{}}
        onChange={() => {}}
        onAddCustom={onAddCustom}
        onUpdateCustomMeta={() => {}}
        onRemoveCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    fireEvent.click(screen.getByText(/add.*custom.*model/i));
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: "m9" } });
    fireEvent.click(screen.getByText(/save/i));
    expect(onAddCustom).toHaveBeenCalledWith(
      "m9",
      expect.objectContaining({ vision: false, maxContextTokens: 256_000 }),
    );
    // modal closes after save
    expect(screen.queryByPlaceholderText(/model id/i)).toBeNull();
  });

  it("custom provider: + add custom model footer shows when onAddCustom provided", () => {
    render(
      <ModelDropdown
        provider="custom:abc"
        value=""
        customModels={[]}
        customModelMetas={{}}
        fetchedModels={[]}
        onChange={() => {}}
        onAddCustom={() => {}}
        onUpdateCustomMeta={() => {}}
        onRemoveCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    expect(screen.getByText(/add.*custom.*model/i)).toBeTruthy();
  });

  it("footer hidden when onAddCustom not provided", () => {
    render(
      <ModelDropdown
        provider="custom:abc"
        value=""
        customModels={[]}
        fetchedModels={[]}
        onChange={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    expect(screen.queryByText(/add.*custom.*model/i)).toBeNull();
  });

  it("pencil edit opens modal with id readonly and save calls onUpdateCustomMeta", () => {
    const onUpdateCustomMeta = vi.fn();
    const metas: Record<string, StoredCustomModelMeta> = {
      "edit-me": { vision: false, maxContextTokens: 128_000 },
    };
    render(
      <ModelDropdown
        provider="minimax"
        value=""
        customModels={["edit-me"]}
        customModelMetas={metas}
        onChange={() => {}}
        onAddCustom={() => {}}
        onUpdateCustomMeta={onUpdateCustomMeta}
        onRemoveCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select/i }));
    const row = screen.getByRole("button", { name: /edit-me/i });
    // vision:false custom model shows no vision badge
    expect(within(row).queryByText(/vision/i)).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /edit/i }));
    // modal should be visible with id field readonly (value "edit-me")
    const idInput = screen.getByDisplayValue("edit-me");
    expect(idInput).toBeTruthy();
    fireEvent.click(screen.getByText(/save/i));
    expect(onUpdateCustomMeta).toHaveBeenCalledWith(
      "edit-me",
      expect.objectContaining({ vision: false, maxContextTokens: 128_000 }),
    );
  });
});
