// src/lib/schedules/run.test.ts
//
// TDD tests for the headless runSchedule executor (Task 3).
// getInstance / firstModelForProvider / resolveModelConfig / runAgentLoop are
// injected deps so the loop stays testable without a real Chrome extension or
// LLM. Model resolution follows ADR 0001: the schedule binds to an instance and
// the run uses that instance's current model (firstModelForProvider).
//
// Success/failed is decided by the loop's TERMINAL SIGNAL (agent-done-task /
// chat-error), NOT by "the promise resolved" — runAgentLoop returns normally on
// soft failures (agent `fail`, LLM error). Summary comes from the canonical
// agent-done-task.summary (pure-text replies fall back to chat-chunk text).

import { describe, expect, it, beforeEach, vi } from "vitest";
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

/** A fakeLoop that emits the canonical `agent-done-task` terminal signal,
 *  mirroring the real loop's emitDone (tool-using / agent-done path). */
function doneLoop(opts: { success: boolean; summary: string }) {
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

/**
 * Build a RunDeps set whose model-resolution chain succeeds:
 * getInstance → FAKE_INSTANCE, firstModelForProvider → FAKE_MODEL,
 * resolveModelConfig → FAKE_CFG. Default loop emits a successful
 * agent-done-task. Overrides let individual tests swap any leg.
 */
function okDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    runAgentLoop: doneLoop({ success: true, summary: "done" }),
    getInstance: vi.fn(async () => FAKE_INSTANCE),
    firstModelForProvider: vi.fn(async () => FAKE_MODEL),
    resolveModelConfig: vi.fn(async () => FAKE_CFG),
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await _resetForTests();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runSchedule — success path", () => {
  it("新建 Run+session，agent-done-task success → run.success + summary(来自 agent-done-task) + appendRun", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_a", prompt: "say hi", instanceId: "inst_1" }));

    // C2 — summary must come from agent-done-task.summary (the synthesized
    // canonical line), NOT from raw chat-chunk deltas. Emit a thin chunk plus a
    // distinct done-summary; the run summary must reflect the done-summary.
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-chunk", text: "thin chunk", sessionId: ctx.sessionId });
      ctx.emit({
        type: "agent-done-task",
        success: true,
        summary: "canonical synthesized summary",
        stepCount: 3,
        sessionId: ctx.sessionId,
      });
    });
    const resolveModelConfig = vi.fn(async () => FAKE_CFG);

    await runSchedule(
      "sched_a",
      okDeps({ runAgentLoop: fakeLoop, resolveModelConfig }),
    );

    const s = await getSchedule("sched_a");
    expect(s!.runIds.length).toBe(1);

    const run = await getRun(s!.runIds[0]!);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("success");
    expect(run!.sessionId).toBeTruthy();
    expect(run!.summary).toBe("canonical synthesized summary");
    expect(run!.summary).not.toContain("thin chunk");
    expect(run!.endedAt).toBeGreaterThan(0);

    // ADR 0001 — resolveModelConfig must receive the instance's current model
    // (firstModelForProvider's non-empty result), NOT an empty string sentinel.
    expect(resolveModelConfig).toHaveBeenCalledWith("inst_1", FAKE_MODEL);
    expect(resolveModelConfig).not.toHaveBeenCalledWith("inst_1", "");
  });

  it("agent-done-task.summary が 200 文字以内にトリミングされる", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_trim", prompt: "verbosity test" }));

    const longSummary = "x".repeat(500);

    await runSchedule(
      "sched_trim",
      okDeps({ runAgentLoop: doneLoop({ success: true, summary: longSummary }) }),
    );

    const s = await getSchedule("sched_trim");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.summary!.length).toBeLessThanOrEqual(200);
  });

  it("pure-text reply (chat-done のみ、agent-done-task なし) → success + summary は chat-chunk から", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_puretext", prompt: "chat only" }));

    // Pure-text terminal path: loop emits chat-chunk text then chat-done, never
    // agent-done-task. Summary must fall back to the accumulated chunk text.
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-chunk", text: "plain answer", sessionId: ctx.sessionId });
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_puretext", okDeps({ runAgentLoop: fakeLoop }));

    const s = await getSchedule("sched_puretext");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("success");
    expect(run!.summary).toBe("plain answer");
  });

  it("runAgentLoop が受け取った sessionId は新規 UUID", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_sid" }));

    let capturedSessionId: string | undefined;
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      capturedSessionId = ctx.sessionId;
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_sid", okDeps({ runAgentLoop: fakeLoop }));

    expect(capturedSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("session meta が origin=schedule + scheduleId + recordId を持つ", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { getSessionMeta } = await import("@/lib/sessions/storage");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_meta" }));

    let capturedSessionId: string | undefined;
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      capturedSessionId = ctx.sessionId;
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_meta", okDeps({ runAgentLoop: fakeLoop }));

    expect(capturedSessionId).toBeTruthy();
    const meta = await getSessionMeta(capturedSessionId!);
    expect(meta).not.toBeNull();
    expect(meta!.origin).toBe("schedule");
    expect(meta!.scheduleId).toBe("sched_meta");

    const sched = await getSchedule("sched_meta");
    const run = await getRun(sched!.runIds[0]!);
    expect(meta!.recordId).toBe(run!.recordId);
  });
});

