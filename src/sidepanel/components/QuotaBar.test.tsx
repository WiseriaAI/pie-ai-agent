import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import QuotaBar from "./QuotaBar";

afterEach(() => cleanup());

describe("QuotaBar", () => {
  it("中性档（71%）：显示百分比/重置日，fill 用 bg-fg-1", () => {
    const { container } = render(<QuotaBar usedFraction={0.71} resetAt={1750400000} />);
    expect(screen.getByText("71%")).toBeTruthy();
    expect(screen.getByText("used")).toBeTruthy();
    expect(screen.getByText(/^Resets /)).toBeTruthy();
    expect(container.querySelector(".bg-fg-1")).toBeTruthy();
  });

  it("黄铜档（88%）：fill 用 bg-pending", () => {
    const { container } = render(<QuotaBar usedFraction={0.88} resetAt={1750400000} />);
    expect(screen.getByText("88%")).toBeTruthy();
    expect(container.querySelector(".bg-pending")).toBeTruthy();
  });

  it("红档（≥95%）：fill 用 bg-warning", () => {
    const { container } = render(<QuotaBar usedFraction={0.97} resetAt={1750400000} />);
    expect(screen.getByText("97%")).toBeTruthy();
    expect(container.querySelector(".bg-warning")).toBeTruthy();
  });

  it("分数越界被 clamp（>1 显示 100%）", () => {
    render(<QuotaBar usedFraction={1.4} resetAt={1750400000} />);
    expect(screen.getByText("100%")).toBeTruthy();
  });
});
