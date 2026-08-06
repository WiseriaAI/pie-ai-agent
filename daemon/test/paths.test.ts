import { test, expect } from "bun:test";
import { join, win32, posix } from "path";
import { paths, computePaths, assertSessionId, sessionWorkspace, PIPE_NAME } from "../src/paths";

test("skill_fs paths sit under ~/.pie", () => {
  expect(paths.skillsDir).toBe(join(paths.pieDir, "skills"));
  expect(paths.grantsPath).toBe(join(paths.pieDir, "grants.json"));
  expect(paths.auditPath).toBe(join(paths.pieDir, "logs", "audit.jsonl"));
  expect(paths.sessionsDir).toBe(join(paths.pieDir, "sessions"));
});

// ── computePaths: 平台分支（win32 形状可在 mac 上用 path.win32 直测）─────────────

test("computePaths(darwin): ~/.pie + unix socket file, isPipe=false", () => {
  const p = computePaths("darwin", "/Users/me");
  expect(p.pieDir).toBe("/Users/me/.pie");
  expect(p.ipcPath).toBe("/Users/me/.pie/daemon.sock");
  expect(p.socketPath).toBe(p.ipcPath); // 历史字段名 = ipcPath
  expect(p.isPipe).toBe(false);
  expect(p.skillsDir).toBe("/Users/me/.pie/skills");
  expect(p.agentsSkillsDir).toBe("/Users/me/.agents/skills");
  expect(p.sessionsDir).toBe("/Users/me/.pie/sessions");
  expect(p.grantsPath).toBe("/Users/me/.pie/grants.json");
  expect(p.auditPath).toBe("/Users/me/.pie/logs/audit.jsonl");
  expect(p.logsDir).toBe("/Users/me/.pie/logs");
  expect(p.handoffsDir).toBe("/Users/me/pie-handoffs");
});

test("computePaths(win32): %USERPROFILE%\\.pie + named pipe, isPipe=true", () => {
  const p = computePaths("win32", "C:\\Users\\me");
  expect(p.pieDir).toBe(win32.join("C:\\Users\\me", ".pie"));
  expect(p.ipcPath).toBe(`\\\\.\\pipe\\${PIPE_NAME}`);
  expect(p.socketPath).toBe(p.ipcPath);
  expect(p.isPipe).toBe(true);
  expect(p.skillsDir).toBe(win32.join("C:\\Users\\me", ".pie", "skills"));
  expect(p.agentsSkillsDir).toBe(win32.join("C:\\Users\\me", ".agents", "skills"));
  expect(p.sessionsDir).toBe(win32.join("C:\\Users\\me", ".pie", "sessions"));
  expect(p.grantsPath).toBe(win32.join("C:\\Users\\me", ".pie", "grants.json"));
  expect(p.auditPath).toBe(win32.join("C:\\Users\\me", ".pie", "logs", "audit.jsonl"));
  // 结构与 mac 同构，只是分隔符/根不同：目录名 sessions/skills/grants.json/logs 不变
  expect(p.pieDir.endsWith("\\.pie")).toBe(true);
  expect(p.ipcPath.startsWith("\\\\.\\pipe\\")).toBe(true);
});

test("computePaths: win32 IPC is a named pipe (no drive path), darwin is a file path", () => {
  const w = computePaths("win32", "C:\\Users\\me");
  const d = computePaths("darwin", "/Users/me");
  // named pipe 无磁盘残留 → 传输层清理/权限收敛应为 no-op（isPipe 守卫）
  expect(w.isPipe).toBe(true);
  expect(d.isPipe).toBe(false);
  // pipe 地址不含盘符路径，socket 地址是普通文件路径
  expect(w.ipcPath).not.toContain("C:");
  expect(posix.isAbsolute(d.ipcPath)).toBe(true);
});

const VALID_SID = "12345678-1234-4321-abcd-1234567890ab";

test("assertSessionId accepts a UUID-shaped id", () => {
  expect(assertSessionId(VALID_SID)).toBe(VALID_SID);
});

test("assertSessionId rejects traversal / absolute / empty / oversize / junk", () => {
  for (const bad of [
    "..",
    "../../etc",
    "/abs/path",
    "",
    "a".repeat(200),
    "not-a-uuid",
    "12345678-1234-4321-abcd-1234567890a", // one short
    "12345678/1234/4321/abcd/1234567890ab",
  ]) {
    expect(() => assertSessionId(bad)).toThrow();
  }
});

test("sessionWorkspace joins under sessions root with /workspace suffix", () => {
  expect(sessionWorkspace(VALID_SID, "/tmp/s")).toBe(join("/tmp/s", VALID_SID, "workspace"));
  expect(sessionWorkspace(VALID_SID)).toBe(join(paths.sessionsDir, VALID_SID, "workspace"));
});

test("sessionWorkspace rejects a bad session id", () => {
  expect(() => sessionWorkspace("../evil", "/tmp/s")).toThrow();
});
