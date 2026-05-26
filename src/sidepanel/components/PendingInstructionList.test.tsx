import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PendingInstructionList } from "./PendingInstructionList";

afterEach(() => {
  cleanup();
});

describe("PendingInstructionList", () => {
  it("renders nothing when items empty", () => {
    const { container } = render(
      <PendingInstructionList items={[]} onCancel={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders caption with count and each item text", () => {
    render(
      <PendingInstructionList
        items={[
          { chatMessageId: "m1", content: "first" },
          { chatMessageId: "m2", content: "second" },
        ]}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/2 IN QUEUE/i)).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("calls onCancel with chatMessageId when × clicked", () => {
    const onCancel = vi.fn();
    render(
      <PendingInstructionList
        items={[{ chatMessageId: "m1", content: "first" }]}
        onCancel={onCancel}
      />,
    );
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledWith("m1");
  });
});
