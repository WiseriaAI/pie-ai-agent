import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ContextRing from "../ContextRing";

afterEach(cleanup);

describe("ContextRing — render gates (#59)", () => {
  it("renders nothing when lastInputTokens is undefined", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={undefined}
        lastOutputTokens={undefined}
        totalInputTokens={0}
        totalOutputTokens={0}
        maxContextTokens={200_000}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when lastInputTokens is 0", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={0}
        lastOutputTokens={0}
        totalInputTokens={0}
        totalOutputTokens={0}
        maxContextTokens={200_000}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when maxContextTokens is missing", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={1000}
        lastOutputTokens={50}
        totalInputTokens={1000}
        totalOutputTokens={50}
        maxContextTokens={undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the ring when usage and max are present", () => {
    render(
      <ContextRing
        lastInputTokens={1000}
        lastOutputTokens={50}
        totalInputTokens={1000}
        totalOutputTokens={50}
        maxContextTokens={200_000}
      />,
    );
    expect(screen.getByTestId("context-ring")).toBeTruthy();
  });
});

describe("ContextRing — color thresholds", () => {
  function getStroke(): string | null {
    const ring = screen.getByTestId("context-ring");
    const circles = ring.querySelectorAll("circle");
    return circles[1]?.getAttribute("stroke") ?? null;
  }

  it("uses slate color below 60%", () => {
    render(
      <ContextRing
        lastInputTokens={48_000}
        lastOutputTokens={500}
        totalInputTokens={48_000}
        totalOutputTokens={500}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#6E767D");
  });

  it("uses amber color in [60%, 80%)", () => {
    render(
      <ContextRing
        lastInputTokens={124_000}
        lastOutputTokens={1400}
        totalInputTokens={124_000}
        totalOutputTokens={1400}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#E07A4A");
  });

  it("uses red color at or above 80%", () => {
    render(
      <ContextRing
        lastInputTokens={174_000}
        lastOutputTokens={1400}
        totalInputTokens={174_000}
        totalOutputTokens={1400}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#D9544A");
  });
});

describe("ContextRing — popover interaction", () => {
  function renderRing() {
    return render(
      <ContextRing
        lastInputTokens={124_000}
        lastOutputTokens={1400}
        totalInputTokens={8_243}
        totalOutputTokens={1_402}
        maxContextTokens={200_000}
      />,
    );
  }

  it("popover is closed by default", () => {
    renderRing();
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });

  it("click opens the popover with the three rows", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    expect(popover.textContent).toContain("8,243");
    expect(popover.textContent).toContain("1,402");
    expect(popover.textContent).toContain("9,645");
  });

  it("ESC closes the popover", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    expect(screen.queryByTestId("context-ring-popover")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });

  it("second click on ring closes the popover (toggle)", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    fireEvent.click(screen.getByTestId("context-ring"));
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });
});
