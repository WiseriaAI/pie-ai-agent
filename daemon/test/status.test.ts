import { describe, expect, test } from "bun:test";
import { markExtensionSocket, dropSocket, beginSkillRun, endSkillRun, getStatus } from "../src/status";
import { handleMessage } from "../src/daemon";

describe("status", () => {
  test("extensionConnected 随 mark/drop 翻转", () => {
    const s = {};
    expect(getStatus().extensionConnected).toBe(false);
    markExtensionSocket(s);
    expect(getStatus().extensionConnected).toBe(true);
    dropSocket(s);
    expect(getStatus().extensionConnected).toBe(false);
  });

  test("runningSkills 随 begin/end 增减", () => {
    expect(getStatus().runningSkills).toEqual([]);
    const id = beginSkillRun("demo", "fetch.ts");
    expect(getStatus().runningSkills).toEqual([{ name: "demo", startedAt: expect.any(Number) }]);
    endSkillRun(id);
    expect(getStatus().runningSkills).toEqual([]);
  });

  test("status RPC 走 handleMessage", async () => {
    const res = JSON.parse(await handleMessage(JSON.stringify({ id: "1", method: "status", params: {} })));
    expect(res.ok).toBe(true);
    expect(res.result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof res.result.uptimeSec).toBe("number");
    expect(typeof res.result.extensionConnected).toBe("boolean");
    expect(Array.isArray(res.result.runningSkills)).toBe(true);
  });
});
