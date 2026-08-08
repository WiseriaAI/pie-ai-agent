// Liveness ping — the detection signal that works on browsers without
// chrome.runtime.getContexts.
//
// It has to distinguish three outcomes that all arrive as one sendMessage
// result, and only one of them means "a panel is on screen".

import { describe, it, expect, afterEach, vi } from "vitest";
import { PANEL_PING_MESSAGE, installPanelPingResponder, panelDocumentResponds } from "./panel-ping";

const g = globalThis as unknown as {
  chrome: {
    runtime: {
      sendMessage?: ReturnType<typeof vi.fn>;
      onMessage: { addListener: (l: unknown) => void; removeListener: (l: unknown) => void };
    };
  };
};

const originalSend = g.chrome.runtime.sendMessage;

afterEach(() => {
  g.chrome.runtime.sendMessage = originalSend;
});

describe("panelDocumentResponds", () => {
  it("is true when a panel answers the ping", async () => {
    g.chrome.runtime.sendMessage = vi.fn(async () => ({ pong: true }));
    expect(await panelDocumentResponds()).toBe(true);
  });

  it("is false when nothing is listening at all", async () => {
    // Chrome rejects with "Could not establish connection…" when there are no
    // receivers — no panel, no anything.
    g.chrome.runtime.sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    expect(await panelDocumentResponds()).toBe(false);
  });

  it("is false when another context answers the broadcast but no panel does", async () => {
    // The offscreen PDF document also listens on runtime messaging. With
    // listeners present but none replying, sendMessage RESOLVES with undefined
    // — so a bare "did it reject?" check would report a panel that isn't there.
    g.chrome.runtime.sendMessage = vi.fn(async () => undefined);
    expect(await panelDocumentResponds()).toBe(false);
  });
});

describe("installPanelPingResponder", () => {
  it("answers the ping and ignores unrelated messages", () => {
    const listeners: Array<(m: unknown, s: unknown, r: (v: unknown) => void) => void> = [];
    g.chrome.runtime.onMessage.addListener = (l) =>
      listeners.push(l as (typeof listeners)[number]);

    installPanelPingResponder();
    expect(listeners).toHaveLength(1);

    const sendResponse = vi.fn();
    listeners[0]({ type: PANEL_PING_MESSAGE }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ pong: true });

    sendResponse.mockClear();
    listeners[0]({ type: "something-else" }, {}, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
