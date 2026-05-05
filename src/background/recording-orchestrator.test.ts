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
} from "./recording-orchestrator";
import type { CapturedActionPayload, RecordedAction } from "@/lib/recording/types";

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

  it("handleRecordingFinish writes user-authored skill and clears session", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S5",
    });
    const finalActions: RecordedAction[] = [
      { type: "click", label: "按钮 'X'", url: "u", region: "main", timestamp: 1 },
    ];
    await handleRecordingFinish(port as unknown as chrome.runtime.Port, {
      type: "recording-finish",
      sessionId: "S5",
      skillName: "Login Flow",
      skillDescription: "logs in to example",
      finalActions,
      finalAllowedTools: ["click", "done", "fail"],
    });
    expect(recordingState.has("S5")).toBe(false);
    const stored = Array.from(skillStore.entries()).find(([k]) => k.includes("user_"));
    expect(stored).toBeDefined();
    expect((stored![1] as { author?: string }).author).toBe("user");
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "recording-finished", sessionId: "S5" }),
    );
  });

  it("handleRecordingFinish rejects when promptTemplate exceeds 8KB", async () => {
    await handleRecordingStart(port as unknown as chrome.runtime.Port, {
      type: "recording-start",
      sessionId: "S6",
    });
    const longLabel = "x".repeat(500);
    const finalActions: RecordedAction[] = Array.from({ length: 50 }, () => ({
      type: "click" as const,
      label: longLabel,
      url: "u",
      region: "main",
      timestamp: 1,
    }));
    await handleRecordingFinish(port as unknown as chrome.runtime.Port, {
      type: "recording-finish",
      sessionId: "S6",
      skillName: "tooBig",
      skillDescription: "x",
      finalActions,
      finalAllowedTools: ["click"],
    });
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
