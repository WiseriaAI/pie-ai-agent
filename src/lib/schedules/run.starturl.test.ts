// src/lib/schedules/run.starturl.test.ts
//
// TDD tests for Task 6: startUrl background tab + restricted URL guard +
// orphan tab cleanup wired into runSchedule.

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import type { ScheduleRecord } from "./types";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentLoopContext } from "@/lib/agent/loop";
import type { DecryptedInstance } from "@/lib/instances";
import type { RunDeps } from "./run";

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  const defaults: ScheduleRecord = {
    id: overrides.id,
    title: "Test schedule",
    prompt: "say hi",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1000,
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
  };
  return { ...defaults, ...overrides };
}

const FAKE_CFG: ModelConfig = {
  provider: "anthropic",
  model: "claude-3-5-haiku-20241022",
  apiKey: "test-key",
  providerName: "Anthropic",
};

const FAKE_MODEL = "claude-3-5-haiku-20241022";

const FAKE_INSTANCE: DecryptedInstance = {
  id: "inst_1",
  provider: "anthropic",
  nickname: "Test",
  apiKey: "test-key",
  createdAt: 1000,
};

/** Loop that emits a successful agent-done-task terminal signal. */
function doneLoop(opts: { success: boolean; summary: string } = { success: true, summary: "done" }) {
  return vi.fn(async (ctx: AgentLoopContext) => {
    ctx.emit({
      type: "agent-done-task",
      success: opts.success,
      summary: opts.summary,
      stepCount: 1,
      sessionId: ctx.sessionId,
    });
  });
}

/** Build deps with model-resolution chain succeeding. */
function okDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    runAgentLoop: doneLoop(),
    getInstance: vi.fn(async () => FAKE_INSTANCE),
    firstModelForProvider: vi.fn(async () => FAKE_MODEL),
    resolveModelConfig: vi.fn(async () => FAKE_CFG),
    ...overrides,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

// Helper to install a chrome.tabs mock on globalThis for tests that need it.
// Using `as any` so partial mock objects don't need to satisfy the full Chrome
// Tab type — tests only need duck-typed { id } from chrome.tabs.create.
function mockChromeTabs(overrides: {
  create?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
} = {}) {
  const chromeMock = {
    tabs: {
      create: overrides.create ?? vi.fn(async () => ({ id: 99 })),
      remove: overrides.remove ?? vi.fn(async () => undefined),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).chrome = chromeMock;
  return chromeMock.tabs;
}

beforeEach(async () => {
  await _resetForTests();
  // Install default mock; individual tests can call mockChromeTabs() to override.
  mockChromeTabs();
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).chrome;
});

// ── Tests: has startUrl ───────────────────────────────────────────────────────

