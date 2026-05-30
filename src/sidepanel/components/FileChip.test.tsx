import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FileChip } from "./FileChip";
import type { FileAttachment } from "@/lib/files/types";

afterEach(() => cleanup());

const att: FileAttachment = {
  kind: "file", id: "1", name: "report.md", mime: "text/markdown",
  text: "x", truncated: false, totalChars: 1, source: "picker",
};

describe("FileChip", () => {
  it("shows the file name and calls onRemove", () => {
    const onRemove = vi.fn();
    render(<FileChip attachment={att} onRemove={onRemove} />);
    expect(screen.getByText("report.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("1");
  });

  it("shows the file name without a remove button when onRemove is omitted", () => {
    render(<FileChip attachment={att} />);
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});
