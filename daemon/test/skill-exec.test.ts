import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, existsSync } from "fs";
import { buildSandboxProfile, RUNNER_SOURCE, runSkillScript, sanitizeSkillId } from "../src/skill-exec";
import type { SkillExecDeps } from "../src/skill-exec";
import { putGrant, grantKey, permsHash, type ScriptPerms } from "../src/grants";
import { setLogEnabled } from "../src/log";

setLogEnabled(false); // hermetic：不让 runSkillScript 的 log 写真实 ~/.pie/logs

const FS: ScriptPerms = { fs: true, network: [] };
function tmpRoot() {
  const base = mkdtempSync(join(tmpdir(), "pie-exec-"));
  return { skillsRoot: join(base, "skills"), grantsPath: join(base, "grants.json"), auditPath: join(base, "audit.jsonl") };
}
function fakeSpawn(result: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>) {
  const calls: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const spawn: NonNullable<SkillExecDeps["spawn"]> = async (argv, cwd, env) => {
    calls.push({ argv, cwd, env });
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, ...result };
  };
  return { spawn, calls };
}
const P = (over = {}) => ({ skillId: "csv", entry: "scripts/a.js", code: "export default (i) => i", perms: FS, input: { a: 1 }, ...over });

test("buildSandboxProfile：fs 写限 skillDir、网络全断", () => {
  const prof = buildSandboxProfile("/home/u/.pie/skills/csv");
  expect(prof).toContain("(deny default)");
  expect(prof).toContain('(allow file-write* (subpath "/home/u/.pie/skills/csv"))');
  expect(prof).toContain("(deny network*)");
  expect(prof).toContain("(allow process-exec)");
});

test("RUNNER_SOURCE 调 default(input) 出 JSON", () => {
  expect(RUNNER_SOURCE).toContain("mod.default");
  expect(RUNNER_SOURCE).toContain("process.stdout.write");
});

test("network 声明 → network_not_supported（2b 防御性拒）", async () => {
  const { spawn, calls } = fakeSpawn({});
  const t = tmpRoot();
  await expect(
    runSkillScript(P({ perms: { fs: true, network: ["x.com"] } }), { spawn, ...t }),
  ).rejects.toMatchObject({ code: "network_not_supported" });
  expect(calls).toHaveLength(0); // 没到 spawn
});

test("无 grant 且未批准 → needs_authorization，零副作用", async () => {
  const { spawn, calls } = fakeSpawn({});
  const t = tmpRoot();
  await expect(runSkillScript(P(), { spawn, ...t })).rejects.toMatchObject({ code: "needs_authorization" });
  expect(calls).toHaveLength(0);
  expect(existsSync(t.grantsPath)).toBe(false); // 没写 grant
});

test("grantApproved → 写 grant + spawn；argv/env/cwd 正确", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: '{"a":1}' });
  const t = tmpRoot();
  const r = await runSkillScript(P({ grantApproved: true }), { spawn, now: () => 5000, ...t });
  expect(r.output).toBe('{"a":1}');
  // grant 落盘
  const { listGrants } = await import("../src/grants");
  expect(listGrants(t.grantsPath).map((g) => g.skillId)).toEqual(["csv"]);
  // argv: sandbox-exec -f <profile> <pieBin> run <runner> <entry> <input>
  const c = calls[0];
  expect(c.argv[0]).toBe("sandbox-exec");
  expect(c.argv[1]).toBe("-f");
  expect(c.argv).toContain("run");
  expect(c.env.BUN_BE_BUN).toBe("1");
  expect(c.cwd).toContain(join("skills", "csv", "workspace"));
});

test("已有 grant → 不需 grantApproved 直接跑", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: "null" });
  const t = tmpRoot();
  const code = "export default (i) => i";
  putGrant({ key: grantKey("csv", permsHash(FS, code)), skillId: "csv", entry: "scripts/a.js", perms: FS, grantedAt: 1 }, t.grantsPath);
  const r = await runSkillScript(P({ code }), { spawn, ...t });
  expect(r.output).toBe("null");
  expect(calls).toHaveLength(1);
});

test("timedOut → code:timeout；非零 exit → code:script_error（带 stderr 尾）", async () => {
  const t = tmpRoot();
  const g = (code: string) => putGrant({ key: grantKey("csv", permsHash(FS, code)), skillId: "csv", entry: "a", perms: FS, grantedAt: 1 }, t.grantsPath);
  g("export default (i) => i");
  await expect(
    runSkillScript(P({ grantApproved: true }), { spawn: fakeSpawn({ timedOut: true, exitCode: 143 }).spawn, ...t }),
  ).rejects.toMatchObject({ code: "timeout" });
  await expect(
    runSkillScript(P({ grantApproved: true }), { spawn: fakeSpawn({ exitCode: 1, stderr: "boom" }).spawn, ...t }),
  ).rejects.toMatchObject({ code: "script_error" });
});

test("truncated 标记透传", async () => {
  const { spawn } = fakeSpawn({ stdout: "x".repeat(10), truncated: true });
  const t = tmpRoot();
  const r = await runSkillScript(P({ grantApproved: true }), { spawn, ...t });
  expect(r.truncated).toBe(true);
});

test("sanitizeSkillId 去路径分隔符（防遍历）", () => {
  expect(sanitizeSkillId("../../etc")).not.toContain("/");
  expect(sanitizeSkillId("csv-utils")).toBe("csv-utils");
});

test("audit 落盘一行 JSON", async () => {
  const { spawn } = fakeSpawn({ stdout: "1" });
  const t = tmpRoot();
  await runSkillScript(P({ grantApproved: true }), { spawn, ...t });
  const lines = require("fs").readFileSync(t.auditPath, "utf8").trim().split("\n");
  expect(JSON.parse(lines[0]).skillId).toBe("csv");
});
