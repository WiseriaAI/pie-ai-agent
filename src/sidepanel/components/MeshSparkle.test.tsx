import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { MeshSparkle } from "./MeshSparkle";

afterEach(() => {
  cleanup();
});

describe("MeshSparkle", () => {
  it("renders a sparkle-only svg cropped to the bite (no pie body)", () => {
    const { container } = render(<MeshSparkle size={32} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("viewBox")).toBe("80 10 36 36");
    // sparkle only: 4 gradients + 5 star paths, and no pie rect/circle
    expect(container.querySelectorAll("radialGradient")).toHaveLength(4);
    expect(container.querySelectorAll("path")).toHaveLength(5);
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelector("rect")).toBeNull();
  });

  it("accepts a string size (e.g. 100%) for fluid layouts", () => {
    const { container } = render(<MeshSparkle size="100%" />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("100%");
  });

  it("is decorative by default and labelled when given a title", () => {
    const { container, rerender, getByText } = render(<MeshSparkle />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<MeshSparkle title="Pro" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Pro");
    expect(getByText("Pro").tagName.toLowerCase()).toBe("title");
  });

  it("namespaces gradient ids per instance", () => {
    const { container } = render(
      <>
        <MeshSparkle />
        <MeshSparkle />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("radialGradient")).map((n) =>
      n.getAttribute("id"),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
