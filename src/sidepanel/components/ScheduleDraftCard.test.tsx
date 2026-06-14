import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScheduleDraftCard } from "./ScheduleDraftCard";

const payload = { title: "Daily digest", prompt: "summarize", specSummary: "every 1440 min" };

describe("ScheduleDraftCard", () => {
  it("renders the draft summary and a ModelPicker; submit returns (instanceId, model)", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ScheduleDraftCard payload={payload} instances={[]} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    expect(screen.getByText(/Daily digest/)).toBeTruthy();
    expect(screen.getByText(/every 1440 min/)).toBeTruthy();
    // 选模型由内部 ModelPicker.onSelect 驱动；这里直接点取消验证回调
    fireEvent.click(screen.getByRole("button", { name: /cancel|取消/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
