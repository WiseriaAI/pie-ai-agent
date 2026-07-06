import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HandoffCard } from "./HandoffCard";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "claude-terminal", label: "Claude Code (Terminal)" },
];

describe("HandoffCard", () => {
  it("renders context verbatim + agent options, first option preselected", () => {
    render(
      <HandoffCard
        payload={{ context: "REFACTOR THE THING", fileCount: 2, agents: AGENTS }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("REFACTOR THE THING")).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy(); // 文件数可见
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true); // 预选第一项（候选表顺序 = app 优先）
  });

  it("allow returns the picked agent id", () => {
    const onDecision = vi.fn();
    const { container } = render(
      <HandoffCard
        payload={{ context: "x", fileCount: 0, agents: AGENTS }}
        onDecision={onDecision}
      />,
    );
    const radioInputs = container.querySelectorAll('input[type="radio"]');
    fireEvent.click(radioInputs[1] as HTMLInputElement); // Click the second radio
    const buttonElems = container.querySelectorAll("button");
    fireEvent.click(buttonElems[0] as HTMLButtonElement); // Click the first button (Hand off)
    expect(onDecision).toHaveBeenCalledWith("claude-terminal");
  });

  it("deny returns null", () => {
    const onDecision = vi.fn();
    const { container } = render(
      <HandoffCard
        payload={{ context: "x", fileCount: 0, agents: AGENTS }}
        onDecision={onDecision}
      />,
    );
    const buttonElems = container.querySelectorAll("button");
    fireEvent.click(buttonElems[1] as HTMLButtonElement); // Click the second button (Cancel)
    expect(onDecision).toHaveBeenCalledWith(null);
  });
});
