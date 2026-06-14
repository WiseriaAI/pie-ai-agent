import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitForElementToBeRemoved } from "@testing-library/react";
import { MotionProvider } from "./motion";
import { DropdownPanel } from "./DropdownPanel";

afterEach(() => cleanup());

function tree(open: boolean) {
  return (
    <MotionProvider>
      <DropdownPanel open={open} role="listbox" className="absolute z-10">
        <div>panel-body</div>
      </DropdownPanel>
    </MotionProvider>
  );
}

describe("DropdownPanel", () => {
  it("renders nothing when closed", () => {
    render(tree(false));
    expect(screen.queryByText("panel-body")).toBeNull();
  });

  it("mounts content in place when open (no portal — stays in the render container)", () => {
    const { container } = render(tree(true));
    const panel = screen.getByRole("listbox");
    // Unlike Popover, the panel is NOT portaled to document.body.
    expect(container.contains(panel)).toBe(true);
    expect(screen.getByText("panel-body")).toBeTruthy();
  });

  it("forwards className for caller-owned positioning", () => {
    render(tree(true));
    const panel = screen.getByRole("listbox") as HTMLElement;
    expect(panel.className).toContain("absolute");
  });

  it("animates closed then unmounts", async () => {
    const { rerender } = render(tree(true));
    expect(screen.queryByText("panel-body")).not.toBeNull();
    rerender(tree(false));
    await waitForElementToBeRemoved(() => screen.queryByText("panel-body"), { timeout: 2000 });
    expect(screen.queryByText("panel-body")).toBeNull();
  });
});
