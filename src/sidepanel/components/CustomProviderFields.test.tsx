// src/sidepanel/components/CustomProviderFields.test.tsx
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import CustomProviderFields from "./CustomProviderFields";
import type { ComponentProps } from "react";

afterEach(() => cleanup());

function setup(overrides: Partial<ComponentProps<typeof CustomProviderFields>> = {}) {
  const props = {
    name: "", baseUrl: "",
    onNameChange: vi.fn(), onBaseUrlChange: vi.fn(), onTest: vi.fn(),
    ...overrides,
  };
  render(<CustomProviderFields {...props} />);
  return props;
}

describe("CustomProviderFields", () => {
  it("renders name + baseUrl inputs and a test button", () => {
    setup();
    expect(screen.getByPlaceholderText(/my custom provider/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/api\.example\.com/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
  });

  it("fires onNameChange / onBaseUrlChange", () => {
    const p = setup();
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy" } });
    expect(p.onNameChange).toHaveBeenCalledWith("Proxy");
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), { target: { value: "https://x/v1" } });
    expect(p.onBaseUrlChange).toHaveBeenCalledWith("https://x/v1");
  });

  it("fires onTest", () => {
    const p = setup({ baseUrl: "https://x/v1" });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(p.onTest).toHaveBeenCalled();
  });

  it("shows test error", () => {
    setup({ testError: "boom" });
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it("shows dependent-count notice and disables delete when in use", () => {
    const p = setup({ dependentCount: 2, onDelete: vi.fn(), deleteDisabled: true });
    expect(screen.getByText(/2/)).toBeTruthy();
    const del = screen.getByRole("button", { name: /delete this provider/i });
    fireEvent.click(del);
    expect(p.onDelete).not.toHaveBeenCalled(); // disabled
  });

  it("fires onDelete when enabled", () => {
    const p = setup({ dependentCount: 0, onDelete: vi.fn(), deleteDisabled: false });
    fireEvent.click(screen.getByRole("button", { name: /delete this provider/i }));
    expect(p.onDelete).toHaveBeenCalled();
  });
});
