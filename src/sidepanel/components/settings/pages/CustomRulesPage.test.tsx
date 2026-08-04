import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const getCustomRules = vi.fn();
const setCustomRules = vi.fn();

vi.mock("@/lib/custom-rules", () => ({
  getCustomRules: (...a: unknown[]) => getCustomRules(...a),
  setCustomRules: (...a: unknown[]) => setCustomRules(...a),
  CUSTOM_RULES_MAX_LENGTH: 4000,
}));

import CustomRulesPage from "./CustomRulesPage";

afterEach(cleanup);
beforeEach(() => {
  getCustomRules.mockReset().mockResolvedValue("");
  setCustomRules.mockReset().mockResolvedValue(undefined);
});

describe("CustomRulesPage (#344)", () => {
  it("loads the persisted rules into the textarea", async () => {
    getCustomRules.mockResolvedValue("Always be concise.");
    render(<CustomRulesPage />);
    await waitFor(() =>
      expect((screen.getByTestId("custom-rules-textarea") as HTMLTextAreaElement).value).toBe(
        "Always be concise.",
      ),
    );
  });

  it("enforces the 4000-char maxLength on the textarea", async () => {
    render(<CustomRulesPage />);
    const ta = await screen.findByTestId("custom-rules-textarea");
    expect((ta as HTMLTextAreaElement).maxLength).toBe(4000);
  });

  it("updates the character counter as the user types", async () => {
    render(<CustomRulesPage />);
    const ta = await screen.findByTestId("custom-rules-textarea");
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(screen.getByTestId("custom-rules-count").textContent).toContain("5");
  });

  it("persists the value via setCustomRules on save", async () => {
    render(<CustomRulesPage />);
    const ta = await screen.findByTestId("custom-rules-textarea");
    fireEvent.change(ta, { target: { value: "Reply in bullets." } });
    fireEvent.click(screen.getByTestId("custom-rules-save"));
    await waitFor(() => expect(setCustomRules).toHaveBeenCalledWith("Reply in bullets."));
  });

  it("can clear the rules (saving an empty string turns the feature off)", async () => {
    getCustomRules.mockResolvedValue("some rule");
    render(<CustomRulesPage />);
    const ta = await screen.findByTestId("custom-rules-textarea");
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toBe("some rule"));
    fireEvent.change(ta, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("custom-rules-save"));
    await waitFor(() => expect(setCustomRules).toHaveBeenCalledWith(""));
  });
});
