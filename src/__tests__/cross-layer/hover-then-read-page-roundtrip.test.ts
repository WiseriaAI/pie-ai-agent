// src/__tests__/cross-layer/hover-then-read-page-roundtrip.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildHoverTool, type MouseToolDeps } from "@/lib/agent/tools/mouse";
import { setCdpInputEnabled } from "@/lib/cdp-input-enabled";
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
  const data: Record<string, unknown> = {};
  // @ts-expect-error mock
  global.chrome = {
    storage: { local: {
      get: vi.fn((k) => {
        const want = Array.isArray(k) ? k : [k];
        const out: Record<string, unknown> = {};
        for (const key of want) if (key in data) out[key] = data[key];
        return Promise.resolve(out);
      }),
      set: vi.fn((kv) => { Object.assign(data, kv); return Promise.resolve(); }),
      remove: vi.fn(() => Promise.resolve()),
    } },
  };
  await setCdpInputEnabled(true);
  vi.mocked(elementToPagePoint).mockResolvedValue({ x: 100, y: 200 });
});

describe("hover → observation guides agent to call read_page", () => {
  function makeDeps(session: CdpSession): MouseToolDeps {
    return {
      acquireSession: vi.fn().mockResolvedValue(session),
      sessionId: "S1",
      requestConsent: async () => true,
    };
  }

  it("returns observation that explicitly mentions read_page", async () => {
    const session = fakeSession();
    const tool = buildHoverTool(makeDeps(session));
    const result = await tool.handler(
      { frameId: 0, elementIndex: 3 },
      { tabId: 7 },
    );
    expect(result.success).toBe(true);
    expect(result.observation).toMatch(/read_page/i);
  });

  it("includes the element index in the observation", async () => {
    const session = fakeSession();
    const tool = buildHoverTool(makeDeps(session));
    const result = await tool.handler(
      { frameId: 0, elementIndex: 42 },
      { tabId: 7 },
    );
    expect(result.observation).toMatch(/\[42\]/);
  });

  it("dispatches a single mouseMoved event (not click sequence)", async () => {
    const session = fakeSession();
    const tool = buildHoverTool(makeDeps(session));
    await tool.handler({ frameId: 0, elementIndex: 3 }, { tabId: 7 });
    const sendMock = session.send as ReturnType<typeof vi.fn>;
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].type).toBe("mouseMoved");
  });
});
