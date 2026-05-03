import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/test/setup";
import {
  acquireCdpSession,
  CdpAttachError,
  detachAllSessions,
} from "./cdp-session";

// chrome.debugger mock — minimum surface for cdp-session.ts. We don't
// install this in the global setup because the rest of the suite has no
// reason to load it; cdp-session is the only consumer.
//
// `__attachQueue` lets a test enqueue an error to fail the next attach,
// which is how we exercise the "Another debugger" conflict path without
// physically attaching a real debugger. Mirrors how Chrome surfaces
// chrome.runtime.lastError synchronously inside the callback.
interface DebuggerMockState {
  attached: Set<number>;
  __nextAttachError: string | null;
  __detachInFlight: Set<number>;
}

const debuggerState: DebuggerMockState = {
  attached: new Set(),
  __nextAttachError: null,
  __detachInFlight: new Set(),
};

const debuggerMock = {
  attach: vi.fn(
    (
      target: { tabId: number },
      _version: string,
      cb: () => void,
    ) => {
      // Simulate Chrome's lastError mechanic.
      if (debuggerState.__nextAttachError) {
        const err = debuggerState.__nextAttachError;
        debuggerState.__nextAttachError = null;
        // Chrome sets chrome.runtime.lastError, then invokes cb.
        (
          globalThis as unknown as {
            chrome: { runtime: { lastError?: { message: string } } };
          }
        ).chrome.runtime.lastError = { message: err };
        cb();
        delete (
          globalThis as unknown as {
            chrome: { runtime: { lastError?: { message: string } } };
          }
        ).chrome.runtime.lastError;
        return;
      }
      // M3-U3 ADV-9 simulation — when a chromeDetach is in flight on the
      // same tabId, a concurrent chromeAttach hits the real Chrome failure
      // mode "Another debugger is already attached". The queueTabOp lock
      // is supposed to serialize these so this code path is unreachable
      // under M3; without the lock it fires and the test's race-handover
      // case rejects loudly.
      if (debuggerState.__detachInFlight.has(target.tabId)) {
        (
          globalThis as unknown as {
            chrome: { runtime: { lastError?: { message: string } } };
          }
        ).chrome.runtime.lastError = {
          message: "Another debugger is already attached to this tab.",
        };
        cb();
        delete (
          globalThis as unknown as {
            chrome: { runtime: { lastError?: { message: string } } };
          }
        ).chrome.runtime.lastError;
        return;
      }
      debuggerState.attached.add(target.tabId);
      cb();
    },
  ),
  detach: vi.fn((target: { tabId: number }, cb: () => void) => {
    // Mark the tab as "detach-in-flight" until the next macrotask so any
    // concurrent attach that races us sees the busy state. Mirrors the
    // real Chrome behavior where chrome.debugger.detach is async at the
    // protocol layer.
    debuggerState.__detachInFlight.add(target.tabId);
    debuggerState.attached.delete(target.tabId);
    setTimeout(() => {
      debuggerState.__detachInFlight.delete(target.tabId);
      cb();
    }, 0);
  }),
  sendCommand: vi.fn(
    (
      _target: { tabId: number },
      _method: string,
      _params: Record<string, unknown>,
      cb: (result: unknown) => void,
    ) => {
      cb({});
    },
  ),
  onDetach: { addListener: vi.fn() },
};

beforeEach(() => {
  debuggerState.attached.clear();
  debuggerState.__nextAttachError = null;
  debuggerState.__detachInFlight.clear();
  debuggerMock.attach.mockClear();
  debuggerMock.detach.mockClear();
  debuggerMock.sendCommand.mockClear();
  // Wire chrome.debugger onto the test harness.
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.debugger =
    debuggerMock;
});

afterEach(async () => {
  // Defensive: ensure no live sessions leak into the next test.
  await detachAllSessions("explicit-detach");
});

