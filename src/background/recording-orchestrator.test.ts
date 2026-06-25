import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordingState,
  handleRecordingStart,
  handleRecordingAction,
  handleRecordingFinish,
  handleRecordingDiscard,
  handleRecordingTabClosed,
  handleRecordingNavCommitted,
  abortRecordingForSession,
  registerFlowTab,
  recordFlowTabUrl,
  removeFlowTab,
} from "./recording-orchestrator";
import type {
  CapturedActionPayload,
  RecordedAction,
  RecordingSession,
} from "@/lib/recording/types";

const mockExec = vi.fn().mockResolvedValue([{ result: undefined }]);
const mockTabQuery = vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com/x", active: true }]);
const skillStore = new Map<string, unknown>();
beforeEach(() => {
  recordingState.clear();
  mockExec.mockClear();
  mockTabQuery.mockClear();
  mockTabQuery.mockResolvedValue([{ id: 1, url: "https://example.com/x", active: true }]);
  skillStore.clear();
  (globalThis as { chrome?: unknown }).chrome = {
    scripting: { executeScript: mockExec },
    tabs: { query: mockTabQuery },
    storage: {
      local: {
        get: vi.fn().mockImplementation(async () => Object.fromEntries(skillStore)),
        set: vi.fn().mockImplementation(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) skillStore.set(k, v);
        }),
        remove: vi.fn(),
      },
    },
  };
});

const port = {
  postMessage: vi.fn(),
  name: "chat-stream-S1",
};

describe("recording-orchestrator", () => {
  it("handleRecordingStart creates session + injects capture", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S1",
    });
    expect(recordingState.has("S1")).toBe(true);
    expect(mockExec).toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "recording-started", sessionId: "S1" }),
    );
  });

  it("rejects start when active session is streaming agent task (SW-side gate)", async () => {
    port.postMessage.mockClear();
    await handleRecordingStart(
      port as unknown as chrome.runtime.Port,
      { type: "recording-start", sessionId: "S-busy" },
      (sid) => sid === "S-busy",
    );
    expect(recordingState.has("S-busy")).toBe(false);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-toast",
        level: "warn",
        text: expect.stringMatching(/Agent task in progress/),
      }),
    );
  });

  it("rejects start when restricted URL", async () => {
    mockTabQuery.mockResolvedValueOnce([{ id: 1, url: "chrome://extensions", active: true }]);
    port.postMessage.mockClear();
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S2",
    });
    expect(recordingState.has("S2")).toBe(false);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-toast", level: "warn" }),
    );
  });

  it("handleRecordingAction appends to session and broadcasts", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S3",
    });
    port.postMessage.mockClear();
    const payload: CapturedActionPayload = {
      type: "click",
      label: "按钮 'X'",
      url: "https://example.com",
      region: "main",
    };
    handleRecordingAction(
      { tab: { id: 1 } } as chrome.runtime.MessageSender,
      { type: "recording-action", payload },
      port as unknown as chrome.runtime.Port,
    );
    expect(recordingState.get("S3")?.actions).toHaveLength(1);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "recording-action-broadcast", sessionId: "S3" }),
    );
  });

  it("rejects action from non-recorded tabId (multi-session sandbox)", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S4",
    });
    const portCount = port.postMessage.mock.calls.length;
    handleRecordingAction(
      { tab: { id: 999 } } as chrome.runtime.MessageSender,
      { type: "recording-action", payload: { type: "click", label: "X", url: "https://other.com", region: "main" } },
      port as unknown as chrome.runtime.Port,
    );
    expect(recordingState.get("S4")?.actions ?? []).toHaveLength(0);
    expect(port.postMessage.mock.calls.length).toBe(portCount);
  });

  it("handleRecordingFinish broadcasts serializedTrace + stepCount + clears session (Reframe)", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S5",
    });
    // Feed an action via handleRecordingAction (sess.actions is now SW-side
    // owned, not panel-supplied) — Reframe (2026-05-05) removes finalActions
    // from RecordingFinishMessage.
    handleRecordingAction(
      { tab: { id: 1 } } as chrome.runtime.MessageSender,
      {
        type: "recording-action",
        payload: { type: "click", label: "按钮 'X'", url: "u", region: "main" },
      },
      port as unknown as chrome.runtime.Port,
    );
    port.postMessage.mockClear();
    await handleRecordingFinish(port as unknown as chrome.runtime.Port, {
      type: "recording-finish",
      sessionId: "S5",
    });
    expect(recordingState.has("S5")).toBe(false);
    // Reframe: SW does NOT save skill anymore — chat input chip + LLM does it.
    expect(skillStore.size).toBe(0);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "recording-finished",
        sessionId: "S5",
        serializedTrace: expect.stringContaining("第 1 步：点击按钮 'X'"),
        stepCount: 1,
      }),
    );
  });

  it("handleRecordingFinish rejects empty recording (no actions captured)", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S5b",
    });
    port.postMessage.mockClear();
    await handleRecordingFinish(port as unknown as chrome.runtime.Port, {
      type: "recording-finish",
      sessionId: "S5b",
    });
    // Session NOT cleared so user can keep recording.
    expect(recordingState.has("S5b")).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-toast",
        level: "warn",
        text: expect.stringMatching(/empty/i),
      }),
    );
  });

  it("handleRecordingFinish rejects when serialized trace exceeds 8KB", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S6",
    });
    // Feed 50 long actions via SW path so sess.actions grows beyond 8KB serialized.
    const longLabel = "x".repeat(500);
    for (let i = 0; i < 50; i++) {
      handleRecordingAction(
        { tab: { id: 1 } } as chrome.runtime.MessageSender,
        {
          type: "recording-action",
          payload: { type: "click", label: longLabel, url: "u", region: "main" },
        },
        port as unknown as chrome.runtime.Port,
      );
    }
    port.postMessage.mockClear();
    await handleRecordingFinish(port as unknown as chrome.runtime.Port, {
      type: "recording-finish",
      sessionId: "S6",
    });
    // Session NOT cleared so user can discard + re-record shorter.
    expect(recordingState.has("S6")).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-toast", level: "error" }),
    );
  });

  it("handleRecordingDiscard clears session + broadcasts aborted", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S7",
    });
    await handleRecordingDiscard(port as unknown as chrome.runtime.Port, {
      type: "recording-discard",
      sessionId: "S7",
    });
    expect(recordingState.has("S7")).toBe(false);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "recording-aborted", reason: "user-discard" }),
    );
  });

  it("abortRecordingForSession purges + broadcasts abort with given reason", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S8",
    });
    abortRecordingForSession(port as unknown as chrome.runtime.Port, "S8", "panel-disconnect");
    expect(recordingState.has("S8")).toBe(false);
  });

  it("handleRecordingTabClosed aborts session whose tab closed", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S9",
    });
    handleRecordingTabClosed(port as unknown as chrome.runtime.Port, 1);
    expect(recordingState.has("S9")).toBe(false);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "recording-aborted", reason: "tab-closed" }),
    );
  });

  it("handleRecordingNavCommitted records navigate action and re-injects listener", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S10",
    });
    mockExec.mockClear();
    port.postMessage.mockClear();
    await handleRecordingNavCommitted(port as unknown as chrome.runtime.Port, {
      tabId: 1,
      url: "https://example.com/next",
      frameId: 0,
    });
    const sess = recordingState.get("S10")!;
    expect(sess.actions).toHaveLength(1);
    expect(sess.actions[0]!.type).toBe("navigate");
    expect(mockExec).toHaveBeenCalled();
  });
});

