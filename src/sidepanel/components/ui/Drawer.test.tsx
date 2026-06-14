import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MotionProvider } from "./motion";
import { Drawer } from "./Drawer";

afterEach(() => cleanup());

function wrap(ui: ReactNode) {
  return render(<MotionProvider>{ui}</MotionProvider>);
}

describe("Drawer", () => {
  it("renders nothing when closed", () => {
    wrap(
      <Drawer open={false} onClose={() => {}} ariaLabel="Sessions">
        <button>x</button>
      </Drawer>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a dialog with aria-modal + aria-label when open", () => {
    wrap(
      <Drawer open onClose={() => {}} ariaLabel="Sessions">
        <button>x</button>
      </Drawer>,
    );
    const d = screen.getByRole("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-label")).toBe("Sessions");
  });

  it("calls onClose on ESC", () => {
    const onClose = vi.fn();
    wrap(
      <Drawer open onClose={onClose} ariaLabel="S">
        <button>x</button>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    wrap(
      <Drawer open onClose={onClose} ariaLabel="S" backdropTestId="bd">
        <button>x</button>
      </Drawer>,
    );
    fireEvent.click(document.querySelector("[data-testid='bd']")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("focuses the first focusable element on open", () => {
    wrap(
      <Drawer open onClose={() => {}} ariaLabel="S">
        <button>first</button>
        <button>second</button>
      </Drawer>,
    );
    expect(document.activeElement?.textContent).toBe("first");
  });

  it("traps focus: Shift+Tab on first wraps to last", () => {
    wrap(
      <Drawer open onClose={() => {}} ariaLabel="S">
        <button>first</button>
        <button>last</button>
      </Drawer>,
    );
    const first = screen.getByText("first");
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("last");
  });

  it("restores focus to the pre-open element on close, then unmounts", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(false)}>close</button>
          <Drawer open={open} onClose={() => setOpen(false)} ariaLabel="S">
            <button>inside</button>
          </Drawer>
        </>
      );
    }
    wrap(<Harness />);
    fireEvent.click(screen.getByText("close"));
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
