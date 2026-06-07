import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildClickTool, type MouseToolDeps } from "@/lib/agent/tools/mouse";
import {
  isCdpInputEnabled,
  setCdpInputEnabled,
} from "@/lib/cdp-input-enabled";
import { _resetForTests } from "@/lib/idb/db";
import type { CdpSession } from "@/background/cdp-session";

vi.mock("@/lib/dom-actions/geometry", () => ({
  elementToPagePoint: vi.fn().mockResolvedValue({ x: 100, y: 200 }),
}));

function fakeSession(): CdpSession {
  return {
    tabId: 7,
    ownerToken: { sessionId: "S1", tabId: 7 },
    generationId: 1,
    isAlive: true,
    detachedReason: null,
    send: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn(),
  };
}

beforeEach(async () => {
  await _resetForTests();
  global.chrome = {
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
    } as unknown as typeof chrome.scripting,
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.webNavigation.onCommitted,
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() } as unknown as typeof chrome.webNavigation.onHistoryStateUpdated,
    },
  } as unknown as typeof chrome;
});

describe("consent gating end-to-end", () => {
  it("first call (flag=undefined) triggers requestConsent and proceeds when accepted", async () => {
    expect(await isCdpInputEnabled()).toBe(undefined);
    const requestConsent = vi.fn().mockImplementation(async () => {
      // Simulate sidepanel coordinator persisting flag on user accept
      await setCdpInputEnabled(true);
      return true;
    });
    const deps: MouseToolDeps = {
      acquireSession: vi.fn().mockResolvedValue(fakeSession()),
      sessionId: "S1",
      requestConsent,
    };
    const tool = buildClickTool(deps);
    const r = await tool.handler({ frameId: 0, elementIndex: 1 }, { tabId: 7 });
    expect(requestConsent).toHaveBeenCalled();
    expect(r.success).toBe(true);
    expect(await isCdpInputEnabled()).toBe(true);
  });

  it("first call with decline returns disabled error and persists flag=false", async () => {
    const requestConsent = vi.fn().mockImplementation(async () => {
      await setCdpInputEnabled(false);
      return false;
    });
    const deps: MouseToolDeps = {
      acquireSession: vi.fn(),
      sessionId: "S1",
      requestConsent,
    };
    const tool = buildClickTool(deps);
    const r = await tool.handler({ frameId: 0, elementIndex: 1 }, { tabId: 7 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/declined|not enabled/i);
    expect(await isCdpInputEnabled()).toBe(false);
  });

  it("once flag=true, subsequent calls do not invoke requestConsent", async () => {
    await setCdpInputEnabled(true);
    const requestConsent = vi.fn();
    const deps: MouseToolDeps = {
      acquireSession: vi.fn().mockResolvedValue(fakeSession()),
      sessionId: "S1",
      requestConsent,
    };
    const tool = buildClickTool(deps);
    await tool.handler({ frameId: 0, elementIndex: 1 }, { tabId: 7 });
    await tool.handler({ frameId: 0, elementIndex: 2 }, { tabId: 7 });
    expect(requestConsent).not.toHaveBeenCalled();
  });

  it("flag=false re-invokes requestConsent each call (re-prompt to enable on the spot)", async () => {
    await setCdpInputEnabled(false);
    const requestConsent = vi.fn().mockResolvedValue(false);
    const deps: MouseToolDeps = {
      acquireSession: vi.fn(),
      sessionId: "S1",
      requestConsent,
    };
    const tool = buildClickTool(deps);
    const r = await tool.handler({ frameId: 0, elementIndex: 1 }, { tabId: 7 });
    expect(r.success).toBe(false);
    expect(requestConsent).toHaveBeenCalled();
  });
});
