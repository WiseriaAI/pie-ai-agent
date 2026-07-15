import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSessionFile, deleteSessionWorkspace, sweepSessions } from "../src/skill-store";

const SID_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SID_B = "11111111-2222-4333-8444-555555555555";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pie-sess-"));
}

test("readSessionFile reads a product from its own session workspace", () => {
  const sessionsDir = tmp();
  const ws = join(sessionsDir, SID_A, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "out.csv"), "a,b,c");
  expect(readSessionFile(SID_A, "out.csv", sessionsDir)).toBe("a,b,c");
  rmSync(sessionsDir, { recursive: true, force: true });
});

test("readSessionFile rejects path traversal out of the workspace (I2)", () => {
  const sessionsDir = tmp();
  const ws = join(sessionsDir, SID_A, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(sessionsDir, SID_A, "secret.txt"), "nope"); // 出 workspace 一层
  expect(() => readSessionFile(SID_A, "../secret.txt", sessionsDir)).toThrow();
  expect(() => readSessionFile(SID_A, "../../../etc/passwd", sessionsDir)).toThrow();
  rmSync(sessionsDir, { recursive: true, force: true });
});

test("readSessionFile cannot reach another session's file", () => {
  const sessionsDir = tmp();
  const wsA = join(sessionsDir, SID_A, "workspace");
  mkdirSync(wsA, { recursive: true });
  writeFileSync(join(wsA, "out.csv"), "A-data");
  // session B 请求 → B 的 workspace 不存在 → throw（拼不到 A 的路径）
  expect(() => readSessionFile(SID_B, "out.csv", sessionsDir)).toThrow();
  rmSync(sessionsDir, { recursive: true, force: true });
});

test("readSessionFile rejects a non-uuid session id", () => {
  expect(() => readSessionFile("../evil", "x", tmp())).toThrow();
});

test("deleteSessionWorkspace removes the session dir, idempotent", () => {
  const sessionsDir = tmp();
  const ws = join(sessionsDir, SID_A, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "out.csv"), "x");
  expect(deleteSessionWorkspace(SID_A, sessionsDir)).toBe(true);
  expect(existsSync(join(sessionsDir, SID_A))).toBe(false);
  // 幂等：再删不存在的 → false，不抛
  expect(deleteSessionWorkspace(SID_A, sessionsDir)).toBe(false);
  rmSync(sessionsDir, { recursive: true, force: true });
});

test("sweepSessions removes only dirs older than the max age", () => {
  const sessionsDir = tmp();
  const fresh = join(sessionsDir, SID_A);
  const stale = join(sessionsDir, SID_B);
  mkdirSync(fresh, { recursive: true });
  mkdirSync(stale, { recursive: true });
  const now = 40 * 24 * 60 * 60 * 1000; // 40 天
  // stale 的 mtime 回拨到 0（>30 天前）；fresh 设为 now（刚建）
  utimesSync(stale, 0, 0);
  utimesSync(fresh, now / 1000, now / 1000);
  const removed = sweepSessions(now, 30 * 24 * 60 * 60 * 1000, sessionsDir);
  expect(removed).toBe(1);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  rmSync(sessionsDir, { recursive: true, force: true });
});

test("sweepSessions on a missing sessions dir → 0, no throw", () => {
  expect(sweepSessions(Date.now(), 1, join(tmpdir(), "pie-nope-xyz-abc"))).toBe(0);
});
