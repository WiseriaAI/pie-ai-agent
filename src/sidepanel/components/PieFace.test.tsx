import { render, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import PieFace from "./PieFace";
import type { PieFaceState } from "./PieFace";

afterEach(() => {
  cleanup();
});

/** 渲染并返回 innerHTML，供 keyframe 名断言（happy-dom 不真跑 CSS 动画，
 *  断言 inline style 里的 animation 名即可）。 */
const html = (state: PieFaceState, size = 40) =>
  render(<PieFace state={state} size={size} />).container.innerHTML;

const ALL_KEYFRAMES = [
  "pie-breathe", "pie-blink", "pie-tilt", "pie-dotjump", "pie-thirdin",
  "pie-vibrate", "pie-spin", "pie-listen", "pie-pulse", "pie-hop",
  "pie-pop", "pie-wake-in",
];

describe("PieFace", () => {
  it("static: 无任何 pie-* 动画", () => {
    const h = html("static");
    for (const name of ALL_KEYFRAMES) expect(h).not.toContain(name);
  });

  it("idle: 呼吸 + 眨眼", () => {
    const h = html("idle");
    expect(h).toContain("pie-breathe");
    expect(h).toContain("pie-blink");
  });

  it("listening: 身体 listen + 眨眼 + 两圈 accent 声波", () => {
    const h = html("listening");
    expect(h).toContain("pie-listen");
    expect(h).toContain("pie-blink");
    expect((h.match(/pie-pulse/g) ?? []).length).toBe(2);
    expect(h).toContain("var(--c-accent)");
  });

  it("thinking: 歪头 + 三点跳动 + 第三点入场，无眨眼", () => {
    const h = html("thinking");
    expect(h).toContain("pie-tilt");
    expect((h.match(/pie-dotjump/g) ?? []).length).toBe(3);
    expect(h).toContain("pie-thirdin");
    expect(h).not.toContain("pie-blink");
  });

  it("working: 震动 + 旋转扫描环（SVG stroke 用 accent）", () => {
    const { container } = render(<PieFace state="working" size={40} />);
    const h = container.innerHTML;
    expect(h).toContain("pie-vibrate");
    expect(h).toContain("pie-spin");
    const circle = container.querySelector("circle")!;
    expect(circle.getAttribute("stroke")).toBe("var(--c-accent)");
    expect(circle.getAttribute("stroke-linecap")).toBe("round");
  });

  it("success: 弹跳 + 光环", () => {
    const h = html("success");
    expect(h).toContain("pie-hop");
    expect(h).toContain("pie-pop");
  });

  it("wake: 双眼滑入 morph，animationend(pie-wake-in) 触发 onWakeEnd", () => {
    const onWakeEnd = vi.fn();
    const { container } = render(
      <PieFace state="wake" size={140} onWakeEnd={onWakeEnd} />,
    );
    const root = container.querySelector('[data-pie-state="wake"]')!;
    expect(container.innerHTML).toContain("pie-wake-in");
    // 无关动画结束（如 pie-breathe）不触发
    fireEvent.animationEnd(root, { animationName: "pie-breathe" });
    expect(onWakeEnd).not.toHaveBeenCalled();
    fireEvent.animationEnd(root, { animationName: "pie-wake-in" });
    expect(onWakeEnd).toHaveBeenCalledTimes(1);
  });

  it("根元素 aria-hidden 且带 data-pie-state", () => {
    const { container } = render(<PieFace state="idle" size={16} />);
    const root = container.querySelector('[data-pie-state="idle"]')!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
  });
});
