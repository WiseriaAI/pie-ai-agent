import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FeedbackSection } from "./Settings";

afterEach(() => cleanup());

const submitFeedback = vi.fn();
vi.mock("../../lib/managed-account", async (orig) => ({
  ...(await orig<typeof import("../../lib/managed-account")>()),
  submitFeedback: (...a: unknown[]) => submitFeedback(...a),
}));
const readRecentLogs = vi.fn();
vi.mock("../../lib/log-buffer", () => ({ readRecentLogs: (...a: unknown[]) => readRecentLogs(...a) }));

beforeEach(() => {
  submitFeedback.mockReset();
  submitFeedback.mockResolvedValue(undefined);
  readRecentLogs.mockReset();
  readRecentLogs.mockResolvedValue("recent-log-blob");
  (globalThis as unknown as { chrome: { runtime: { getManifest: () => { version: string } } } }).chrome.runtime.getManifest = () => ({ version: "9.9.9" });
});

describe("FeedbackSection", () => {
  it("sends trimmed message, no logs when unchecked, with managed apiKey", async () => {
    const managed = { provider: "managed", apiKey: "sk-v" } as never;
    render(<FeedbackSection instances={[managed]} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  hello  " } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    const [input] = submitFeedback.mock.calls[0];
    expect(input).toMatchObject({ message: "hello", apiKey: "sk-v" });
    expect(input.logs).toBeUndefined();
    expect(readRecentLogs).not.toHaveBeenCalled();
    expect(await screen.findByText("Thanks! Feedback sent.")).toBeTruthy();
  });

  it("attaches logs when checkbox ticked; anonymous when no managed instance", async () => {
    render(<FeedbackSection instances={[{ provider: "openai", apiKey: "byok" } as never]} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    const [input] = submitFeedback.mock.calls[0];
    expect(input.logs).toBe("recent-log-blob");
    expect(input.apiKey).toBeUndefined();
  });
});