describe("runSchedule — onStepSnapshot uses canonical merge (tombstone carry-over)", () => {
  // I1/I2 — onStepSnapshot must go through mergeSessionAgentSnapshot, not a
  // hand-rolled field pick. A real loop fires a live per-step snapshot then a
  // done tombstone (which carries lastTaskSynth + contextUsage). The persisted
  // agent state must reflect the tombstone reset AND keep those carry fields.
  it("live snapshot → tombstone：persisted agent state は reset され lastTaskSynth/contextUsage を保持", async () => {
    const { putSchedule } = await import("./store");
    const { getSessionAgent } = await import("@/lib/sessions/storage");
    const { buildSessionAgentTombstone } = await import("@/lib/agent/loop");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_tomb", prompt: "two-step" }));

    let capturedSessionId: string | undefined;
    const usage = {
      totalInputTokens: 100,
      totalOutputTokens: 50,
      lastInputTokens: 40,
      lastOutputTokens: 20,
    };

    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      capturedSessionId = ctx.sessionId;
      // 1) live step snapshot — non-empty history, stepIndex 1.
      await ctx.onStepSnapshot!({
        agentMessages: [{ role: "user", content: "two-step" }],
        pendingInstructions: [],
        stepIndex: 1,
        hasImageContent: false,
      });
      // 2) done tombstone — carries synth + usage (buildSessionAgentTombstone).
      await ctx.onStepSnapshot!(buildSessionAgentTombstone("synthesized recap", usage));
      ctx.emit({
        type: "agent-done-task",
        success: true,
        summary: "synthesized recap",
        stepCount: 1,
        sessionId: ctx.sessionId,
      });
    });

    await runSchedule("sched_tomb", okDeps({ runAgentLoop: fakeLoop }));

    expect(capturedSessionId).toBeTruthy();
    const agent = await getSessionAgent(capturedSessionId!);
    expect(agent).not.toBeNull();
    // Tombstone reset semantics applied:
    expect(agent!.stepIndex).toBe(0);
    expect(agent!.agentMessages).toEqual([]);
    // Carry fields preserved (this is what makes a headless run browsable):
    expect(agent!.lastTaskSynth).toBe("synthesized recap");
    expect(agent!.contextUsage).toEqual(usage);
  });
});

