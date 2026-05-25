import { describe, it, expect, beforeEach, vi } from "vitest";
import { BUILT_IN_TOOLS } from "../../lib/agent/tools";
import {
  recordFrameVersion,
  resetRegistry,
} from "../../lib/agent/tools/page-version-registry";

const clickTool = BUILT_IN_TOOLS.find((t) => t.name === "click")!;

describe("write-tool stale detection", () => {
  beforeEach(() => {
    resetRegistry();
    vi.restoreAllMocks();
  });

  it("expectedFrameVersion 不匹配返回 frameVersionMismatch", async () => {
    recordFrameVersion(7, 0, 50);
    const ctx = { tabId: 7 } as any;
    const r = await clickTool.handler(
      { frameId: 0, elementIndex: 3, expectedFrameVersion: 42 },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/frameVersionMismatch/);
  });

  it("frame 不在 registry 返回 frameGone", async () => {
    const ctx = { tabId: 7 } as any;
    const r = await clickTool.handler(
      { frameId: 99, elementIndex: 0, expectedFrameVersion: 1 },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/frameGone/);
  });

  it("缺 expectedFrameVersion 参数被 JSON schema 拒（required）", () => {
    expect(clickTool.parameters.required).toContain("expectedFrameVersion");
  });
});
