import { describe, it, expect, beforeEach, vi } from "vitest";
import { requireCdpInput, dispatchMouseAt } from "./mouse";
import type { CdpSession } from "@/background/cdp-session";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";

const fakeSession = (): CdpSession => ({
  tabId: 7,
  ownerToken: { sessionId: "S1", tabId: 7 },
  generationId: 1,
  isAlive: true,
  detachedReason: null,
  send: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn(),
});

beforeEach(() => {
  const data: Record<string, unknown> = {};
  // @ts-expect-error mock
  global.chrome = {
    storage: {
      local: {
        get: vi.fn((k) => {
          const want = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of want) if (key in data) out[key] = data[key];
          return Promise.resolve(out);
        }),
        set: vi.fn((kv) => { Object.assign(data, kv); return Promise.resolve(); }),
        remove: vi.fn(() => Promise.resolve()),
      },
    },
  };
});

describe("dispatchMouseAt", () => {
  it("sends mouseMoved with button=none clickCount=0", async () => {
    const session = fakeSession();
    await dispatchMouseAt(session, 100, 200, "mouseMoved");
    expect(session.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 100,
      y: 200,
      button: "none",
      clickCount: 0,
      pointerType: "mouse",
    });
  });

  it("sends mousePressed with button=left clickCount=1", async () => {
    const session = fakeSession();
    await dispatchMouseAt(session, 50, 60, "mousePressed");
    expect(session.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 50,
      y: 60,
      button: "left",
      clickCount: 1,
      pointerType: "mouse",
    });
  });
});

describe("requireCdpInput", () => {
  it("returns ok=true when flag=true", async () => {
    await setCdpInputEnabled(true);
    const result = await requireCdpInput({ sessionId: "S1", requestConsent: async () => true });
    expect(result.ok).toBe(true);
  });

  it("returns cdp-disabled error when flag=false", async () => {
    await setCdpInputEnabled(false);
    const result = await requireCdpInput({ sessionId: "S1", requestConsent: async () => true });
    expect(result).toEqual({
      ok: false,
      error: "CDP input is disabled in Settings. Cannot click/hover.",
    });
  });

  it("calls requestConsent when flag=undefined and resolves true → ok", async () => {
    const requestConsent = vi.fn().mockResolvedValue(true);
    const result = await requireCdpInput({ sessionId: "S1", requestConsent });
    expect(requestConsent).toHaveBeenCalledWith("S1");
    expect(result.ok).toBe(true);
  });

  it("returns cdp-disabled error when consent declined", async () => {
    const result = await requireCdpInput({
      sessionId: "S1",
      requestConsent: async () => false,
    });
    expect(result).toEqual({
      ok: false,
      error: "CDP input is disabled in Settings. Cannot click/hover.",
    });
  });

  it("returns onboarding-cancelled when requestConsent throws", async () => {
    const result = await requireCdpInput({
      sessionId: "S1",
      requestConsent: async () => { throw new Error("Onboarding cancelled (panel closed)"); },
    });
    expect(result).toEqual({
      ok: false,
      error: "Onboarding cancelled (panel closed).",
    });
  });
});
