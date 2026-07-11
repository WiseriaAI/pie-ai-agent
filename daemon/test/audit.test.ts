import { test, expect } from "bun:test";
import { mkdirSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import { appendAudit, readAuditTail } from "../src/audit";
import type { GrantEnvelope } from "../../src/types/local-bridge";

function tmpPath(): string {
  const dir = join(import.meta.dir, ".tmp-audit-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return join(dir, "audit.jsonl");
}

const EMPTY_ENV: GrantEnvelope = { allowedDomains: [], extraWrites: [], runnableScripts: [] };

test("readAuditTail returns newest-first tail, skipping corrupt lines, empty when file missing", () => {
  const path = tmpPath();
  expect(readAuditTail(20, path)).toEqual([]);
  for (let i = 0; i < 5; i++) {
    appendAudit({ ts: i, skillName: "s", entry: "e.ts", envelope: EMPTY_ENV, exitCode: 0, timedOut: false, truncated: false, ms: 1 }, path);
  }
  appendFileSync(path, "not json\n");
  const tail = readAuditTail(3, path);
  expect(tail.map((e) => e.ts)).toEqual([4, 3, 2]);
  rmSync(path, { force: true });
});

test("readAuditTail filters legacy-format lines (2b-era skillId/perms) that violate the wire type", () => {
  const path = tmpPath();
  appendAudit({ ts: 1, skillName: "s", entry: "e.ts", envelope: EMPTY_ENV, exitCode: 0, timedOut: false, truncated: false, ms: 1 }, path);
  // 真机 audit.jsonl 里的 2b 旧格式残留行：skillId/perms 而非 skillName/envelope
  appendFileSync(path, JSON.stringify({ ts: 2, skillId: "old", entry: "scripts/save.js", perms: { fs: true, network: [] }, exitCode: 0, timedOut: false, truncated: false, ms: 78 }) + "\n");
  appendAudit({ ts: 3, skillName: "s2", entry: "e2.ts", envelope: EMPTY_ENV, exitCode: 0, timedOut: false, truncated: false, ms: 1 }, path);
  expect(readAuditTail(20, path).map((e) => e.ts)).toEqual([3, 1]);
  rmSync(path, { force: true });
});

test("readAuditTail clamps an out-of-range limit to 200", () => {
  const path = tmpPath();
  for (let i = 0; i < 250; i++) {
    appendAudit({ ts: i, skillName: "s", entry: "e.ts", envelope: EMPTY_ENV, exitCode: 0, timedOut: false, truncated: false, ms: 1 }, path);
  }
  const tail = readAuditTail(99999, path);
  expect(tail.length).toBe(200);
  expect(tail[0].ts).toBe(249); // newest first
  expect(tail[199].ts).toBe(50);
  rmSync(path, { force: true });
});
