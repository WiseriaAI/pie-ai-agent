import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MotionProvider } from "./ui/motion";
import { RunLocalAgentCard } from "./RunLocalAgentCard";

function renderCard(props: ComponentProps<typeof RunLocalAgentCard>) {
  return render(
    <MotionProvider>
      <RunLocalAgentCard {...props} />
    </MotionProvider>,
  );
}

afterEach(() => {
  cleanup();
});

const TWO = [
  { id: "claude-terminal", label: "Claude Code (Terminal)" },
  { id: "codex-terminal", label: "Codex (Terminal)" },
];

describe("RunLocalAgentCard", () => {
  it("展示 prompt 与 cwd 原文", () => {
    renderCard({
      payload: { prompt: "rm -rf /tmp/x", cwd: "/Users/me/proj", agents: TWO },
      onDecision: vi.fn(),
    });
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeTruthy();
    expect(screen.getByText(/\/Users\/me\/proj/)).toBeTruthy();
  });

  it("点允许回传默认选中的后端 id（表顺序第一），点拒绝回传 null", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { prompt: "x", cwd: "y", agents: TWO }, onDecision });
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith("claude-terminal");
    fireEvent.click(screen.getByRole("button", { name: /deny|拒绝/i }));
    expect(onDecision).toHaveBeenCalledWith(null);
  });

  it("多后端：下拉选非默认后端 → 允许回传所选 id", () => {
    const onDecision = vi.fn();
    renderCard({ payload: { prompt: "x", cwd: "y", agents: TWO }, onDecision });
    // 触发器显示默认选中（表顺序第一）；选项列表未展开
    expect(screen.getByText("Claude Code (Terminal)")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    // 展开下拉 → 两条后端都在
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(screen.getAllByRole("option").length).toBe(2);
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith("codex-terminal");
  });

  it("单后端：不显示下拉选择器，允许回传唯一后端 id", () => {
    const onDecision = vi.fn();
    const one = [{ id: "opencode-terminal", label: "OpenCode (Terminal)" }];
    renderCard({ payload: { prompt: "x", cwd: "y", agents: one }, onDecision });
    // 后端名仍展示（用户看得到跑在哪），但没有下拉触发器
    expect(screen.getByText("OpenCode (Terminal)")).toBeTruthy();
    expect(document.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith("opencode-terminal");
  });

  it("warning register: caps label styled text-warning; no tool name in the card", () => {
    const { container } = renderCard({
      payload: { prompt: "do x", cwd: "/tmp/w", agents: TWO },
      onDecision: () => {},
    });
    expect(screen.getByText("Local agent").className).toContain("text-warning");
    expect(container.textContent).not.toContain("run_local_agent");
  });
});