describe("runSchedule — failure path", () => {
  // C1 — runAgentLoop does NOT throw on a soft failure. The agent calling the
  // `fail` tool (or an LLM/network error) ends as emitDone(success:false) +
  // normal return. The run MUST be recorded as failed, not success.
  it("agent-done-task success:false (agent fail) → run.failed（promise は resolve する）", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_agentfail", prompt: "do impossible" }));

    // Resolves normally — no throw — exactly like the real loop on agent fail.
    await runSchedule(
      "sched_agentfail",
      okDeps({
        runAgentLoop: doneLoop({ success: false, summary: "agent gave up: task impossible" }),
      }),
    );

    const s = await getSchedule("sched_agentfail");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("agent gave up");
    expect(run!.summary).toContain("agent gave up");
    expect(run!.endedAt).toBeGreaterThan(0);
  });

  // C1 — an LLM/stream error path emits chat-error (the real loop also emits an
  // agent-done-task right after, but a bare chat-error must still mean failed).
  it("chat-error のみ → run.failed + error にエラーテキスト", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_chaterr", prompt: "trigger api error" }));

    const errLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-error", error: "upstream 500", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_chaterr", okDeps({ runAgentLoop: errLoop }));

    const s = await getSchedule("sched_chaterr");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("upstream 500");
    expect(run!.endedAt).toBeGreaterThan(0);
  });

  it("runAgentLoop が例外を投げる → run.failed + error フィールドに message（バックストップ）", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_boom", prompt: "explode" }));

    const boomLoop = vi.fn(async (_ctx: AgentLoopContext) => {
      throw new Error("simulated agent crash");
    });

    await runSchedule("sched_boom", okDeps({ runAgentLoop: boomLoop }));

    const s = await getSchedule("sched_boom");
    expect(s!.runIds.length).toBe(1);

    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("simulated agent crash");
    expect(run!.endedAt).toBeGreaterThan(0);
  });
});

describe("runSchedule — model resolution failures (run.failed, loop not called)", () => {
  it("instance が存在しない (getInstance→null) → loop 未呼び出し + run.failed + session を作らない", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { listSessionIndex } = await import("@/lib/sessions/storage");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_no_inst", instanceId: "inst_deleted" }));

    const fakeLoop = vi.fn();
    // firstModelForProvider / resolveModelConfig must NOT be reached once the
    // instance is gone.
    const firstModelForProvider = vi.fn(async () => FAKE_MODEL);
    const resolveModelConfig = vi.fn(async () => FAKE_CFG);

    await runSchedule(
      "sched_no_inst",
      okDeps({
        runAgentLoop: fakeLoop,
        getInstance: async () => null,
        firstModelForProvider,
        resolveModelConfig,
      }),
    );

    expect(fakeLoop).not.toHaveBeenCalled();
    expect(firstModelForProvider).not.toHaveBeenCalled();
    expect(resolveModelConfig).not.toHaveBeenCalled();

    const s = await getSchedule("sched_no_inst");
    expect(s!.runIds.length).toBe(1);
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBeTruthy();
    expect(run!.endedAt).toBeGreaterThan(0);

    // M2 — model resolution happens BEFORE session creation, so a model failure
    // leaves NO orphan session and the failed run has no sessionId.
    expect(run!.sessionId).toBeUndefined();
    expect(await listSessionIndex()).toHaveLength(0);
  });

  it("firstModelForProvider→null (provider にモデルなし) → loop 未呼び出し + run.failed", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_no_model" }));

    const fakeLoop = vi.fn();
    // Empty-string model must never reach resolveModelConfig: when no model
    // resolves, we short-circuit before calling it at all.
    const resolveModelConfig = vi.fn(async () => FAKE_CFG);

    await runSchedule(
      "sched_no_model",
      okDeps({
        runAgentLoop: fakeLoop,
        firstModelForProvider: async () => null,
        resolveModelConfig,
      }),
    );

    expect(fakeLoop).not.toHaveBeenCalled();
    expect(resolveModelConfig).not.toHaveBeenCalled();

    const s = await getSchedule("sched_no_model");
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBeTruthy();
    expect(run!.endedAt).toBeGreaterThan(0);
  });

  it("resolveModelConfig→null (config 解決失敗) → loop 未呼び出し + run.failed", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_null_cfg" }));

    const fakeLoop = vi.fn();

    await runSchedule(
      "sched_null_cfg",
      okDeps({
        runAgentLoop: fakeLoop,
        resolveModelConfig: async () => null,
      }),
    );

    expect(fakeLoop).not.toHaveBeenCalled();

    const s = await getSchedule("sched_null_cfg");
    expect(s!.runIds.length).toBe(1);
    const run = await getRun(s!.runIds[0]!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBeTruthy();
    expect(run!.endedAt).toBeGreaterThan(0);
  });
});

