import { describe, it, expect, vi, beforeEach } from "vitest";

type Listener = (
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

function installChromeMock() {
  let hasDoc = false;
  const createDocument = vi.fn(async () => {
    hasDoc = true;
  });
  const hasDocument = vi.fn(async () => hasDoc);
  const closeDocument = vi.fn(async () => {
    hasDoc = false;
  });

  const listeners: Listener[] = [];
  const sendMessage = vi.fn(async (msg: unknown) => {
    const m = msg as { requestId?: string };
    return { ok: true, result: { echoed: msg, requestId: m.requestId } };
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    offscreen: {
      createDocument,
      hasDocument,
      closeDocument,
      Reason: { BLOBS: "BLOBS" },
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      sendMessage,
      onMessage: {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: () => {},
      },
      id: "abc",
    },
  };
  return { createDocument, hasDocument, sendMessage };
}

describe("offscreen-manager", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates the offscreen document on first ensureOffscreen and reuses on subsequent calls", async () => {
    const { createDocument, hasDocument } = installChromeMock();
    const mod = await import("./offscreen-manager");
    await mod.ensureOffscreen();
    await mod.ensureOffscreen();
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(hasDocument).toHaveBeenCalled();
  });

  it("forwards requests with a generated requestId and resolves with the offscreen reply payload", async () => {
    const { sendMessage } = installChromeMock();
    const mod = await import("./offscreen-manager");
    const res = await mod.sendToOffscreen({ type: "pdf:outline", url: "u" });
    expect(res).toBeDefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][0] as {
      target: string;
      requestId: string;
      type: string;
    };
    expect(sent.target).toBe("offscreen");
    expect(sent.type).toBe("pdf:outline");
    expect(typeof sent.requestId).toBe("string");
    expect(sent.requestId.length).toBeGreaterThan(0);
  });

  it("surfaces offscreen-side errors as rejections", async () => {
    installChromeMock();
    const chromeObj = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome;
    chromeObj.runtime.sendMessage.mockImplementationOnce(async () => ({
      ok: false,
      error: "boom",
    }));
    const mod = await import("./offscreen-manager");
    await expect(mod.sendToOffscreen({ type: "pdf:outline", url: "u" }))
      .rejects.toThrow(/boom/);
  });
});
