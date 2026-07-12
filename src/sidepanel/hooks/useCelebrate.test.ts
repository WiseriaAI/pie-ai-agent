import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCelebrate } from "./useCelebrate";
import type { DisplayMessage } from "@/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers();
});

const assistantMsg: DisplayMessage = { role: "assistant", content: "done" };
const okSummary: DisplayMessage = {
  role: "agent-summary",
  success: true,
  summary: "did it",
  stepCount: 3,
};
const failSummary: DisplayMessage = { ...okSummary, success: false };

function setup(initial?: Partial<Parameters<typeof useCelebrate>[0]>) {
  const base = {
    streaming: false,
    error: null as string | null,
    messages: [] as DisplayMessage[],
    sessionId: "s1" as string | null,
  };
  return renderHook((props) => useCelebrate(props), {
    initialProps: { ...base, ...initial },
  });
}

describe("useCelebrate", () => {
  it("streaming true→false 且末尾 assistant → true，2.5s 后自动复位", () => {
    const { result, rerender } = setup({ streaming: true });
    expect(result.current).toBe(false);
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).toBe(false);
  });

  it("末尾 agent-summary success=true → true", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg, okSummary], sessionId: "s1" });
    expect(result.current).toBe(true);
  });

  it("agent-summary success=false（失败/abort/discard）→ 不庆祝", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [failSummary], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("chat-error（error 非空）→ 不庆祝", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: "boom", messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("非边沿（一直 false）→ 不庆祝", () => {
    const { result, rerender } = setup();
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("庆祝期间新任务开始 → 立即复位", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    rerender({ streaming: true, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("庆祝期间 messages 变化不打断计时（2.5s 后照常复位）", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    rerender({ streaming: false, error: null, messages: [assistantMsg, okSummary], sessionId: "s1" });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).toBe(false);
  });

  it("sessionId 变更 → 立即复位", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s2" });
    expect(result.current).toBe(false);
  });

  it("切会话产生的 true→false 假边沿 → 不庆祝", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s2" });
    expect(result.current).toBe(false);
  });
});
