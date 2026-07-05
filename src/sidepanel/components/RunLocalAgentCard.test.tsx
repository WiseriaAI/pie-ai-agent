import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RunLocalAgentCard } from "./RunLocalAgentCard";

afterEach(() => {
  cleanup();
});

describe("RunLocalAgentCard", () => {
  it("展示 prompt 与 cwd 原文", () => {
    render(
      <RunLocalAgentCard
        payload={{ prompt: "rm -rf /tmp/x", cwd: "/Users/me/proj" }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeTruthy();
    expect(screen.getByText(/\/Users\/me\/proj/)).toBeTruthy();
  });

  it("点允许/拒绝回传布尔", () => {
    const onDecision = vi.fn();
    render(<RunLocalAgentCard payload={{ prompt: "x", cwd: "y" }} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: /allow|允许/i }));
    expect(onDecision).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /deny|拒绝/i }));
    expect(onDecision).toHaveBeenCalledWith(false);
  });
});
