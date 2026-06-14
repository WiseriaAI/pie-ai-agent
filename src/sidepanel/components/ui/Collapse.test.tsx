import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitForElementToBeRemoved } from "@testing-library/react";
import { MotionProvider } from "./motion";
import { Collapse } from "./Collapse";

afterEach(() => cleanup());

function tree(open: boolean) {
  return (
    <MotionProvider>
      <Collapse open={open}>
        <div>panel-body</div>
      </Collapse>
    </MotionProvider>
  );
}

describe("Collapse", () => {
  it("renders children when open", () => {
    render(tree(true));
    expect(screen.queryByText("panel-body")).not.toBeNull();
  });

  it("renders nothing when initially closed", () => {
    render(tree(false));
    expect(screen.queryByText("panel-body")).toBeNull();
  });

  it("animates closed then unmounts children", async () => {
    const { rerender } = render(tree(true));
    expect(screen.queryByText("panel-body")).not.toBeNull();
    rerender(tree(false));
    await waitForElementToBeRemoved(() => screen.queryByText("panel-body"), { timeout: 2000 });
    expect(screen.queryByText("panel-body")).toBeNull();
  });

  it("forwards className onto the animating wrapper", () => {
    render(
      <MotionProvider>
        <Collapse open className="ml-3 border-l">
          <div>panel-body</div>
        </Collapse>
      </MotionProvider>,
    );
    const wrapper = screen.getByText("panel-body").parentElement!;
    expect(wrapper.className).toContain("ml-3");
    expect(wrapper.className).toContain("border-l");
  });
});
