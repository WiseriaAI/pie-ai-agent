import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button } from "./Button";

afterEach(() => cleanup());

describe("Button", () => {
  it("renders children and fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled and suppresses onClick while loading", () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const btn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies the primary fill class", () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole("button").className).toContain("bg-fg-1");
  });

  it("applies the danger tone class", () => {
    render(<Button variant="danger">Forget</Button>);
    expect(screen.getByRole("button").className).toContain("text-warning");
  });

  it("uses the control radius token", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").className).toContain("rounded-control");
  });

  it("merges custom className", () => {
    render(<Button className="mt-2">Go</Button>);
    expect(screen.getByRole("button").className).toContain("mt-2");
  });

  it("emits w-full when fullWidth", () => {
    render(<Button fullWidth>Go</Button>);
    expect(screen.getByRole("button").className).toContain("w-full");
  });

  it("renders iconLeft and iconRight", () => {
    render(
      <Button iconLeft={<svg data-testid="li" />} iconRight={<svg data-testid="ri" />}>
        Go
      </Button>,
    );
    expect(screen.getByTestId("li")).toBeTruthy();
    expect(screen.getByTestId("ri")).toBeTruthy();
  });

  it("hides iconRight while loading", () => {
    render(
      <Button loading iconRight={<svg data-testid="ri" />}>
        Go
      </Button>,
    );
    expect(screen.queryByTestId("ri")).toBeNull();
  });

  it("sets aria-busy while loading", () => {
    render(<Button loading>Go</Button>);
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
  });
});