describe("runSchedule — schedule not found", () => {
  it("存在しないスケジュール ID → 例外なく早期リターン", async () => {
    const { runSchedule } = await import("./run");

    const fakeLoop = vi.fn();
    // Should resolve without throwing
    await expect(
      runSchedule("sched_nonexistent", okDeps({ runAgentLoop: fakeLoop })),
    ).resolves.not.toThrow();

    expect(fakeLoop).not.toHaveBeenCalled();
  });
});

// ── Task 5.1+5.2: applyOutcome wired into runSchedule ───────────────────────

describe("runSchedule — applyOutcome: schedule counters updated after run", () => {
  it("success → runCount+1, consecutiveFailures=0 after successful agent-done-task", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_cnt_ok", runCount: 2, consecutiveFailures: 2 }));

    await runSchedule("sched_cnt_ok", okDeps({ runAgentLoop: doneLoop({ success: true, summary: "ok" }) }));

    const s = await getSchedule("sched_cnt_ok");
    expect(s!.runCount).toBe(3);
    expect(s!.consecutiveFailures).toBe(0);
    expect(s!.status).toBe("active");
  });

  it("failed → runCount+1, consecutiveFailures+1 after agent-done-task success:false", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_cnt_fail", runCount: 1, consecutiveFailures: 0 }));

    await runSchedule("sched_cnt_fail", okDeps({ runAgentLoop: doneLoop({ success: false, summary: "fail" }) }));

    const s = await getSchedule("sched_cnt_fail");
    expect(s!.runCount).toBe(2);
    expect(s!.consecutiveFailures).toBe(1);
    expect(s!.status).toBe("active");
  });

  it("3 consecutive failures → status=paused (FAILURE_PAUSE_THRESHOLD=3)", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    // Already at 2 failures — one more pauses
    await putSchedule(makeSched({ id: "sched_pause", runCount: 2, consecutiveFailures: 2 }));

    await runSchedule("sched_pause", okDeps({ runAgentLoop: doneLoop({ success: false, summary: "fail" }) }));

    const s = await getSchedule("sched_pause");
    expect(s!.consecutiveFailures).toBe(3);
    expect(s!.status).toBe("paused");
  });

  it("success after previous failures → consecutiveFailures reset to 0", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_reset_cf", runCount: 5, consecutiveFailures: 2 }));

    await runSchedule("sched_reset_cf", okDeps({ runAgentLoop: doneLoop({ success: true, summary: "recovered" }) }));

    const s = await getSchedule("sched_reset_cf");
    expect(s!.consecutiveFailures).toBe(0);
    expect(s!.status).toBe("active");
  });

  it("runCount reaches maxRuns → status=completed", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({
      id: "sched_capped",
      runCount: 4,
      consecutiveFailures: 0,
      spec: { intervalMinutes: 60, maxRuns: 5 },
    }));

    await runSchedule("sched_capped", okDeps({ runAgentLoop: doneLoop({ success: true, summary: "done" }) }));

    const s = await getSchedule("sched_capped");
    expect(s!.runCount).toBe(5);
    expect(s!.status).toBe("completed");
  });

  it("instance unavailable (early-fail) → runCount+1, consecutiveFailures+1, may pause", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    // At cf=2, one more failure from a bad instance should push cf to 3 → paused
    await putSchedule(makeSched({ id: "sched_instfail", runCount: 2, consecutiveFailures: 2 }));

    await runSchedule("sched_instfail", okDeps({
      getInstance: async () => null, // instance unavailable — early fail path
    }));

    const s = await getSchedule("sched_instfail");
    expect(s!.consecutiveFailures).toBe(3);
    expect(s!.status).toBe("paused");
  });
});

