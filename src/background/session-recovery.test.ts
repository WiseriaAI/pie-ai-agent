import { describe, expect, it } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  createSession,
  getSessionAgent,
  getSessionMeta,
  setPendingConfirm,
  setSessionAgent,
  setSessionMeta,
} from "@/lib/sessions/storage";
import {
  detectAndMarkPaused,
  transitionPortInFlightSessionsToPaused,
} from "./session-recovery";

// detectAndMarkPaused is the SW-side cold-start recovery routine.
// Its three-step ordering (markFailed-then-scrub for sessions with
// pendingConfirm; mark-paused for the remaining stepIndex>0 sessions;
// bump the recoveryGuard) is the M1-U5 invariant — these tests pin
// each step + the order between them.

const samplePending = {
  confirmationId: "c1",
  kind: "agent-tool" as const,
  payload: { tool: "click", args: {}, resolvedElement: { text: "", tag: "" }, riskReason: "x" },
};

describe("detectAndMarkPaused — happy paths", () => {
  it("transitions an in-flight session (stepIndex>0) to paused", async () => {
    const meta = await createSession({ now: 1000 });
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 3,
      hasImageContent: false,
    });

    const stats = await detectAndMarkPaused({ now: 5000, skipGuard: true });

    expect(stats.paused).toBe(1);
    expect(stats.failed).toBe(0);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.status).toBe("paused");
  });

  it("transitions a session with pendingConfirm to failed (resolver dead post-restart)", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });
    await setPendingConfirm(meta.id, samplePending);

    const stats = await detectAndMarkPaused({ skipGuard: true });

    expect(stats.failed).toBe(1);
    expect(stats.paused).toBe(0);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.status).toBe("failed");
    // Scrub happened — pendingConfirm cleared.
    const agent = await getSessionAgent(meta.id);
    expect(agent!.pendingConfirm).toBeUndefined();
  });

  it("leaves a tombstone session (stepIndex=0) alone", async () => {
    const meta = await createSession();
    // Default agent state has stepIndex=0 — the tombstone shape M1-U3
    // writes when a task is done.
    const stats = await detectAndMarkPaused({ skipGuard: true });

    expect(stats.paused).toBe(0);
    expect(stats.failed).toBe(0);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.status).toBe("active");
  });

  it("step ordering: markFailed runs BEFORE markPaused (no double-mark)", async () => {
    // Session A: in-flight (stepIndex=3, no pending) → should be paused.
    // Session B: in-flight + pending confirm → should be failed.
    // The Step 1 scan must mark B as failed FIRST so the Step 2 scan
    // sees it as `failed` and skips it. Otherwise Step 2 might
    // overwrite B's status to `paused`.
    const a = await createSession();
    const b = await createSession();
    await setSessionAgent(a.id, {
      agentMessages: [{ role: "user", content: "task-a" }],
      stepIndex: 3,
      hasImageContent: false,
    });
    await setSessionAgent(b.id, {
      agentMessages: [{ role: "user", content: "task-b" }],
      stepIndex: 5,
      hasImageContent: false,
    });
    await setPendingConfirm(b.id, samplePending);

    const stats = await detectAndMarkPaused({ skipGuard: true });

    expect(stats.paused).toBe(1);
    expect(stats.failed).toBe(1);
    expect((await getSessionMeta(a.id))!.status).toBe("paused");
    expect((await getSessionMeta(b.id))!.status).toBe("failed");
  });
});

describe("detectAndMarkPaused — R14 image-bearing sessions", () => {
  it("R14 — image-bearing in-flight session is marked failed (not paused) on SW restart", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: true, // R14 trigger
    });

    const stats = await detectAndMarkPaused({ skipGuard: true });

    expect(stats.failed).toBe(1);
    expect(stats.paused).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("failed");
  });

  it("R14 — non-image in-flight session is still marked paused on SW restart", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 3,
      hasImageContent: false,
    });

    const stats = await detectAndMarkPaused({ skipGuard: true });

    expect(stats.paused).toBe(1);
    expect(stats.failed).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("paused");
  });

  it("R14 — image-bearing session with pendingConfirm is still failed via step 1 (pendingConfirm wins)", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 5,
      hasImageContent: true,
    });
    await setPendingConfirm(meta.id, samplePending);

    const stats = await detectAndMarkPaused({ skipGuard: true });

    // Step 1 catches it (pendingConfirm present → markFailedAndScrub),
    // so step 2 R14 branch never fires.
    expect(stats.failed).toBe(1);
    expect((await getSessionMeta(meta.id))!.status).toBe("failed");
  });
});