describe("cdp-session — M3-U3 ownerToken (sessionId, tabId)", () => {
  it("acquireCdpSession returns a session with the structured ownerToken", async () => {
    const ac = new AbortController();
    const session = await acquireCdpSession(7, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 7 },
      onExternalDetach: () => {},
    });
    expect(session.ownerToken).toEqual({ sessionId: "sess-A", tabId: 7 });
    expect(session.tabId).toBe(7);
    expect(session.isAlive).toBe(true);
    await session.detach();
  });

  it("re-acquire by the same sessionId reuses the live session", async () => {
    const ac = new AbortController();
    const a = await acquireCdpSession(8, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 8 },
      onExternalDetach: () => {},
    });
    const b = await acquireCdpSession(8, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 8 },
      onExternalDetach: () => {},
    });
    expect(b).toBe(a);
    // chrome.debugger.attach should only have been called once for this tab.
    expect(debuggerMock.attach).toHaveBeenCalledTimes(1);
    await a.detach();
  });

  it("attempting to acquire same tabId from a different sessionId rejects with conflict + names the offender", async () => {
    const ac = new AbortController();
    await acquireCdpSession(9, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 9 },
      onExternalDetach: () => {},
    });

    // Different session attempts to acquire — must fail fast.
    await expect(
      acquireCdpSession(9, {
        signal: ac.signal,
        ownerToken: { sessionId: "sess-B", tabId: 9 },
        onExternalDetach: () => {},
      }),
    ).rejects.toMatchObject({
      kind: "conflict",
    });

    // Confirm the error message names the conflicting session id, so
    // operators can debug "which sidepanel stole my tab" from logs.
    try {
      await acquireCdpSession(9, {
        signal: ac.signal,
        ownerToken: { sessionId: "sess-B", tabId: 9 },
        onExternalDetach: () => {},
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CdpAttachError);
      expect((e as Error).message).toContain("sess-A");
    }
  });

  it("multi-session — sessions on DIFFERENT tabs do not interfere", async () => {
    const ac = new AbortController();
    const a = await acquireCdpSession(10, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 10 },
      onExternalDetach: () => {},
    });
    const b = await acquireCdpSession(11, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-B", tabId: 11 },
      onExternalDetach: () => {},
    });
    expect(a).not.toBe(b);
    expect(a.ownerToken.sessionId).toBe("sess-A");
    expect(b.ownerToken.sessionId).toBe("sess-B");
    expect(debuggerMock.attach).toHaveBeenCalledTimes(2);
    await a.detach();
    await b.detach();
  });

  it("attach handover race — sequential acquire-after-detach on same tab works (ADV-9 with realistic mock)", async () => {
    // ADV-9: session A finally-detach interleaves with session B acquire on
    // the same tab. With the M3-U3 per-tabId attach lock, B's chromeAttach
    // is queued behind A's chromeDetach so it sees a clean Chrome state.
    //
    // The mock now simulates the real Chrome failure: while a detach is
    // in flight on tabId X, any concurrent attach on the same X rejects
    // with "Another debugger is already attached." If the queueTabOp
    // serialization were removed, B's acquire would hit that rejection.
    const ac = new AbortController();
    const a = await acquireCdpSession(12, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 12 },
      onExternalDetach: () => {},
    });
    // Don't await detach — kick it off so it overlaps with B's acquire.
    const detachPromise = a.detach();
    const b = await acquireCdpSession(12, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-B", tabId: 12 },
      onExternalDetach: () => {},
    });
    expect(b.ownerToken.sessionId).toBe("sess-B");
    expect(b.isAlive).toBe(true);
    await detachPromise;
    await b.detach();
  });

  it("queueTabOp isolates per-tabId chains — slow attach on tab X does not block tab Y", async () => {
    // Reliability + adversarial review concern: if queueTabOp keyed on
    // anything other than tabId, a hung attach on tab X would starve
    // tab Y. Test isolates that contract by acquiring on Y while X's
    // chain is in flight.
    const ac = new AbortController();
    // Trigger an in-flight detach on tab 13 by acquiring then detaching;
    // we don't await, so for the next macrotask tab 13 is "detach in flight".
    const a = await acquireCdpSession(13, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 13 },
      onExternalDetach: () => {},
    });
    const detachPromise = a.detach();
    // Tab 14 acquire should NOT be blocked by tab 13's chain.
    const b = await acquireCdpSession(14, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 14 },
      onExternalDetach: () => {},
    });
    expect(b.tabId).toBe(14);
    expect(b.isAlive).toBe(true);
    await detachPromise;
    await b.detach();
  });

  it("queueTabOp tolerates a failed prior attach — next acquire on same tab still runs", async () => {
    // queueTabOp uses `prev.then(op, op)` so a failed prior op does not
    // deadlock the chain. Force the first attach to fail; verify the
    // second acquire on the same tab proceeds.
    debuggerState.__nextAttachError = "synthetic attach failure for test";
    const ac = new AbortController();
    await expect(
      acquireCdpSession(15, {
        signal: ac.signal,
        ownerToken: { sessionId: "sess-A", tabId: 15 },
        onExternalDetach: () => {},
      }),
    ).rejects.toThrow();
    // Next acquire on same tab — should proceed cleanly.
    const ok = await acquireCdpSession(15, {
      signal: ac.signal,
      ownerToken: { sessionId: "sess-A", tabId: 15 },
      onExternalDetach: () => {},
    });
    expect(ok.isAlive).toBe(true);
    await ok.detach();
  });
});
