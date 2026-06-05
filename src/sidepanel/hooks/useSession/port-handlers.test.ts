import { describe, expect, it, vi } from "vitest";
import { createPortHandlers } from "./port-handlers";
import { EMPTY_SLOT, type SessionRuntimeSlot } from "./runtime-map";
import type { PortMessageToPanel } from "@/types";

function makeDeps() {
  const slotsRef = { current: new Map<string, SessionRuntimeSlot>() };
  const setSlots = vi.fn((updater: any) => {
    slotsRef.current =
      typeof updater === "function" ? updater(slotsRef.current) : updater;
  });
  const persistMessages = vi.fn(async () => {});
  return { slotsRef, setSlots, persistMessages };
}

describe("port-handlers — handleMessage routing", () => {
  describe("chat-chunk", () => {
    it("appends text to the slot identified by message.sessionId", () => {
      const deps = makeDeps();
      const { handleMessage } = createPortHandlers(deps);
      handleMessage({ type: "chat-chunk", text: "hi", sessionId: "s1" } as PortMessageToPanel);
      expect(deps.slotsRef.current.get("s1")?.accumulated).toBe("hi");
      expect(deps.slotsRef.current.get("s1")?.streamingText).toBe("hi");
    });

    it("does not touch other sessions' slots", () => {
      const deps = makeDeps();
      deps.slotsRef.current.set("s2", { ...EMPTY_SLOT, accumulated: "existing" });
      const { handleMessage } = createPortHandlers(deps);
      handleMessage({ type: "chat-chunk", text: "x", sessionId: "s1" } as PortMessageToPanel);
      expect(deps.slotsRef.current.get("s2")?.accumulated).toBe("existing");
    });
  });

  describe("chat-error", () => {
    it("flushes partial text and stores the error string", async () => {
      const deps = makeDeps();
      deps.slotsRef.current.set("s1", {
        ...EMPTY_SLOT,
        accumulated: "partial",
        streaming: true,
        streamFinished: false,
      });
      const { handleMessage } = createPortHandlers(deps);
      handleMessage({ type: "chat-error", error: "boom", sessionId: "s1" } as PortMessageToPanel);
      const slot = deps.slotsRef.current.get("s1")!;
      expect(slot.error).toBe("boom");
      expect(slot.streaming).toBe(false);
      expect(slot.streamFinished).toBe(true);
      expect(slot.messages).toEqual([{ role: "assistant", content: "partial" }]);
      expect(deps.persistMessages).toHaveBeenCalledWith(
        "s1",
        [{ role: "assistant", content: "partial" }],
      );
    });
  });
});

describe("chat-done", () => {
  it("flushes accumulated text into messages and resets streaming", async () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "hello world",
      streamingText: "hello world",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "chat-done", sessionId: "s1" } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([{ role: "assistant", content: "hello world" }]);
    expect(slot.accumulated).toBe("");
    expect(slot.streamingText).toBe("");
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    // persistMessages called with the new messages array
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "assistant", content: "hello world" }],
    );
  });

  it("does not append an empty assistant message when accumulated is whitespace", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "   ",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "chat-done", sessionId: "s1" } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([]);
    expect(slot.streaming).toBe(false);
  });
});

describe("agent-step", () => {
  it("flushes pending accumulated text before appending the step", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "thinking…",
      streamingText: "thinking…",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 0,
      tool: "click",
      args: { selector: "#x" },
      status: "pending",
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([
      { role: "assistant", content: "thinking…" },
      {
        role: "agent-step",
        stepIndex: 0,
        tool: "click",
        args: { selector: "#x" },
        resolvedElement: undefined,
        status: "pending",
        observation: undefined,
      },
    ]);
    expect(slot.accumulated).toBe("");
    expect(slot.streamingText).toBe("");
  });

  it("updates the existing trailing step bubble when stepIndex+tool match", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      messages: [
        {
          role: "agent-step",
          stepIndex: 0,
          tool: "click",
          args: { selector: "#x" },
          resolvedElement: undefined,
          status: "pending",
          observation: undefined,
        },
      ],
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 0,
      tool: "click",
      args: { selector: "#x" },
      status: "ok",
      observation: "clicked",
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toHaveLength(1);
    expect(slot.messages[0]).toMatchObject({ status: "ok", observation: "clicked" });
  });

  it("appends a new step when stepIndex differs", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      messages: [
        {
          role: "agent-step",
          stepIndex: 0,
          tool: "click",
          args: { selector: "#a" },
          resolvedElement: undefined,
          status: "ok",
          observation: "clicked",
        },
      ],
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 1,
      tool: "type",
      args: { text: "hi" },
      status: "pending",
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")!.messages).toHaveLength(2);
  });
});

describe("agent-done-task", () => {
  it("appends agent-summary, resets streaming, persists", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", { ...EMPTY_SLOT, streaming: true, streamFinished: false });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-done-task",
      sessionId: "s1",
      success: true,
      summary: "ok",
      stepCount: 3,
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([
      { role: "agent-summary", success: true, summary: "ok", stepCount: 3 },
    ]);
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "agent-summary", success: true, summary: "ok", stepCount: 3 }],
    );
  });

  it("flushes in-flight streamed text/thinking before the summary on mid-stream abort", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "partial answer",
      streamingText: "partial answer",
      streamingThinking: "was thinking",
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-done-task",
      sessionId: "s1",
      success: false,
      summary: "任务已取消",
      stepCount: 2,
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    // The streamed assistant turn must survive — not be discarded by the reset.
    expect(slot.messages).toEqual([
      { role: "assistant", content: "partial answer", thinking: "was thinking" },
      { role: "agent-summary", success: false, summary: "任务已取消", stepCount: 2 },
    ]);
    expect(slot.accumulated).toBe("");
    expect(slot.streamingText).toBe("");
    expect(slot.streamingThinking).toBe("");
    expect(deps.persistMessages).toHaveBeenCalledWith("s1", [
      { role: "assistant", content: "partial answer", thinking: "was thinking" },
      { role: "agent-summary", success: false, summary: "任务已取消", stepCount: 2 },
    ]);
  });
});

