/**
 * ADR 0002 — loop emit sink decoupling.
 *
 * These tests verify that runAgentLoop calls ctx.emit (not a port directly)
 * for its outbound messages. We exercise the "done path" by running the loop
 * with a minimal stub that makes the LLM immediately return a plain-text
 * response (→ chat-done), and assert that emit is called with a chat-done msg.
 *
 * The tests import AgentEmit and AgentLoopContext to exercise the public types
 * in addition to runtime behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEmit } from "./loop";

// ---------------------------------------------------------------------------
// Minimal chrome stubs (MV3 service-worker environment)
// ---------------------------------------------------------------------------
const chromeMock = {
  tabs: { get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.com", title: "Test" }) },
  scripting: { executeScript: vi.fn().mockResolvedValue([{ result: "<body>hi</body>" }]) },
  storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
  runtime: { id: "test-ext-id", getURL: vi.fn((p: string) => `chrome-extension://test/${p}`) },
  i18n: { getUILanguage: vi.fn(() => "en") },
};
// @ts-expect-error global chrome stub
globalThis.chrome = chromeMock;

// ---------------------------------------------------------------------------
// Module mocks — only the pieces loop.ts touches outside its own logic
// ---------------------------------------------------------------------------
vi.mock("../../background/image-cache", () => ({
  addImage: vi.fn(),
  evictSession: vi.fn(),
}));
vi.mock("../files/output-store", () => ({ putArtifact: vi.fn() }));
vi.mock("./tools/screenshot", () => ({
  resetTaskBudget: vi.fn(),
  dispatchCaptureVisibleTab: vi.fn(),
  dispatchCaptureFullPageTab: vi.fn(),
}));
vi.mock("./image-hydration", () => ({ hydrateAttachments: vi.fn(async (msgs: unknown) => msgs) }));
vi.mock("./tools", () => ({
  BUILT_IN_TOOLS: [],
  getKeyboardTools: vi.fn(() => []),
  getMouseTools: vi.fn(() => []),
  getEditorTools: vi.fn(() => []),
  isKeyboardToolName: vi.fn(() => false),
}));
vi.mock("./tool-names", () => ({
  getToolClass: vi.fn(() => "read"),
  SCREENSHOT_TOOL_NAMES: [],
  SCREENSHOT_TOOL_NAME_SET: new Set<string>(),
}));
vi.mock("./untrusted-wrappers", () => ({
  escapeUntrustedWrappers: vi.fn((s: string) => s),
}));
vi.mock("./stream-completion", () => ({
  classifyStreamCompletion: vi.fn(() => "normal"),
}));
vi.mock("./prompt", () => ({
  buildAgentSystemPrompt: vi.fn(() => "sys"),
  buildObservationMessage: vi.fn((obs: string) => ({ role: "user", content: obs })),
  // Block A — loop seeds the first user message via buildSeededTaskContent,
  // which calls buildCurrentTimeBlock; provide a deterministic stub here.
  buildCurrentTimeBlock: vi.fn((now: number) => `<current_time>epochMs=${now}</current_time>`),
}));
vi.mock("./window", () => ({
  applySlidingWindow: vi.fn((hist: unknown) => hist),
}));
vi.mock("./elide-stale-observations", () => ({
  elideStaleObservations: vi.fn((hist: unknown) => hist),
}));
vi.mock("./window-token-budget", () => ({
  applyTokenBudget: vi.fn(async (hist: unknown) => hist),
}));
vi.mock("./compact-react-window", () => ({
  compactReactWindow: vi.fn(async (hist: unknown) => hist),
  createDefaultSummarizer: vi.fn(),
}));
vi.mock("../model-router/providers/registry", () => ({
  resolveModelMeta: vi.fn(() => ({
    provider: "openai",
    model: "gpt-4",
    vision: false,
    tools: true,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  })),
}));
vi.mock("./history-validation", () => ({
  validateAndRepairAdjacentRoles: vi.fn((hist: unknown) => ({ repaired: hist, violations: [] })),
  dropEmptyMessages: vi.fn((hist: unknown) => hist),
}));
vi.mock("../cdp-input-enabled", () => ({ isCdpInputEnabled: vi.fn(async () => false) }));
vi.mock("../cdp-input-onboarding", () => ({ requestCdpInputConsent: vi.fn() }));
vi.mock("../local-file-request", () => ({ requestLocalFileFromPanel: vi.fn() }));
vi.mock("./tools/files", () => ({
  buildReadLocalFileTool: vi.fn(() => ({ name: "read_local_file", description: "", parameters: {}, execute: vi.fn() })),
  buildRequestLocalFileTool: vi.fn(() => ({ name: "request_local_file", description: "", parameters: {}, execute: vi.fn() })),
  buildOutputFileTool: vi.fn(() => ({ name: "output_file", description: "", parameters: {}, execute: vi.fn() })),
}));
vi.mock("./tools/scratchpad", () => ({ buildScratchpadTools: vi.fn(() => []) }));
vi.mock("../scratchpad/service", () => ({
  saveRecords: vi.fn(),
  updateNotes: vi.fn(),
  readScratchpadRecords: vi.fn(),
  clearScratchpadCollections: vi.fn(),
  getOverview: vi.fn(),
}));
vi.mock("../scratchpad/sql-bridge", () => ({ queryScratchpad: vi.fn() }));
vi.mock("../skills", () => ({ getEnabledSkillPackages: vi.fn(async () => []) }));
vi.mock("../pdf/detect", () => ({ isFilePdfUrl: vi.fn(() => false) }));
vi.mock("../../background/cdp-session", () => ({
  acquireCdpSession: vi.fn(async () => null),
}));
vi.mock("../sessions/storage", () => ({
  getSessionMeta: vi.fn(async () => null),
  setSessionMeta: vi.fn(async () => {}),
  getSessionAgent: vi.fn(async () => null),
  setSessionAgent: vi.fn(async () => {}),
}));
vi.mock("../sessions/pin-state", () => ({
  addPinToMeta: vi.fn(async () => {}),
  removePinFromMeta: vi.fn(async () => {}),
}));
vi.mock("../sessions/pending-instructions", () => ({
  drainPending: vi.fn(async () => []),
}));
vi.mock("./loop-drain", () => ({ buildMidTaskUserMessage: vi.fn(() => null) }));
vi.mock("@/background/instruction-broadcast", () => ({
  broadcastInstructionState: vi.fn(),
}));
vi.mock("./synthesize-agent-turn", () => ({
  synthesizeAgentTurnText: vi.fn(() => null),
}));
vi.mock("./wait-for-url-settle", () => ({
  waitForUrlSettle: vi.fn(async () => ({ url: "https://example.com", settled: true })),
}));
vi.mock("./assistant-blocks", () => ({
  assembleAssistantBlocks: vi.fn(() => []),
}));
vi.mock("./text-tool-invocation", () => ({
  parseTextToolInvocations: vi.fn(() => []),
}));

// Mock streamChat to return a single text event then done (simulates plain-text reply)
vi.mock("../model-router", () => ({
  streamChat: vi.fn(async function* () {
    yield { type: "text-delta", text: "Hello world" };
    yield { type: "done", stopReason: "end_turn", usage: null };
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("AgentEmit type (ADR 0002)", () => {
  it("AgentEmit is exported and accepts PortMessageToPanel-shaped objects", () => {
    // Type-level test: if AgentEmit doesn't exist or isn't assignable, TS
    // compilation will fail at build time. At runtime we just verify the
    // import is defined.
    const emit: AgentEmit = vi.fn();
    expect(typeof emit).toBe("function");
  });
});

describe("runAgentLoop emit sink (ADR 0002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls emit with chat-done on a pure-text reply (not port.postMessage)", async () => {
    const { runAgentLoop } = await import("./loop");

    const emitted: unknown[] = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg); };

    const controller = new AbortController();
    await runAgentLoop({
      emit,
      task: "Say hello",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        vision: false,
      },
      signal: controller.signal,
      sessionId: "test-session-1",
      // Provide a pinned tab so the loop skips chrome.tabs.query
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
    });

    // Must have emitted at least one message
    expect(emitted.length).toBeGreaterThan(0);

    // Must include a chat-done message
    const chatDone = emitted.find((m: unknown) => (m as { type: string }).type === "chat-done");
    expect(chatDone).toBeDefined();
    expect((chatDone as { sessionId: string }).sessionId).toBe("test-session-1");
  });

  it("calls emit with chat-chunk for streamed text", async () => {
    const { runAgentLoop } = await import("./loop");

    const emitted: unknown[] = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg); };

    const controller = new AbortController();
    await runAgentLoop({
      emit,
      task: "Say hello",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        vision: false,
      },
      signal: controller.signal,
      sessionId: "test-session-1",
      // Provide a pinned tab so the loop skips chrome.tabs.query
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
    });

    const chatChunks = emitted.filter((m: unknown) => (m as { type: string }).type === "chat-chunk");
    expect(chatChunks.length).toBeGreaterThan(0);
    expect((chatChunks[0] as { text: string }).text).toBe("Hello world");
  });

  it("does NOT use a chrome.runtime.Port (no port field in AgentLoopContext)", async () => {
    // If the context required a `port`, this call (without one) would fail
    // the TypeScript type-check at build time. At runtime we just confirm
    // the loop accepts ctx without a port.
    const { runAgentLoop } = await import("./loop");

    const emit: AgentEmit = vi.fn();
    const controller = new AbortController();

    // This should NOT throw due to missing port
    await expect(
      runAgentLoop({
        emit,
        task: "test task",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o",
          apiKey: "sk-test",
          vision: false,
        },
        signal: controller.signal,
        sessionId: "test-session-2",
        // Provide a pinned tab so the loop skips chrome.tabs.query
        pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
        initialFocusTabId: 1,
      })
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 5.3 — maxSteps hard cap for scheduled runs
// ---------------------------------------------------------------------------
describe("runAgentLoop — maxSteps hard cap (Task 5.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maxSteps=0 → immediately terminates with agent-done-task success:false before any LLM call", async () => {
    // maxSteps=0 means stepIndex=1 (startStepIndex) > 0 fires immediately at
    // the first iteration, before streamChat is ever called.
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");

    const emitted: unknown[] = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg); };

    const controller = new AbortController();
    await runAgentLoop({
      emit,
      task: "test task with step cap",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        vision: false,
      },
      signal: controller.signal,
      sessionId: "test-maxsteps-0",
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
      maxSteps: 0,
    });

    // Must emit agent-done-task with success=false
    const doneMsgs = emitted.filter(
      (m) => (m as { type: string }).type === "agent-done-task",
    );
    expect(doneMsgs.length).toBe(1);
    expect((doneMsgs[0] as { success: boolean }).success).toBe(false);

    // streamChat must NOT have been called (terminated before the LLM call)
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("no maxSteps → loop reaches LLM (streamChat called), normal completion", async () => {
    // Without maxSteps, the loop runs normally until the LLM returns a
    // plain-text reply (→ chat-done). Verifies that absent maxSteps does not
    // change existing behavior.
    const { runAgentLoop } = await import("./loop");
    const { streamChat } = await import("../model-router");

    const emitted: unknown[] = [];
    const emit: AgentEmit = (msg) => { emitted.push(msg); };

    const controller = new AbortController();
    await runAgentLoop({
      emit,
      task: "task without cap",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        vision: false,
      },
      signal: controller.signal,
      sessionId: "test-maxsteps-none",
      pinnedTabs: [{ tabId: 1, origin: "https://example.com" }],
      initialFocusTabId: 1,
      // maxSteps intentionally absent
    });

    // streamChat must have been called (loop reached LLM)
    expect(streamChat).toHaveBeenCalled();

    // Should end with chat-done (pure-text mock path), not agent-done-task(failed)
    const chatDone = emitted.find((m) => (m as { type: string }).type === "chat-done");
    expect(chatDone).toBeDefined();
  });
});
