import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AgentBrandIcon } from "./agent-brand-icons";

afterEach(() => cleanup());

function svgOf(agentId: string): SVGSVGElement {
  const { container } = render(<AgentBrandIcon agentId={agentId} />);
  return container.querySelector("svg") as SVGSVGElement;
}

describe("AgentBrandIcon", () => {
  it("claude-* → Claude mark filled with the brand orange", () => {
    for (const id of ["claude-app", "claude-terminal"]) {
      const svg = svgOf(id);
      expect(svg.getAttribute("data-brand")).toBe("claude");
      expect(svg.getAttribute("fill")).toBe("#D97757");
      expect(svg.querySelector("path")).toBeTruthy();
    }
  });

  it("codex-* → Codex mark filled with currentColor (flips with the theme)", () => {
    const svg = svgOf("codex-terminal");
    expect(svg.getAttribute("data-brand")).toBe("codex");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.querySelector("path")).toBeTruthy();
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

  it("按 id 前缀选对品牌（app / terminal 两形态共用一个 mark，#269 新增三家）", () => {
    expect(svgOf("cursor-app").getAttribute("data-brand")).toBe("cursor");
    expect(svgOf("cursor-terminal").getAttribute("data-brand")).toBe("cursor");
    expect(svgOf("opencode-terminal").getAttribute("data-brand")).toBe("opencode");
    expect(svgOf("pi-terminal").getAttribute("data-brand")).toBe("pi");
  });

  it("Pi 的 P 形靠 evenodd 挖洞，丢了就变实心块", () => {
    const svg = svgOf("pi-terminal");
    expect(svg.querySelector('path[fill-rule="evenodd"]')).not.toBeNull();
  });

  it("OpenCode 内块在外框之前（外框靠 nonzero 挖空）", () => {
    const paths = svgOf("opencode-terminal").querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("fill")).toBe("#CFCECD"); // 内块先画
    expect(paths[1].getAttribute("fill")).toBe("currentColor"); // 外框后画
  });
});
