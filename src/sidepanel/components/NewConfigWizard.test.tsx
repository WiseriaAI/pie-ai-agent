import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import NewConfigWizard from "./NewConfigWizard";
import * as cp from "@/lib/custom-providers";

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

describe("NewConfigWizard (custom path)", () => {
  it("new custom: atomic saveCustomProvider then onCreate with custom ref", async () => {
    const saveSpy = vi.spyOn(cp, "saveCustomProvider").mockResolvedValue("newid");
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText(/new custom provider/i));
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy" } });
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), { target: { value: "https://proxy/v1" } });
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    fireEvent.click(screen.getByText(/add custom model/i));
    // The add-model editor modal: locate its MODEL ID input (placeholder is the
    // generic "model id" because ModelDropdown does not forward gpt-4o-mini).
    const idInput = screen.getByPlaceholderText(/^model id$/i);
    fireEvent.change(idInput, { target: { value: "my-model" } });
    // The modal's Save button: select by text+selector because happy-dom's
    // accessible-name computation is unreliable for the dialog's buttons.
    fireEvent.click(screen.getByText("Save", { selector: "button" }));
    // The API-key input: match by exact aria-label, NOT a loose /api key/i text
    // query (the BASE URL field's warning copy contains "API key", so a label
    // text match would grab the wrong input).
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find(
      (e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "api key",
    )!;
    fireEvent.change(keyInput, { target: { value: "sk-x" } });
    fireEvent.click(screen.getByText("Create", { selector: "button" }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "Proxy", baseUrl: "https://proxy/v1" })));
    expect(onCreate).toHaveBeenCalledWith("custom:newid", expect.objectContaining({ apiKey: "sk-x", model: "my-model" }));
  });

  it("delete custom: blocks when instances depend on it", async () => {
    vi.spyOn(cp, "listCustomProviders").mockResolvedValue([
      { id: "cp1", name: "Proxy", baseUrl: "https://p/v1", models: [], createdAt: 0, updatedAt: 0 },
    ]);
    vi.spyOn(cp, "getInstancesUsingCustomProvider").mockResolvedValue([{ id: "i1", nickname: "x", model: "m" }]);
    const delSpy = vi.spyOn(cp, "deleteCustomProvider").mockResolvedValue();
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    await screen.findByRole("button", { name: /select provider/i });
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    await screen.findByText("Proxy");
    fireEvent.click(screen.getByRole("button", { name: /delete provider/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(delSpy).not.toHaveBeenCalled();
  });
});
