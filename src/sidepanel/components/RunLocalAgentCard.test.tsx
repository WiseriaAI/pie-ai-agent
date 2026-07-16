import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RunLocalAgentCard } from "./RunLocalAgentCard";

afterEach(() => {
  cleanup();
});

const TWO = [
  { id: "claude-terminal", label: "Claude Code (Terminal)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

describe("RunLocalAgentCard", () => {
  it("展示 prompt 与 cwd 原文", () => {
    render(
      <RunLocalAgentCard
        payload={{ prompt: "rm -rf /tmp/x", cwd: "/Users/me/proj", agents: TWO }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeTruthy();
    expect(screen.getByText(/\/Users\/me\/proj/)).toBeTruthy();
  });

  it("点允许回传默认选中的后端 id（表顺序第一），点拒绝回传 null", () => {
    const onDecision = vi.fn();
    render(<RunLocalAgentCard payload={{ prompt: "x", cwd: "y", agents: TWO }} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith("claude-terminal");
    fireEvent.click(screen.getByRole("button", { name: /deny|拒绝/i }));
    expect(onDecision).toHaveBeenCalledWith(null);
  });

  it("多后端：选非默认后端 → 允许回传所选 id", () => {
    const onDecision = vi.fn();
    render(<RunLocalAgentCard payload={{ prompt: "x", cwd: "y", agents: TWO }} onDecision={onDecision} />);
    // 两条后端都渲染
    expect(screen.getByText("Claude Code (Terminal)")).toBeTruthy();
    expect(screen.getByText("Codex (Terminal)")).toBeTruthy();
    fireEvent.click(screen.getByText("Codex (Terminal)"));
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith("codex-terminal");
  });

  it("单后端：不显示单选器，允许回传唯一后端 id", () => {
    const onDecision = vi.fn();
    const one = [{ id: "opencode-terminal", label: "OpenCode (Terminal)" }];
    render(<RunLocalAgentCard payload={{ prompt: "x", cwd: "y", agents: one }} onDecision={onDecision} />);
    // 后端名仍展示（用户看得到跑在哪），但没有 radio 输入
    expect(screen.getByText("OpenCode (Terminal)")).toBeTruthy();
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith("opencode-terminal");
  });

  it("warning register: caps label styled text-warning; no tool name in the card", () => {
    const { container } = render(
      <RunLocalAgentCard payload={{ prompt: "do x", cwd: "/tmp/w", agents: TWO }} onDecision={() => {}} />,
    );
    expect(screen.getByText("Local agent").className).toContain("text-warning");
    expect(container.textContent).not.toContain("run_local_agent");
  });
});
