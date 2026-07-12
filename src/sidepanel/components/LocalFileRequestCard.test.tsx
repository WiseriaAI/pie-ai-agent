import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocalFileRequestCard } from "./LocalFileRequestCard";

afterEach(() => cleanup());

describe("LocalFileRequestCard", () => {
  it("renders title/body; choose → onChoose, cancel → onCancel", () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    render(<LocalFileRequestCard onChoose={onChoose} onCancel={onCancel} />);
    expect(screen.getByText(/wants to read a local text or PDF file/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Choose file/));
    expect(onChoose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/Cancel/));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancel button shows a countdown suffix initially", () => {
    render(<LocalFileRequestCard onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Cancel \(\d+s\)/)).toBeTruthy();
  });

  it("browser register: caps label text-accent (not warning)", () => {
    render(<LocalFileRequestCard onChoose={() => {}} onCancel={() => {}} />);
    const caps = screen.getByText("Local file");
    expect(caps.className).toContain("text-accent");
    expect(caps.className).not.toContain("text-warning");
  });
});
