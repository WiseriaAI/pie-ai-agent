import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import NewConfigWizard from "./NewConfigWizard";

// custom-providers reads chrome.storage; stub list to empty for builtin-only tests
vi.mock("@/lib/custom-providers", async (orig) => {
  const actual = await orig<typeof import("@/lib/custom-providers")>();
  return { ...actual, listCustomProviders: vi.fn(async () => []) };
});

afterEach(() => cleanup());

describe("NewConfigWizard (builtin path)", () => {
  it("renders provider dropdown, no step-1 long list", () => {
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    expect(screen.getByRole("button", { name: /select provider/i })).toBeTruthy();
    expect(screen.queryByText(/api key/i)).toBeFalsy();
  });

  it("selecting a builtin provider reveals the instance form", async () => {
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    await waitFor(() => expect(screen.getAllByLabelText(/api key/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/LOCKED/)).toBeFalsy();
  });

  it("creates a builtin instance with payload", async () => {
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find((e) => e.tagName === "INPUT")!;
    fireEvent.change(keyInput, { target: { value: "sk-ant-x" } });
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    fireEvent.click(screen.getAllByText(/claude/i)[0]);
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(onCreate).toHaveBeenCalledWith("anthropic", expect.objectContaining({ apiKey: "sk-ant-x" }));
  });
});
