// src/lib/skills/panel-actions.test.ts
//
// Task 8 — panel-side skills RPC client. Sibling to
// src/lib/schedules/panel-actions.test.ts: same swPort.request →
// chrome.runtime.sendMessage plumbing, so the same "undefined response" /
// "sendMessage rejects" / "forwards success" cases apply, plus one assertion
// per wrapper that it builds the expected { type, action, payload } message.

import { describe, it, expect, vi, afterEach } from "vitest";
import { listSkillEntries, readSkillFileRpc, writeSkillRpc, deleteSkillRpc } from "./panel-actions";

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

describe("skills panel-actions", () => {
  it("returns { ok:false } when the SW responds with undefined", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    };
    const res = await listSkillEntries();
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/no response/i);
  });

  it("returns { ok:false } when sendMessage rejects", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage: vi.fn().mockRejectedValue(new Error("port closed")) },
    };
    const res = await listSkillEntries();
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/port closed/i);
  });

  it("listSkillEntries sends { type, action:'list' } and forwards success", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, skills: [] });
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage } };
    const res = await listSkillEntries();
    expect(res).toEqual({ ok: true, skills: [] });
    expect(sendMessage).toHaveBeenCalledWith({ type: "skills-action", action: "list" });
  });

  it("readSkillFileRpc sends { id, path } payload and forwards success", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, content: "hi" });
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage } };
    const res = await readSkillFileRpc("s1", "SKILL.md");
    expect(res).toEqual({ ok: true, content: "hi" });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "skills-action",
      action: "read-file",
      payload: { id: "s1", path: "SKILL.md" },
    });
  });

  it("writeSkillRpc sends { id, files } payload and forwards success", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage } };
    const files = [{ path: "SKILL.md", content: "x" }];
    const res = await writeSkillRpc("s1", files);
    expect(res).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "skills-action",
      action: "write",
      payload: { id: "s1", files },
    });
  });

  it("deleteSkillRpc sends { id } payload and forwards success", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, deleted: true });
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage } };
    const res = await deleteSkillRpc("s1");
    expect(res).toEqual({ ok: true, deleted: true });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "skills-action",
      action: "delete",
      payload: { id: "s1" },
    });
  });
});
