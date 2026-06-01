/**
 * C-1 regression: SW bridge calls `acquireCdpSession(tabId, options)` correctly.
 *
 * Before this fix, `makeCdpAdapterForScreenshot` (previously inlined) spread
 * a single object: `acquireCdpSession({ ...token, abortSignal: signal })`.
 * That matches neither positional parameter (tabId: number, options: object),
 * causing `TypeError: Cannot destructure property 'signal' of 'undefined'`
 * at runtime on every `capture_fullpage_tab` call.
 *
 * This test imports `makeCdpAdapterForScreenshot` from `./index` and asserts
 * the correct two-arg shape: `(42, { signal, ownerToken, onExternalDetach })`.
 */
import { describe, it, expect, vi } from "vitest";
import * as cdpSession from "./cdp-session";
import { makeCdpAdapterForScreenshot } from "./cdp-adapter";

const fakeCdpSession = {
  tabId: 42,
  ownerToken: { sessionId: "s1", tabId: 42 },
  generationId: 1,
  isAlive: true,
  detachedReason: null,
  send: vi.fn(async () => ({ data: "AAAA" })),
  detach: vi.fn(async () => {}),
};

describe("makeCdpAdapterForScreenshot — SW CDP bridge shape (C-1)", () => {
  it("calls acquireCdpSession(tabId, { signal, ownerToken, onExternalDetach })", async () => {
    const spy = vi
      .spyOn(cdpSession, "acquireCdpSession")
      .mockResolvedValue(fakeCdpSession as never);

    const ac = new AbortController();
    const adapter = makeCdpAdapterForScreenshot(ac);

    await adapter.acquireSession({ sessionId: "s1", tabId: 42 });

    expect(spy).toHaveBeenCalledTimes(1);

    // First positional arg must be the numeric tabId (not a merged object).
    const [firstArg, secondArg] = spy.mock.calls[0]!;
    expect(firstArg).toBe(42);

    // Second positional arg must have the required option fields.
    expect(secondArg).toMatchObject({
      signal: ac.signal,
      ownerToken: { sessionId: "s1", tabId: 42 },
    });
    expect(typeof (secondArg as { onExternalDetach: unknown }).onExternalDetach).toBe("function");

    spy.mockRestore();
  });

  it("onExternalDetach calls abortController.abort()", async () => {
    const spy = vi
      .spyOn(cdpSession, "acquireCdpSession")
      .mockResolvedValue(fakeCdpSession as never);

    const ac = new AbortController();
    const adapter = makeCdpAdapterForScreenshot(ac);

    await adapter.acquireSession({ sessionId: "s1", tabId: 42 });

    const [, secondArg] = spy.mock.calls[0]!;
    const { onExternalDetach } = secondArg as unknown as { onExternalDetach: () => void };

    expect(ac.signal.aborted).toBe(false);
    onExternalDetach();
    expect(ac.signal.aborted).toBe(true);

    spy.mockRestore();
  });

  it("uses token.abortSignal when supplied (overrides controller signal)", async () => {
    const spy = vi
      .spyOn(cdpSession, "acquireCdpSession")
      .mockResolvedValue(fakeCdpSession as never);

    const ac = new AbortController();
    const tokenAc = new AbortController();
    const adapter = makeCdpAdapterForScreenshot(ac);

    await adapter.acquireSession({
      sessionId: "s1",
      tabId: 42,
      abortSignal: tokenAc.signal,
    });

    const [, secondArg] = spy.mock.calls[0]!;
    // token.abortSignal takes priority via ?? fallback.
    expect((secondArg as { signal: AbortSignal }).signal).toBe(tokenAc.signal);

    spy.mockRestore();
  });
});