// ── Task 5.2: skip-if-running ─────────────────────────────────────────────────

describe("runSchedule — skip-if-running", () => {
  it("已有 running 的 run → appendRun 一条 skipped run 且不调用 loop", async () => {
    const { putSchedule, getSchedule, appendRun, getRun } = await import("./store");
    const { newRunId } = await import("./types");
    const { runSchedule } = await import("./run");

    // Seed a running run first
    await putSchedule(makeSched({ id: "sched_skip", runCount: 0, consecutiveFailures: 0 }));
    const existingRunId = newRunId();
    await appendRun("sched_skip", {
      recordId: existingRunId,
      scheduleId: "sched_skip",
      runIndex: 1,
      startedAt: Date.now(),
      status: "running",
    });

    const fakeLoop = vi.fn();
    await runSchedule("sched_skip", okDeps({ runAgentLoop: fakeLoop }));

    // Loop must NOT have been called
    expect(fakeLoop).not.toHaveBeenCalled();

    // A skipped run record must have been appended
    const s = await getSchedule("sched_skip");
    // runIds: original running run + the new skipped run
    expect(s!.runIds.length).toBe(2);

    // The second run (just appended) must be "skipped" with no sessionId
    const skippedRun = await getRun(s!.runIds[1]!);
    expect(skippedRun!.status).toBe("skipped");
    expect(skippedRun!.sessionId).toBeUndefined();

    // schedule counters must NOT change (skipped doesn't count)
    expect(s!.runCount).toBe(0);
    expect(s!.consecutiveFailures).toBe(0);
  });

  it("无 running run → 正常执行（调用 loop）", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_noskip" }));

    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
    });

    await runSchedule("sched_noskip", okDeps({ runAgentLoop: fakeLoop }));

    expect(fakeLoop).toHaveBeenCalledOnce();
  });
});

// ── Run-history viewability: meta.messages persisted from the emit stream ─────

describe("runSchedule — persists a panel-renderable transcript to meta.messages", () => {
  it("成功 run → meta.messages に user/assistant/agent-step/agent-summary が並ぶ + title 由来 prompt", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { getSessionMeta } = await import("@/lib/sessions/storage");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_tx", prompt: "find the cheapest flight" }));

    // A realistic emit script: assistant text → a tool step → terminal summary.
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-chunk", text: "Searching now", sessionId: ctx.sessionId });
      ctx.emit({
        type: "agent-step",
        stepIndex: 0,
        tool: "navigate",
        args: { url: "https://example.com" },
        status: "ok",
        observation: "loaded",
        sessionId: ctx.sessionId,
      });
      ctx.emit({
        type: "agent-done-task",
        success: true,
        summary: "Found a $120 flight",
        stepCount: 1,
        sessionId: ctx.sessionId,
      });
    });

    await runSchedule("sched_tx", okDeps({ runAgentLoop: fakeLoop }));

    const s = await getSchedule("sched_tx");
    const run = await getRun(s!.runIds[0]!);
    const meta = await getSessionMeta(run!.sessionId!);
    expect(meta).not.toBeNull();
    expect((meta!.messages ?? []).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "agent-step",
      "agent-summary",
    ]);
    // First message is the prompt; title derived from it (foreground parity).
    expect(meta!.messages![0]).toEqual({ role: "user", content: "find the cheapest flight" });
    expect(meta!.title).toBe("find the cheapest flight");
  });

  it("loop が例外を投げても、それまでに溜まった transcript は meta.messages に残る", async () => {
    const { putSchedule, getSchedule, getRun } = await import("./store");
    const { getSessionMeta } = await import("@/lib/sessions/storage");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_tx_boom", prompt: "do a thing" }));

    const boomLoop = vi.fn(async (ctx: AgentLoopContext) => {
      ctx.emit({ type: "chat-chunk", text: "partial work", sessionId: ctx.sessionId });
      throw new Error("kaboom");
    });

    await runSchedule("sched_tx_boom", okDeps({ runAgentLoop: boomLoop }));

    const s = await getSchedule("sched_tx_boom");
    const run = await getRun(s!.runIds[0]!);
    const meta = await getSessionMeta(run!.sessionId!);
    // The user prompt + the partial assistant text survived the crash.
    expect((meta!.messages ?? []).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(meta!.messages![1]).toMatchObject({ role: "assistant", content: "partial work" });
  });
});

