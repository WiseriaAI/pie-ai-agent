import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { ManagedPlanIcon } from "./ManagedPlanIcon";

afterEach(() => {
  cleanup();
});

describe("ManagedPlanIcon", () => {
  it("renders an svg sized by the size prop", () => {
    const { container } = render(<ManagedPlanIcon size={48} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("width")).toBe("48");
    expect(svg.getAttribute("height")).toBe("48");
    expect(svg.getAttribute("viewBox")).toBe("0 0 128 128");
  });

  it("defaults to size 24 and is decorative (aria-hidden) without a title", () => {
    const { container } = render(<ManagedPlanIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes a labelled image when a title is given", () => {
    const { container, getByText } = render(<ManagedPlanIcon title="官方订阅" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("官方订阅");
    expect(getByText("官方订阅").tagName.toLowerCase()).toBe("title");
  });

  it("layers four colour gradients over a neutral base star (5 star paths)", () => {
    const { container } = render(<ManagedPlanIcon />);
    expect(container.querySelectorAll("radialGradient")).toHaveLength(4);
    // 5 sparkle paths: 1 neutral base + 4 gradient-filled layers.
    expect(container.querySelectorAll("path")).toHaveLength(5);
  });

  it("namespaces gradient ids per instance to avoid url(#id) collisions", () => {
    const { container } = render(
      <>
        <ManagedPlanIcon />
        <ManagedPlanIcon />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("radialGradient")).map((n) =>
      n.getAttribute("id"),
    );
    expect(new Set(ids).size).toBe(ids.length); // all unique across instances
  });
});
