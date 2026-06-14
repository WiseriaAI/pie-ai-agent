import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitForElementToBeRemoved } from "@testing-library/react";
import { MotionProvider } from "./motion";
import { Popover } from "./Popover";

afterEach(() => cleanup());

function tree(open: boolean) {
  return (
    <MotionProvider>
      <Popover open={open} role="dialog" className="fixed" style={{ left: 10, top: 20 }}>
        <div>popover-body</div>
      </Popover>
    </MotionProvider>
  );
}

describe("Popover", () => {
  it("renders nothing when closed", () => {
    render(tree(false));
    expect(screen.queryByText("popover-body")).toBeNull();
  });

  it("portals content under document.body when open (escapes the render container)", () => {
    const { container } = render(tree(true));
    const panel = screen.getByRole("dialog");
    expect(document.body.contains(panel)).toBe(true);
    expect(container.contains(panel)).toBe(false);
    expect(screen.getByText("popover-body")).toBeTruthy();
  });

  it("applies the forwarded positioning style + className", () => {
    render(tree(true));
    const panel = screen.getByRole("dialog") as HTMLElement;
    expect(panel.className).toContain("fixed");
    expect(panel.style.left).toBe("10px");
  });

  it("animates closed then unmounts", async () => {
    const { rerender } = render(tree(true));
    expect(screen.queryByText("popover-body")).not.toBeNull();
    rerender(tree(false));
    await waitForElementToBeRemoved(() => screen.queryByText("popover-body"), { timeout: 2000 });
    expect(screen.queryByText("popover-body")).toBeNull();
  });
});
