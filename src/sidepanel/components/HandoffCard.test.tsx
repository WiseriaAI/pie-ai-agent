import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MotionProvider } from "./ui/motion";
import { HandoffCard } from "./HandoffCard";

afterEach(() => {
  cleanup();
});

function renderCard(props: ComponentProps<typeof HandoffCard>) {
  return render(
    <MotionProvider>
      <HandoffCard {...props} />
    </MotionProvider>,
  );
}

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

const PAYLOAD = { context: "REFACTOR THE THING", fileCount: 2, agents: AGENTS };

describe("HandoffCard", () => {
  it("renders context verbatim + agent dropdown, first option preselected", () => {
    renderCard({ payload: PAYLOAD, onDecision: vi.fn() });
    expect(screen.getByText("REFACTOR THE THING")).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy(); // 文件数可见
    // 触发器显示预选第一项（候选表顺序 = app 优先）；展开后两条都在
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("allow returns the picked agent id", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { context: "x", fileCount: 0, agents: AGENTS }, onDecision });
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith("codex-terminal");
  });

  it("deny returns null", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { context: "x", fileCount: 0, agents: AGENTS }, onDecision });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDecision).toHaveBeenCalledWith(null);
  });

  it("dropdown options carry brand icons keyed by agent id", () => {
    renderCard({ payload: PAYLOAD, onDecision: () => {} });
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(document.querySelector('svg[data-brand="claude"]')).toBeTruthy();
    expect(document.querySelector('svg[data-brand="codex"]')).toBeTruthy();
  });

  it("warning register: caps label text-warning; no tool name in the card", () => {
    const { container } = renderCard({ payload: PAYLOAD, onDecision: () => {} });
    expect(screen.getByText("Hand-off").className).toContain("text-warning");
    expect(container.textContent).not.toContain("handoff_to_agent");
  });
});
