// src/__tests__/cross-layer/click-cdp-failure-modes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildClickTool, type MouseToolDeps } from "@/lib/agent/tools/mouse";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import { _resetForTests } from "@/lib/idb/db";
import type { CdpSession } from "@/background/cdp-session";

vi.mock("@/lib/dom-actions/geometry", () => ({
  elementToPagePoint: vi.fn(),
}));

import { elementToPagePoint } from "@/lib/dom-actions/geometry";

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
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as typeof chrome.webNavigation,
  } as unknown as typeof chrome;
});

function deps(overrides?: Partial<MouseToolDeps>): MouseToolDeps {
  return {
    acquireSession: vi.fn().mockResolvedValue(fakeSession()),
    sessionId: "S1",
    requestConsent: async () => true,
    ...overrides,
  };
}

describe("click CDP failure modes — error message templates", () => {
  it("element-not-found wording matches template", async () => {
    await setCdpInputEnabled(true);
    vi.mocked(elementToPagePoint).mockResolvedValue({ kind: "element-not-found", index: 9 });
    const tool = buildClickTool(deps());
    const r = await tool.handler({ frameId: 0, elementIndex: 9 }, { tabId: 7 });
    expect(r).toMatchObject({
      success: false,
      error: expect.stringMatching(/Element not found at index 9.*call read_page/i),
    });
  });

  it("element-not-visible wording matches template", async () => {
    await setCdpInputEnabled(true);
    vi.mocked(elementToPagePoint).mockResolvedValue({ kind: "element-not-visible", index: 5 });
    const tool = buildClickTool(deps());
    const r = await tool.handler({ frameId: 0, elementIndex: 5 }, { tabId: 7 });
    expect(r).toMatchObject({
      success: false,
      error: expect.stringMatching(/Element \[5\] has zero size/),
    });
  });

  it("declined-consent wording when flag=false and user declines re-prompt", async () => {
    await setCdpInputEnabled(false);
    const tool = buildClickTool(deps({ requestConsent: async () => false }));
    const r = await tool.handler({ frameId: 0, elementIndex: 9 }, { tabId: 7 });
    expect(r).toMatchObject({
      success: false,
      error: expect.stringMatching(/declined|not enabled/i),
    });
  });

  it("cdp-attach-conflict wording when debugger conflict", async () => {
    await setCdpInputEnabled(true);
    const tool = buildClickTool(deps({
      acquireSession: vi.fn().mockRejectedValue(new Error("Another debugger is attached")),
    }));
    const r = await tool.handler({ frameId: 0, elementIndex: 9 }, { tabId: 7 });
    expect(r).toMatchObject({
      success: false,
      error: expect.stringMatching(/another debugger is attached/i),
    });
  });

  it("subframe path: vanished frame wording", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("No frame with id 21114 in tab 7"),
    );
    const tool = buildClickTool(deps());
    const result = await tool.handler({ frameId: 21114, elementIndex: 49 }, { tabId: 7 });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Frame 21114 unreachable or removed. Re-snapshot.");
  });

  it("onboarding-cancelled wording when consent throws", async () => {
    const tool = buildClickTool(deps({
      requestConsent: async () => { throw new Error("Onboarding cancelled (panel closed)"); },
    }));
    const r = await tool.handler({ frameId: 0, elementIndex: 9 }, { tabId: 7 });
    expect(r).toMatchObject({
      success: false,
      error: expect.stringMatching(/Onboarding cancelled \(panel closed\)/),
    });
  });
});
