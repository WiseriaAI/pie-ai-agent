import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AgentBrandIcon } from "./agent-brand-icons";

afterEach(() => cleanup());

function svgOf(agentId: string): SVGSVGElement {
  const { container } = render(<AgentBrandIcon agentId={agentId} />);
  return container.querySelector("svg") as SVGSVGElement;
}

describe("AgentBrandIcon", () => {
  it("claude-* → Claude mark with brand stroke", () => {
    for (const id of ["claude-app", "claude-terminal"]) {
      const svg = svgOf(id);
      expect(svg.getAttribute("data-brand")).toBe("claude");
      expect(svg.getAttribute("stroke")).toBe("#D97757");
    }
  });

  it("codex-* → Codex mark with currentColor stroke", () => {
    const svg = svgOf("codex-terminal");
    expect(svg.getAttribute("data-brand")).toBe("codex");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it("unknown id → generic terminal fallback", () => {
    const svg = svgOf("hermes-terminal");
    expect(svg.getAttribute("data-brand")).toBe("generic");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it("size prop controls width/height (default 14)", () => {
    expect(svgOf("claude-app").getAttribute("width")).toBe("14");
    const { container } = render(<AgentBrandIcon agentId="claude-app" size={16} />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("16");
  });
});