describe("detectAndMarkPaused — recoveryGuard", () => {
  it("skips re-entry within the 30s guard window", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });

    const first = await detectAndMarkPaused({ now: 1000 });
    expect(first.paused).toBe(1);
    expect(first.skippedDueToGuard).toBe(false);

    // Rewind/restore the session as if it never got marked, then call
    // again 5 seconds later. The guard should skip even though there's
    // an "in-flight" session ready to mark.
    await setSessionMeta({
      ...(await getSessionMeta(meta.id))!,
      status: "active",
    });

    const second = await detectAndMarkPaused({ now: 6000 });
    expect(second.skippedDueToGuard).toBe(true);
    expect(second.paused).toBe(0);
    // Status not touched.
    expect((await getSessionMeta(meta.id))!.status).toBe("active");
  });

  it("does NOT skip past the 30s guard window", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });

    const first = await detectAndMarkPaused({ now: 1000 });
    expect(first.paused).toBe(1);

    await setSessionMeta({
      ...(await getSessionMeta(meta.id))!,
      status: "active",
    });

    // 31 seconds later — guard expired.
    const second = await detectAndMarkPaused({ now: 32_000 });
    expect(second.skippedDueToGuard).toBe(false);
    expect(second.paused).toBe(1);
    expect((await getSessionMeta(meta.id))!.status).toBe("paused");
  });

  it("skipGuard: true bypasses the window (used by tests + first-install)", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });

    await detectAndMarkPaused({ now: 1000 });
    await setSessionMeta({
      ...(await getSessionMeta(meta.id))!,
      status: "active",
    });
    const second = await detectAndMarkPaused({ now: 1500, skipGuard: true });
    expect(second.skippedDueToGuard).toBe(false);
    expect(second.paused).toBe(1);
  });
});

describe("detectAndMarkPaused — guard storage", () => {
  it("writes recovery_guard timestamp to its own key (NOT inside SessionMeta)", async () => {
    await createSession();
    await detectAndMarkPaused({ now: 12345, skipGuard: true });
    const guard = chromeMock.storage.local.__store.recovery_guard;
    expect(guard).toBe(12345);
  });
});

// ── Bug-fix-E: per-port panel-disconnect transition ───────────────────────────
//
// The on-disconnect path uses a per-port set of in-flight session ids
// (NOT a global scan) so a sibling sidepanel's running tasks are unaffected
// when this port closes. transitionPortInFlightSessionsToPaused mirrors
// detectAndMarkPaused's step-1 + step-2 transitions but scoped to the
// supplied id list.

describe("transitionPortInFlightSessionsToPaused — per-port subset", () => {
  it("marks an in-flight session paused (stepIndex>0, no pendingConfirm)", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 4,
      hasImageContent: false,
    });

    const stats = await transitionPortInFlightSessionsToPaused([meta.id]);

    expect(stats.paused).toBe(1);
    expect(stats.failed).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("paused");
  });

  it("marks a session with pendingConfirm failed + scrubs the record", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });
    await setPendingConfirm(meta.id, samplePending);

    const stats = await transitionPortInFlightSessionsToPaused([meta.id]);

    expect(stats.failed).toBe(1);
    expect(stats.paused).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("failed");
    expect((await getSessionAgent(meta.id))!.pendingConfirm).toBeUndefined();
  });

  it("leaves a tombstone session (stepIndex=0) alone", async () => {
    const meta = await createSession();
    // Default agent state has stepIndex=0 — task already finished cleanly.

    const stats = await transitionPortInFlightSessionsToPaused([meta.id]);

    expect(stats.paused).toBe(0);
    expect(stats.failed).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("active");
  });

  it("does NOT touch sessions outside the supplied id set (multi-port isolation)", async () => {
    // Simulates: Port A holds sessions [a1, a2]. Port B holds [b1].
    // Port A disconnects → its helper call should leave b1 untouched
    // even though b1 is also in-flight.
    const a1 = await createSession();
    const b1 = await createSession();
    await setSessionAgent(a1.id, {
      agentMessages: [{ role: "user", content: "a1" }],
      stepIndex: 3,
      hasImageContent: false,
    });
    await setSessionAgent(b1.id, {
      agentMessages: [{ role: "user", content: "b1" }],
      stepIndex: 7,
      hasImageContent: false,
    });

    const stats = await transitionPortInFlightSessionsToPaused([a1.id]);

    expect(stats.paused).toBe(1);
    expect((await getSessionMeta(a1.id))!.status).toBe("paused");
    expect((await getSessionMeta(b1.id))!.status).toBe("active");
  });

  it("handles a missing session id (deleted) without aborting the rest", async () => {
    const real = await createSession();
    await setSessionAgent(real.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 1,
      hasImageContent: false,
    });

    const stats = await transitionPortInFlightSessionsToPaused([
      "missing-id-not-in-storage",
      real.id,
    ]);

    expect(stats.paused).toBe(1);
    expect((await getSessionMeta(real.id))!.status).toBe("paused");
  });

  it("does NOT bump recovery_guard (panel close is user-driven, not idempotent)", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });

    await transitionPortInFlightSessionsToPaused([meta.id]);

    const guard = chromeMock.storage.local.__store.recovery_guard;
    expect(guard).toBeUndefined();
  });

  it("R14 — image-bearing in-flight session is marked failed (not paused) on port disconnect", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 3,
      hasImageContent: true, // R14 trigger
    });

    const stats = await transitionPortInFlightSessionsToPaused([meta.id]);

    expect(stats.failed).toBe(1);
    expect(stats.paused).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("failed");
  });

  it("R14 — non-image in-flight session is still marked paused on port disconnect", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "task" }],
      stepIndex: 2,
      hasImageContent: false,
    });

    const stats = await transitionPortInFlightSessionsToPaused([meta.id]);

    expect(stats.paused).toBe(1);
    expect(stats.failed).toBe(0);
    expect((await getSessionMeta(meta.id))!.status).toBe("paused");
  });
});
