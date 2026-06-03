// src/sidepanel/components/ProviderDropdown.test.tsx
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ProviderDropdown from "./ProviderDropdown";
import type { ProviderMeta } from "@/lib/model-router/providers/registry";
import type { StoredCustomProvider } from "@/lib/custom-providers";

const BUILTINS = [
  { id: "anthropic", name: "Anthropic", defaultBaseUrl: "https://api.anthropic.com", placeholder: "", models: [] },
  { id: "openai", name: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", placeholder: "", models: [] },
] as unknown as ProviderMeta[];

const CUSTOM: StoredCustomProvider = {
  id: "cp1", name: "My Proxy", baseUrl: "https://proxy.test/v1", models: [], createdAt: 0, updatedAt: 0,
};

function setup(overrides: Partial<React.ComponentProps<typeof ProviderDropdown>> = {}) {
  const props = {
    value: null,
    builtinProviders: BUILTINS,
    customProviders: [CUSTOM],
    onSelect: vi.fn(),
    onCreateCustom: vi.fn(),
    onEditCustom: vi.fn(),
    onDeleteCustom: vi.fn(),
    ...overrides,
  };
  render(<ProviderDropdown {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("ProviderDropdown", () => {
  it("opens popover and lists builtin + custom providers", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("My Proxy")).toBeTruthy();
  });

  it("filters by search query", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "anthro" } });
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.queryByText("OpenAI")).toBeFalsy();
  });

  it("fires onSelect with builtin id", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("OpenAI"));
    expect(p.onSelect).toHaveBeenCalledWith("openai");
  });

  it("fires onSelect with custom: ref when selecting a custom provider", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("My Proxy"));
    expect(p.onSelect).toHaveBeenCalledWith("custom:cp1");
  });

  it("fires onEditCustom / onDeleteCustom from per-item buttons", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByRole("button", { name: /edit provider/i }));
    expect(p.onEditCustom).toHaveBeenCalledWith(CUSTOM);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i })); // reopen
    fireEvent.click(screen.getByRole("button", { name: /delete provider/i }));
    expect(p.onDeleteCustom).toHaveBeenCalledWith(CUSTOM);
  });

  it("fires onCreateCustom from footer", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText(/new custom provider/i));
    expect(p.onCreateCustom).toHaveBeenCalled();
  });

  it("trigger shows selected provider name", () => {
    setup({ value: "anthropic" });
    expect(screen.getByText("Anthropic")).toBeTruthy();
  });
});
