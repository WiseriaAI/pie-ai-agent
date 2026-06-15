import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { GoogleGlyph, SparkGlyph, ChevronGlyph } from "./icons";

afterEach(() => cleanup());

describe("brand/icon glyphs", () => {
  it("GoogleGlyph renders 4 brand-colored paths", () => {
    const { container } = render(<GoogleGlyph />);
    const fills = [...container.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
    expect(fills).toEqual(
      expect.arrayContaining(["#EA4335", "#4285F4", "#FBBC05", "#34A853"]),
    );
  });

  it("SparkGlyph and ChevronGlyph render an svg", () => {
    expect(render(<SparkGlyph />).container.querySelector("svg")).toBeTruthy();
    expect(render(<ChevronGlyph />).container.querySelector("svg")).toBeTruthy();
  });
});
