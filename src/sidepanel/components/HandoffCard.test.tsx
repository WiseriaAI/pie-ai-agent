import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HandoffCard } from "./HandoffCard";

describe("HandoffCard", () => {
  it("renders context verbatim + file count, wires decisions", () => {
    const onDecision = vi.fn();
    render(
      <HandoffCard
        payload={{ context: "REFACTOR THE THING", target: "claude", fileCount: 2 }}
        onDecision={onDecision}
      />,
    );
    expect(screen.getByText("REFACTOR THE THING")).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy(); // 文件数可见
    fireEvent.click(screen.getByText("Hand off"));
    expect(onDecision).toHaveBeenCalledWith(true);
  });
});
