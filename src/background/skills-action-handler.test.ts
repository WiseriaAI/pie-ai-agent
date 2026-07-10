// src/background/skills-action-handler.test.ts
//
// Task 8 — SW-side handler for the panel skills RPC channel. skill-source and
// local-bridge are mocked: getActiveSkillSource() returns a fake in-memory
// source (no IDB / daemon plumbing needed), bridgeSettled is a controllable
// promise for the ordering assertion.

import { describe, it, expect, vi, beforeEach } from "vitest";

const listMock = vi.fn();
const readFileMock = vi.fn();
const writeMock = vi.fn();
const deleteMock = vi.fn();
const getActiveSkillSourceMock = vi.fn(() => ({
  mode: "idb" as const,
  list: listMock,
  readFile: readFileMock,
  write: writeMock,
  delete: deleteMock,
}));

let settledPromise: Promise<void> = Promise.resolve();

vi.mock("./skill-source", () => ({
  getActiveSkillSource: () => getActiveSkillSourceMock(),
}));
vi.mock("./local-bridge", () => ({
  bridgeSettled: () => settledPromise,
}));

import { handleSkillsAction } from "./skills-action-handler";

const FAKE_ENTRY = {
  id: "s1",
  name: "Skill One",
  description: "d",
  builtIn: false,
  origin: "idb" as const,
  files: ["SKILL.md"],
  runnableScripts: [],
};

// A "disabled-ish" looking entry — the handler has ZERO enabled/disabled
// filtering logic, so this must pass through list() completely untouched.
// (Enabled-filtering is the caller's job: Chat filters client-side, SkillsList
// wants the full list including disabled items.)
const DISABLED_LIKE_ENTRY = { ...FAKE_ENTRY, id: "s2-disabled", name: "Looks Disabled" };

beforeEach(() => {
  settledPromise = Promise.resolve();
  listMock.mockReset().mockResolvedValue([FAKE_ENTRY, DISABLED_LIKE_ENTRY]);
  readFileMock.mockReset().mockResolvedValue("file content");
  writeMock.mockReset().mockResolvedValue(undefined);
  deleteMock.mockReset().mockResolvedValue(true);
  getActiveSkillSourceMock.mockClear();
});

describe("handleSkillsAction", () => {
  it("list → ok:true + full merged list, no enabled filtering", async () => {
    const res = await handleSkillsAction({ type: "skills-action", action: "list" });
    expect(res).toEqual({ ok: true, skills: [FAKE_ENTRY, DISABLED_LIKE_ENTRY] });
  });

  it("read-file → ok:true + content", async () => {
    const res = await handleSkillsAction({
      type: "skills-action",
      action: "read-file",
      payload: { id: "s1", path: "SKILL.md" },
    });
    expect(res).toEqual({ ok: true, content: "file content" });
    expect(readFileMock).toHaveBeenCalledWith("s1", "SKILL.md");
  });

  it("write → ok:true", async () => {
    const files = [{ path: "SKILL.md", content: "---\nname: x\ndescription: y\n---\n" }];
    const res = await handleSkillsAction({
      type: "skills-action",
      action: "write",
      payload: { id: "s1", files },
    });
    expect(res).toEqual({ ok: true });
    expect(writeMock).toHaveBeenCalledWith("s1", files);
  });

  it("delete → ok:true + deleted", async () => {
    const res = await handleSkillsAction({
      type: "skills-action",
      action: "delete",
      payload: { id: "s1" },
    });
    expect(res).toEqual({ ok: true, deleted: true });
    expect(deleteMock).toHaveBeenCalledWith("s1");
  });

  it("source method throwing → { ok:false, error }", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    const res = await handleSkillsAction({ type: "skills-action", action: "list" });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toMatch(/boom/);
  });

  it("read-file malformed payload (missing path) → ok:false, never calls the source", async () => {
    const res = await handleSkillsAction({
      type: "skills-action",
      action: "read-file",
      payload: { id: "s1" },
    });
    expect(res.ok).toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("write malformed payload (files not an array) → ok:false, never calls the source", async () => {
    const res = await handleSkillsAction({
      type: "skills-action",
      action: "write",
      payload: { id: "s1", files: "nope" },
    });
    expect(res.ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("delete malformed payload (missing id) → ok:false, never calls the source", async () => {
    const res = await handleSkillsAction({ type: "skills-action", action: "delete", payload: {} });
    expect(res.ok).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("unknown action → ok:false, does not throw", async () => {
    const res = await handleSkillsAction({ type: "skills-action", action: "bogus" as never });
    expect(res.ok).toBe(false);
  });

  it("awaits bridgeSettled before touching the active source (cold-boot race guard)", async () => {
    let resolveSettled!: () => void;
    settledPromise = new Promise((r) => {
      resolveSettled = r;
    });

    const pending = handleSkillsAction({ type: "skills-action", action: "list" });
    // Bridge hasn't settled yet: source must not have been fetched. Flush a
    // few microtasks to give a buggy eager implementation a chance to show up.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getActiveSkillSourceMock).not.toHaveBeenCalled();

    resolveSettled();
    const res = await pending;
    expect(getActiveSkillSourceMock).toHaveBeenCalled();
    expect(res).toEqual({ ok: true, skills: [FAKE_ENTRY, DISABLED_LIKE_ENTRY] });
  });
});