describe("runSchedule — startUrl: background tab lifecycle", () => {
  it("有 startUrl → 以 active:false 打开 tab、记录 ownedTabId、运行完后关闭 tab", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn(async () => ({ id: 7 }));
    const removeMock = vi.fn(async () => undefined);
    mockChromeTabs({ create: createMock, remove: removeMock });

    await putSchedule(makeSched({ id: "sched_url", startUrl: "https://example.com" }));

    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "agent-done-task", success: true, summary: "ok", stepCount: 1, sessionId: ctx.sessionId });
    });

    await runSchedule("sched_url", okDeps({ runAgentLoop: fakeLoop }));

    // tab.create must have been called with active:false
    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledWith({ url: "https://example.com", active: false });

    // ownedTabId must have been persisted to the run record
    const s = await getSchedule("sched_url");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.ownedTabId).toBe(7);

    // remove must have been called with the same tabId
    expect(removeMock).toHaveBeenCalledOnce();
    expect(removeMock).toHaveBeenCalledWith(7);

    // loop must have run (the task did execute)
    expect(fakeLoop).toHaveBeenCalledOnce();
  });

  it("有 startUrl → loop ctx.pinnedTabs 包含该 tab (tabId + origin)", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    mockChromeTabs({ create: vi.fn(async () => ({ id: 42 })) });

    await putSchedule(makeSched({ id: "sched_pin", startUrl: "https://news.ycombinator.com/news" }));

    let capturedCtx: AgentLoopContext | undefined;
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      capturedCtx = ctx;
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_pin", okDeps({ runAgentLoop: fakeLoop }));

    const pins = capturedCtx!.pinnedTabs ?? [];
    expect(pins).toHaveLength(1);
    expect(pins[0]!.tabId).toBe(42);
    expect(pins[0]!.origin).toBe("https://news.ycombinator.com");
  });

  it("run 异常（loop 抛出）→ finally 仍关闭 ownedTabId", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    const removeMock = vi.fn(async () => undefined);
    mockChromeTabs({ create: vi.fn(async () => ({ id: 55 })), remove: removeMock });

    await putSchedule(makeSched({ id: "sched_crash", startUrl: "https://example.com" }));

    const boomLoop = vi.fn(async () => {
      throw new Error("simulated crash");
    });

    await runSchedule("sched_crash", okDeps({ runAgentLoop: boomLoop }));

    // Even though the loop threw, remove must still have been called
    expect(removeMock).toHaveBeenCalledOnce();
    expect(removeMock).toHaveBeenCalledWith(55);
  });

  it("tab.remove が例外を投げても run は正常終了（容错）", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    mockChromeTabs({
      create: vi.fn(async () => ({ id: 8 })),
      // Simulate tab already closed when we try to remove it
      remove: vi.fn(async () => { throw new Error("No tab with id: 8"); }),
    });

    await putSchedule(makeSched({ id: "sched_tabgone", startUrl: "https://example.com" }));

    await runSchedule("sched_tabgone", okDeps());

    // runSchedule must not throw; the run must be recorded as success
    const s = await getSchedule("sched_tabgone");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("success");
  });

  it("chrome.tabs.create が id なしの tab を返す → run.failed、loop 未调用、remove 未调用", async () => {
    // chrome.tabs.create's id is `number | undefined`. A missing id must NOT be
    // propagated (would poison pinnedTabs / ownedTabId / chrome.tabs.remove);
    // openScheduleTab throws and the run goes through the normal failed path.
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const removeMock = vi.fn(async () => undefined);
    mockChromeTabs({ create: vi.fn(async () => ({})), remove: removeMock });

    await putSchedule(makeSched({ id: "sched_noid", startUrl: "https://example.com" }));

    const fakeLoop = vi.fn();
    await runSchedule("sched_noid", okDeps({ runAgentLoop: fakeLoop }));

    // Loop never ran (tab open failed before it), and we never tried to remove
    // an undefined tab id.
    expect(fakeLoop).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();

    const s = await getSchedule("sched_noid");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.ownedTabId).toBeUndefined();
  });
});

// ── Tests: restricted startUrl ────────────────────────────────────────────────

