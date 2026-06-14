import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ScheduleDraftCard } from "./ScheduleDraftCard";
import type { DecryptedInstance } from "@/lib/instances";

afterEach(() => cleanup());

const payload = { title: "Daily digest", prompt: "summarize", specSummary: "every 1440 min" };

const instances: DecryptedInstance[] = [
  { id: "a", provider: "anthropic", nickname: "Anthropic", apiKey: "k", createdAt: 1 },
];

describe("ScheduleDraftCard", () => {
  it("renders task title + specSummary + the card label", () => {
    render(
      <ScheduleDraftCard payload={payload} instances={instances} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Daily digest/)).toBeTruthy();
    expect(screen.getByText(/every 1440 min/)).toBeTruthy();
    // Label rendered via i18n "schedules.draftCardLabel" → "New schedule" in en
    expect(screen.getByText(/new schedule/i)).toBeTruthy();
  });

  it("Create button is disabled until a model selection is made via ModelPicker", () => {
    render(
      <ScheduleDraftCard payload={payload} instances={instances} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const createBtn = screen.getByRole("button", { name: /create schedule/i });
    // Initially disabled — no selection
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);

    // Simulate ModelPicker interaction: open trigger → expand provider → pick model
    const pickerTrigger = screen.getAllByRole("button")[0]!;
    fireEvent.click(pickerTrigger);
    // Provider row
    fireEvent.click(screen.getByText("Anthropic"));
    // Pick a model from the registry
    fireEvent.click(screen.getByText("claude-opus-4-7"));

    // Now Create should be enabled
    const createBtn2 = screen.getByRole("button", { name: /create schedule/i });
    expect((createBtn2 as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking Create transitions to 'created' phase and calls onSubmit after dwell", () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(
      <ScheduleDraftCard payload={payload} instances={instances} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    // Select a model
    const pickerTrigger = screen.getAllByRole("button")[0]!;
    fireEvent.click(pickerTrigger);
    fireEvent.click(screen.getByText("Anthropic"));
    fireEvent.click(screen.getByText("claude-opus-4-7"));

    // Click Create
    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    // Action buttons gone, "created" label visible
    expect(screen.queryByRole("button", { name: /create schedule/i })).toBeNull();
    expect(screen.getByText(/schedule created/i)).toBeTruthy();

    // onSubmit not yet called (dwell)
    expect(onSubmit).not.toHaveBeenCalled();

    // Advance past the 1000ms dwell
    vi.advanceTimersByTime(1000);
    expect(onSubmit).toHaveBeenCalledWith("a", "claude-opus-4-7");

    vi.useRealTimers();
  });

  it("Cancel calls onCancel immediately without phase transition", () => {
    const onCancel = vi.fn();
    render(
      <ScheduleDraftCard payload={payload} instances={instances} onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