describe("session-confirm-request", () => {
  it("appends a session-confirm DisplayMessage", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "session-confirm-request",
      sessionId: "s1",
      confirmationId: "sc1",
      kind: "drift-card",
      payload: { driftedOrigin: "https://x.com" },
    } as unknown as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toHaveLength(1);
    expect(slot.messages[0]).toMatchObject({
      role: "session-confirm",
      confirmationId: "sc1",
      kind: "drift-card",
    });
  });

  it("is idempotent on confirmationId", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    const m = {
      type: "session-confirm-request",
      sessionId: "s1",
      confirmationId: "sc1",
      kind: "paused-resume",
      payload: {},
    } as PortMessageToPanel;
    handleMessage(m);
    handleMessage(m);
    expect(deps.slotsRef.current.get("s1")!.messages).toHaveLength(1);
  });
});

describe("session-toast", () => {
  it("sets toast on the addressed session's slot", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "session-toast",
      sessionId: "s1",
      level: "warn",
      text: "flood",
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")!.toast).toEqual({ level: "warn", text: "flood" });
  });
});

describe("makeDisconnectHandler", () => {
  it("no-op when streamFinished is true", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", { ...EMPTY_SLOT, streamFinished: true });
    const { makeDisconnectHandler } = createPortHandlers(deps);
    makeDisconnectHandler("s1")();
    expect(deps.persistMessages).not.toHaveBeenCalled();
    expect(deps.slotsRef.current.get("s1")?.streaming).toBe(false);
  });

  it("flushes partial text and persists when streamFinished is false", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      accumulated: "half",
      streaming: true,
      streamFinished: false,
    });
    const { makeDisconnectHandler } = createPortHandlers(deps);
    makeDisconnectHandler("s1")();
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([{ role: "assistant", content: "half" }]);
    expect(slot.accumulated).toBe("");
    expect(slot.streaming).toBe(false);
    expect(slot.streamFinished).toBe(true);
    expect(deps.persistMessages).toHaveBeenCalledWith(
      "s1",
      [{ role: "assistant", content: "half" }],
    );
  });

  it("scopes to the captured sessionId only", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", { ...EMPTY_SLOT, streaming: true, streamFinished: false });
    deps.slotsRef.current.set("s2", { ...EMPTY_SLOT, streaming: true, streamFinished: false });
    const { makeDisconnectHandler } = createPortHandlers(deps);
    makeDisconnectHandler("s1")();
    expect(deps.slotsRef.current.get("s2")?.streaming).toBe(true);
  });
});

describe("thinking-chunk", () => {
  it("accumulates thinking-chunk and attaches it on chat-done", async () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "thinking-chunk", text: "reason ", sessionId: "s1" } as PortMessageToPanel);
    handleMessage({ type: "thinking-chunk", text: "more", sessionId: "s1" } as PortMessageToPanel);
    handleMessage({ type: "chat-chunk", text: "answer", sessionId: "s1" } as PortMessageToPanel);
    handleMessage({ type: "chat-done", sessionId: "s1" } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages).toEqual([
      { role: "assistant", content: "answer", thinking: "reason more" },
    ]);
    expect(slot.streamingThinking).toBe("");
  });

  it("flushes a thinking-only assistant message before an agent-step", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      streaming: true,
      streamFinished: false,
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({ type: "thinking-chunk", text: "deciding", sessionId: "s1" } as PortMessageToPanel);
    handleMessage({
      type: "agent-step",
      sessionId: "s1",
      stepIndex: 0,
      tool: "click",
      args: {},
      status: "pending",
    } as PortMessageToPanel);
    const slot = deps.slotsRef.current.get("s1")!;
    expect(slot.messages[0]).toEqual({ role: "assistant", content: "", thinking: "deciding" });
    expect(slot.messages[1]).toMatchObject({ role: "agent-step", tool: "click" });
  });
});

describe("agent-usage", () => {
  it("writes payload fields onto slot.usage for the matching sessionId", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 1200,
      lastOutputTokens: 80,
      totalInputTokens: 5200,
      totalOutputTokens: 320,
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")?.usage).toEqual({
      lastInputTokens: 1200,
      lastOutputTokens: 80,
      totalInputTokens: 5200,
      totalOutputTokens: 320,
    });
  });

  it("does not call persistMessages (no storage write from panel side)", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 100,
      lastOutputTokens: 5,
      totalInputTokens: 100,
      totalOutputTokens: 5,
    } as PortMessageToPanel);
    expect(deps.persistMessages).not.toHaveBeenCalled();
  });

  it("does not touch other sessions' slots", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s2", {
      ...EMPTY_SLOT,
      usage: {
        totalInputTokens: 999,
        totalOutputTokens: 99,
        lastInputTokens: 99,
        lastOutputTokens: 9,
      },
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 1,
      lastOutputTokens: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s2")?.usage?.totalInputTokens).toBe(999);
  });

  it("replaces (does not merge) the slot.usage object — SW pre-summed totals are authoritative", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      usage: {
        totalInputTokens: 9999,
        totalOutputTokens: 999,
        lastInputTokens: 500,
        lastOutputTokens: 30,
      },
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 200,
      lastOutputTokens: 10,
      totalInputTokens: 10199,
      totalOutputTokens: 1009,
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")?.usage?.totalInputTokens).toBe(10199);
    expect(deps.slotsRef.current.get("s1")?.usage?.lastInputTokens).toBe(200);
  });
});