describe("runSchedule — startUrl: restricted URL guard", () => {
  it("restricted startUrl (chrome://) → run.failed、不开 tab、loop 未调用", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn();
    mockChromeTabs({ create: createMock });

    await putSchedule(makeSched({ id: "sched_chrome", startUrl: "chrome://settings" }));

    const fakeLoop = vi.fn();
    await runSchedule("sched_chrome", okDeps({ runAgentLoop: fakeLoop }));

    expect(createMock).not.toHaveBeenCalled();
    expect(fakeLoop).not.toHaveBeenCalled();

    const s = await getSchedule("sched_chrome");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBeTruthy();
    // ownedTabId should not be set (no tab was opened)
    expect(run!.ownedTabId).toBeUndefined();
  });

  it("restricted startUrl (about:blank) → run.failed、loop 未调用", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn();
    mockChromeTabs({ create: createMock });

    await putSchedule(makeSched({ id: "sched_about", startUrl: "about:blank" }));

    const fakeLoop = vi.fn();
    await runSchedule("sched_about", okDeps({ runAgentLoop: fakeLoop }));

    expect(createMock).not.toHaveBeenCalled();
    expect(fakeLoop).not.toHaveBeenCalled();

    const s = await getSchedule("sched_about");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
  });

  it("restricted startUrl → outcome がカウントされる（consecutiveFailures +1）", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    mockChromeTabs();

    await putSchedule(makeSched({ id: "sched_cf", startUrl: "chrome://newtab", consecutiveFailures: 1 }));

    await runSchedule("sched_cf", okDeps());

    const s = await getSchedule("sched_cf");
    expect(s!.consecutiveFailures).toBe(2);
  });

  it("chrome-extension:// URL も restricted として拒否される", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn();
    mockChromeTabs({ create: createMock });

    await putSchedule(makeSched({ id: "sched_ext", startUrl: "chrome-extension://abc/options.html" }));

    const fakeLoop = vi.fn();
    await runSchedule("sched_ext", okDeps({ runAgentLoop: fakeLoop }));

    expect(createMock).not.toHaveBeenCalled();
    expect(fakeLoop).not.toHaveBeenCalled();
    const s = await getSchedule("sched_ext");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
  });

  // spec §8.2 — the Chrome Web Store is https:// (passes the scheme-only
  // isRestrictedUrl) but Chrome forbids script injection there, so the
  // schedule guard (isRestrictedScheduleUrl) must treat both Web Store hosts
  // as restricted: fail the run, never open a tab, never run the loop.
  it("Web Store (chromewebstore.google.com) → run.failed、不开 tab、loop 未调用", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn();
    mockChromeTabs({ create: createMock });

    await putSchedule(
      makeSched({ id: "sched_ws_new", startUrl: "https://chromewebstore.google.com/detail/foo/abc" }),
    );

    const fakeLoop = vi.fn();
    await runSchedule("sched_ws_new", okDeps({ runAgentLoop: fakeLoop }));

    expect(createMock).not.toHaveBeenCalled();
    expect(fakeLoop).not.toHaveBeenCalled();
    const s = await getSchedule("sched_ws_new");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.ownedTabId).toBeUndefined();
  });

  it("Web Store (旧 chrome.google.com/webstore) → run.failed、不开 tab、loop 未调用", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn();
    mockChromeTabs({ create: createMock });

    await putSchedule(
      makeSched({ id: "sched_ws_old", startUrl: "https://chrome.google.com/webstore/detail/bar" }),
    );

    const fakeLoop = vi.fn();
    await runSchedule("sched_ws_old", okDeps({ runAgentLoop: fakeLoop }));

    expect(createMock).not.toHaveBeenCalled();
    expect(fakeLoop).not.toHaveBeenCalled();
    const s = await getSchedule("sched_ws_old");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.ownedTabId).toBeUndefined();
  });
});

// ── Tests: no startUrl ────────────────────────────────────────────────────────

describe("runSchedule — no startUrl: tab not opened", () => {
  it("startUrl なし → chrome.tabs.create 未呼び出し（従来通り）", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    const createMock = vi.fn();
    mockChromeTabs({ create: createMock });

    await putSchedule(makeSched({ id: "sched_nourl" }));

    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_nourl", okDeps({ runAgentLoop: fakeLoop }));

    expect(createMock).not.toHaveBeenCalled();
    expect(fakeLoop).toHaveBeenCalledOnce();
  });

  it("startUrl なし → loop の pinnedTabs は空配列", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    mockChromeTabs();

    await putSchedule(makeSched({ id: "sched_nopins" }));

    let capturedCtx: AgentLoopContext | undefined;
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      capturedCtx = ctx;
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_nopins", okDeps({ runAgentLoop: fakeLoop }));

    expect(capturedCtx!.pinnedTabs).toEqual([]);
  });
});