// ── Task 5.2: maxRunMs budget ─────────────────────────────────────────────────

describe("runSchedule — maxRunMs timeout budget", () => {
  it("maxRunMs 超时 → abort signal 被触发 (abort.signal.aborted = true)", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    // Use a very short maxRunMs so the timeout fires in real time
    await putSchedule(makeSched({ id: "sched_timeout", maxRunMs: 50 }));

    let capturedSignal: AbortSignal | undefined;
    // A loop that captures the signal then resolves immediately (simulates
    // a task that defers to the signal but doesn't actually block)
    const fakeLoop = vi.fn(async (ctx: AgentLoopContext) => {
      capturedSignal = ctx.signal;
      // Wait for abort or a tick — whichever comes first
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) { resolve(); return; }
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        // Safety: also resolve after 200ms so the test doesn't hang
        setTimeout(resolve, 200);
      });
      // Emit failed outcome as the real loop does on abort
      ctx.emit({
        type: "agent-done-task",
        success: false,
        summary: "aborted by timeout",
        stepCount: 1,
        sessionId: ctx.sessionId,
      });
    });

    await runSchedule("sched_timeout", okDeps({ runAgentLoop: fakeLoop }));

    // The signal should have been aborted by the maxRunMs timer
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("run 在 maxRunMs 之前正常完成 → budget timer 被 finally 清除，不泄漏去 abort", async () => {
    // Covers the no-leak guarantee promised by the finally clearTimeout:
    // a fast run that completes before maxRunMs must NOT leave a pending
    // timeout that fires later and aborts a subsequent run's signal.
    //
    // Real timers are kept (runSchedule awaits real IDB ops that don't play
    // well with vi.useFakeTimers()); instead we spy on setTimeout/clearTimeout
    // and assert the exact timer the budget armed was cleared, and that the
    // captured signal stays unaborted even after the maxRunMs window elapses.
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      // Tiny budget so any leaked timer would fire fast during the wait below.
      await putSchedule(makeSched({ id: "sched_fast", maxRunMs: 20 }));

      let capturedSignal: AbortSignal | undefined;
      const fastLoop = vi.fn(async (ctx: AgentLoopContext) => {
        capturedSignal = ctx.signal;
        // Completes immediately — pure-text path, well before maxRunMs.
        ctx.emit({ type: "chat-done", sessionId: ctx.sessionId });
      });

      await runSchedule("sched_fast", okDeps({ runAgentLoop: fastLoop }));

      // Identify the budget timer by its delay (maxRunMs=20) — other awaited
      // code might schedule unrelated timers, so don't assume call index 0.
      const budgetCallIdx = setSpy.mock.calls.findIndex((c) => c[1] === 20);
      expect(budgetCallIdx).toBeGreaterThanOrEqual(0);
      const budgetHandle = setSpy.mock.results[budgetCallIdx]!.value;
      // That exact timer handle must have been cleared by the finally block.
      expect(clearSpy).toHaveBeenCalledWith(budgetHandle);

      // The signal must NOT be aborted — the run completed cleanly.
      expect(capturedSignal!.aborted).toBe(false);

      // Wait past the (tiny) maxRunMs window; a leaked timer would have fired
      // by now and aborted the signal. It must remain unaborted.
      await new Promise((r) => setTimeout(r, 60));
      expect(capturedSignal!.aborted).toBe(false);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
