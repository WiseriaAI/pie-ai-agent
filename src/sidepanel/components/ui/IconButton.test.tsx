import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IconButton } from "./IconButton";

afterEach(() => cleanup());

const Dot = () => <svg data-testid="dot" width="16" height="16" />;

describe("IconButton", () => {
  it("renders the icon and is reachable by its aria-label", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn).toBeTruthy();
    expect(screen.getByTestId("dot")).toBeTruthy();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Close" icon={<Dot />} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Close" icon={<Dot />} disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses the chip radius token", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    expect(screen.getByRole("button").className).toContain("rounded-chip");
  });

  it("applies the md size (h-8 w-8) by default", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-8");
    expect(cls).toContain("w-8");
  });

  it("applies the default variant border classes", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} variant="default" />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("border-line");
    expect(cls).toContain("bg-surface");
  });

  it("applies the sm size (h-7 w-7)", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} size="sm" />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-7");
    expect(cls).toContain("w-7");
  });

  it("marks the icon as decorative (aria-hidden)", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    expect(screen.getByTestId("dot").closest("[aria-hidden='true']")).toBeTruthy();
  });
});
