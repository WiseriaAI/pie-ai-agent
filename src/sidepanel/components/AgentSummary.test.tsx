import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AgentSummary from "./AgentSummary";

afterEach(() => {
  cleanup();
});

describe("AgentSummary Pie face", () => {
  it("默认渲染静止脸（无动画）", () => {
    const { container } = render(
      <AgentSummary success={true} summary="done" stepCount={2} />,
    );
    expect(container.querySelector('[data-pie-state="static"]')).toBeTruthy();
    expect(container.innerHTML).not.toContain("pie-hop");
  });

  it("celebrating + success → success 态脸", () => {
    const { container } = render(
      <AgentSummary success={true} summary="done" stepCount={2} celebrating />,
    );
    expect(container.querySelector('[data-pie-state="success"]')).toBeTruthy();
  });

  it("celebrating 但 success=false → 仍静止（失败不庆祝），warning 文字保留", () => {
    const { container } = render(
      <AgentSummary success={false} summary="failed" stepCount={2} celebrating />,
    );
    expect(container.querySelector('[data-pie-state="static"]')).toBeTruthy();
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });
});
