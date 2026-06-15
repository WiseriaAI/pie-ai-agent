import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SmoothHeight } from "./SmoothHeight";

afterEach(() => cleanup());

describe("SmoothHeight", () => {
  it("renders its children (transparent passthrough)", () => {
    render(
      <SmoothHeight>
        <div>hello content</div>
      </SmoothHeight>,
    );
    expect(screen.getByText("hello content")).toBeTruthy();
  });

  it("keeps children mounted when content swaps", () => {
    const { rerender } = render(
      <SmoothHeight>
        <div>first</div>
      </SmoothHeight>,
    );
    expect(screen.getByText("first")).toBeTruthy();
    rerender(
      <SmoothHeight>
        <div>second</div>
      </SmoothHeight>,
    );
    expect(screen.getByText("second")).toBeTruthy();
  });
});
