import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dispatchQuoteAdded,
  drainPendingQuotesToPort,
  __resetPendingForTest,
  __pendingLengthForTest,
} from "./quote-dispatch";
import type { Quote } from "@/types";

function fakeQuote(id: string, text = "hello"): Quote {
  return {
    id,
    kind: "text",
    text,
    sourceUrl: "https://example.com/",
    sourceTabId: 1,
  };
}

function fakePort(): chrome.runtime.Port & { postMessage: ReturnType<typeof vi.fn> } {
  return {
    name: "chat-stream-s1",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onDisconnect: { addListener: vi.fn() } as unknown as chrome.events.Event<() => void>,
    onMessage: { addListener: vi.fn() } as unknown as chrome.events.Event<(message: unknown) => void>,
  } as unknown as chrome.runtime.Port & { postMessage: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  __resetPendingForTest();
});

describe("dispatchQuoteAdded", () => {
  it("broadcasts to every port when ports is non-empty", () => {
    const portA = fakePort();
    const portB = fakePort();
    const ports = new Map<string, chrome.runtime.Port>([
      ["s1", portA],
      ["s2", portB],
    ]);

    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q1") }, ports);

    expect(portA.postMessage).toHaveBeenCalledWith({
      type: "quote-added",
      quote: fakeQuote("q1"),
      sessionId: "s1",
    });
    expect(portB.postMessage).toHaveBeenCalledWith({
      type: "quote-added",
      quote: fakeQuote("q1"),
      sessionId: "s2",
    });
    expect(__pendingLengthForTest()).toBe(0);
  });

  it("stashes to pending when ports is empty (panel closed at bubble click)", () => {
    const ports = new Map<string, chrome.runtime.Port>();

    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q1") }, ports);
    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q2") }, ports);

    expect(__pendingLengthForTest()).toBe(2);
  });

  it("caps pending queue at PENDING_LIMIT (=8) and drops further additions silently", () => {
    const ports = new Map<string, chrome.runtime.Port>();
    for (let i = 0; i < 15; i++) {
      dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote(`q${i}`) }, ports);
    }
    expect(__pendingLengthForTest()).toBe(8);
  });

  it("returns true when stashed (ports empty) and false when delivered", () => {
    expect(
      dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q1") }, new Map()),
    ).toBe(true);

    const ports = new Map<string, chrome.runtime.Port>([["s1", fakePort()]]);
    expect(
      dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q2") }, ports),
    ).toBe(false);
  });

  it("survives a port whose postMessage throws (other ports still receive)", () => {
    const portA = fakePort();
    portA.postMessage.mockImplementation(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    const portB = fakePort();
    const ports = new Map<string, chrome.runtime.Port>([
      ["s1", portA],
      ["s2", portB],
    ]);

    expect(() =>
      dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q1") }, ports),
    ).not.toThrow();
    expect(portB.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("drainPendingQuotesToPort", () => {
  it("delivers stashed quotes to the new port with that port's sessionId", () => {
    const ports = new Map<string, chrome.runtime.Port>();
    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q1") }, ports);
    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q2") }, ports);

    const newPort = fakePort();
    drainPendingQuotesToPort("active-session", newPort);

    expect(newPort.postMessage).toHaveBeenCalledTimes(2);
    expect(newPort.postMessage).toHaveBeenNthCalledWith(1, {
      type: "quote-added",
      quote: fakeQuote("q1"),
      sessionId: "active-session",
    });
    expect(newPort.postMessage).toHaveBeenNthCalledWith(2, {
      type: "quote-added",
      quote: fakeQuote("q2"),
      sessionId: "active-session",
    });
    expect(__pendingLengthForTest()).toBe(0);
  });

  it("no-op when pending is empty", () => {
    const newPort = fakePort();
    drainPendingQuotesToPort("s1", newPort);
    expect(newPort.postMessage).not.toHaveBeenCalled();
  });

  it("clears pending exactly once even if drain throws on a postMessage", () => {
    const ports = new Map<string, chrome.runtime.Port>();
    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q1") }, ports);
    dispatchQuoteAdded({ type: "quote-added", quote: fakeQuote("q2") }, ports);

    const newPort = fakePort();
    newPort.postMessage.mockImplementationOnce(() => {
      throw new Error("disconnected");
    });

    drainPendingQuotesToPort("s1", newPort);
    expect(__pendingLengthForTest()).toBe(0);
  });
});