function flowSess(): RecordingSession {
  return {
    sessionId: "s1",
    tabId: 10,
    origin: "https://shop.com",
    startedAt: 0,
    tabRefByTabId: new Map([[10, 0]]),
    nextTabRef: 1,
    tabRegistry: { 0: { origin: "https://shop.com", firstUrl: "https://shop.com/cart" } },
    actions: [],
  };
}

describe("recording flow-set helpers", () => {
  it("registerFlowTab assigns sequential tabRefs and is idempotent", () => {
    const s = flowSess();
    const ref = registerFlowTab(s, 11);
    expect(ref).toBe(1);
    expect(registerFlowTab(s, 11)).toBe(1); // idempotent
    expect(registerFlowTab(s, 12)).toBe(2);
    expect(s.nextTabRef).toBe(3);
  });

  it("recordFlowTabUrl fills registry origin once, then leaves it", () => {
    const s = flowSess();
    registerFlowTab(s, 11);
    recordFlowTabUrl(s, 11, "https://pay.stripe.com/checkout?x=1");
    expect(s.tabRegistry[1]).toEqual({
      origin: "https://pay.stripe.com",
      firstUrl: "https://pay.stripe.com/checkout?x=1",
    });
    recordFlowTabUrl(s, 11, "https://pay.stripe.com/success");
    expect(s.tabRegistry[1].firstUrl).toBe("https://pay.stripe.com/checkout?x=1"); // unchanged
  });

  it("removeFlowTab reports empty only when the last tab leaves", () => {
    const s = flowSess();
    registerFlowTab(s, 11);
    expect(removeFlowTab(s, 11)).toEqual({ removed: true, empty: false });
    expect(removeFlowTab(s, 10)).toEqual({ removed: true, empty: true });
    expect(removeFlowTab(s, 99)).toEqual({ removed: false, empty: true });
  });
});
