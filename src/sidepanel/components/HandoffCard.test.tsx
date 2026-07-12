import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HandoffCard } from "./HandoffCard";

afterEach(() => {
  cleanup();
});

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

const PAYLOAD = { context: "REFACTOR THE THING", fileCount: 2, agents: AGENTS };

describe("HandoffCard", () => {
  it("renders context verbatim + agent options, first option preselected", () => {
    render(<HandoffCard payload={PAYLOAD} onDecision={vi.fn()} />);
    expect(screen.getByText("REFACTOR THE THING")).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy(); // 文件数可见
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true); // 预选第一项（候选表顺序 = app 优先）
  });

  it("allow returns the picked agent id", () => {
    const onDecision = vi.fn();
    render(
      <HandoffCard
        payload={{ context: "x", fileCount: 0, agents: AGENTS }}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByText("Codex (Terminal)"));
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith("codex-terminal");
  });

  it("deny returns null", () => {
    const onDecision = vi.fn();
    render(
      <HandoffCard
        payload={{ context: "x", fileCount: 0, agents: AGENTS }}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDecision).toHaveBeenCalledWith(null);
  });

  it("recipient rows carry brand icons keyed by agent id", () => {
    render(<HandoffCard payload={PAYLOAD} onDecision={() => {}} />);
    expect(document.querySelector('svg[data-brand="claude"]')).toBeTruthy();
    expect(document.querySelector('svg[data-brand="codex"]')).toBeTruthy();
  });

  it("warning register: caps label text-warning; no tool name in the card", () => {
    const { container } = render(<HandoffCard payload={PAYLOAD} onDecision={() => {}} />);
    expect(screen.getByText("Hand-off").className).toContain("text-warning");
    expect(container.textContent).not.toContain("handoff_to_agent");
  });
});
