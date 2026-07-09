import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeScriptAllFrames } from "./inject-all-frames";

const frame = (frameId: number, url = `https://example.com/f${frameId}`) => ({
  frameId,
  url,
  parentFrameId: frameId === 0 ? -1 : 0,
  errorOccurred: false,
});

describe("executeScriptAllFrames", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("对每个 frame 逐一定向注入（frameIds + injectImmediately），结果按 frameId 关联", async () => {
    const executeScript = vi.fn().mockImplementation(async (opts: { target: { frameIds: number[] } }) => {
      const fid = opts.target.frameIds[0];
      return [{ frameId: fid, result: `r${fid}` }];
    });
    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([frame(0), frame(7)]) },
    });

    const out = await executeScriptAllFrames<string>(123, (() => "x") as () => string);

    expect(executeScript).toHaveBeenCalledTimes(2);
    for (const call of executeScript.mock.calls) {
      expect(call[0].target.tabId).toBe(123);
      expect(call[0].target.frameIds).toHaveLength(1);
      expect(call[0].injectImmediately).toBe(true);
      expect(call[0].target.allFrames).toBeUndefined();
    }
    expect(out.results).toEqual([
      { frameId: 0, result: "r0" },
      { frameId: 7, result: "r7" },
    ]);
    expect(out.frames.map((f) => f.frameId)).toEqual([0, 7]);
    expect(out.timedOutFrameIds.size).toBe(0);
  });

  it("args 原样透传给每次注入", async () => {
    const executeScript = vi.fn().mockImplementation(async (opts: { target: { frameIds: number[] } }) => [
      { frameId: opts.target.frameIds[0], result: "ok" },
    ]);
    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([frame(0)]) },
    });

    await executeScriptAllFrames(1, ((_: unknown) => "x") as (a: unknown) => string, [{ op: "atlas" }]);

    expect(executeScript.mock.calls[0][0].args).toEqual([{ op: "atlas" }]);
  });

  it("挂死的 frame 超时后记入 timedOutFrameIds，不拖垮其它 frame", async () => {
    const executeScript = vi.fn().mockImplementation((opts: { target: { frameIds: number[] } }) => {
      const fid = opts.target.frameIds[0];
      if (fid === 396) return new Promise(() => {}); // 永不 resolve（僵尸沙箱 frame）
      return Promise.resolve([{ frameId: fid, result: `r${fid}` }]);
    });
    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([frame(0), frame(396)]) },
    });

    const out = await executeScriptAllFrames<string>(1, (() => "x") as () => string, undefined, {
      subFrameTimeoutMs: 30,
      topFrameTimeoutMs: 30,
    });

    expect(out.results).toEqual([
      { frameId: 0, result: "r0" },
      { frameId: 396, result: undefined },
    ]);
    expect([...out.timedOutFrameIds]).toEqual([396]);
  });

  it("注入抛错的 frame 记为无结果但不算超时", async () => {
    const executeScript = vi.fn().mockImplementation((opts: { target: { frameIds: number[] } }) => {
      const fid = opts.target.frameIds[0];
      if (fid === 5) return Promise.reject(new Error("Frame with ID 5 was removed."));
      return Promise.resolve([{ frameId: fid, result: `r${fid}` }]);
    });
    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([frame(0), frame(5)]) },
    });

    const out = await executeScriptAllFrames<string>(1, (() => "x") as () => string);

    expect(out.results).toEqual([
      { frameId: 0, result: "r0" },
      { frameId: 5, result: undefined },
    ]);
    expect(out.timedOutFrameIds.size).toBe(0);
  });

  it("getAllFrames 返回 null（tab 不可用）时抛错", async () => {
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn() },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue(null) },
    });

    await expect(executeScriptAllFrames(1, (() => "x") as () => string)).rejects.toThrow("Tab unavailable");
  });
});
