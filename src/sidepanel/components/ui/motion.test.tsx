import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MotionProvider, DURATION, EASE_STANDARD } from "./motion";

afterEach(() => cleanup());

describe("MotionProvider", () => {
  it("renders its children", () => {
    render(<MotionProvider><span>child</span></MotionProvider>);
    expect(screen.getByText("child")).toBeTruthy();
  });

  it("exposes duration tokens (seconds) mirroring the CSS --duration-* values", () => {
    // index.css: --duration-fast 140ms / base 200ms / slow 260ms
    expect(DURATION).toEqual({ fast: 0.14, base: 0.2, slow: 0.26 });
  });

  it("exposes the standard easing tuple mirroring --ease-standard", () => {
    // index.css: --ease-standard cubic-bezier(0.32, 0.72, 0, 1)
    expect(EASE_STANDARD).toEqual([0.32, 0.72, 0, 1]);
  });
});
