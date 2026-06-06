import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FileOutputCard } from "./FileOutputCard";

afterEach(() => cleanup());

describe("FileOutputCard", () => {
  it("renders filename + type·size", () => {
    render(<FileOutputCard artifactId="a" filename="pie/report.md" mime="text/markdown" size={12300} onDownload={vi.fn()} />);
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(screen.getByText(/MARKDOWN/)).toBeTruthy();
    expect(screen.getByText(/12\.0 KB/)).toBeTruthy();
  });

  it("calls onDownload with artifactId when clicked", async () => {
    const onDownload = vi.fn().mockResolvedValue({ status: "ok" });
    render(<FileOutputCard artifactId="a7" filename="pie/x.md" mime="text/markdown" size={10} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith("a7"));
  });

  it("switches to expired state when download resolves expired", async () => {
    const onDownload = vi.fn().mockResolvedValue({ status: "expired" });
    render(<FileOutputCard artifactId="a" filename="pie/x.md" mime="text/markdown" size={10} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true));
  });
});
