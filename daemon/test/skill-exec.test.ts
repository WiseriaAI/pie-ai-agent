import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from "fs";
import { join } from "path";
import { runSkillScript, expandTilde, scanOutputs } from "../src/skill-exec";
import { fakeSkillSandbox } from "../src/skill-sandbox";
import { hasGrant, listGrants, envelopeHash } from "../src/grants";
import type { SandboxSettings } from "../src/skill-sandbox";
import { setLogEnabled } from "../src/log";
import type { SkillAuthPayload } from "../../src/types/local-bridge";

setLogEnabled(false);

// 固定 UUID 形状 sessionId（assertSessionId 要求）。
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fixture() {
  const base = join(import.meta.dir, ".tmp-exec-" + Math.random().toString(36).slice(2));
  const skillsRoot = join(base, "skills");
  const sessionsDir = join(base, "sessions");
  const dir = join(skillsRoot, "web-fetch");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n    write: [~/out]\n---\nb\n`,
  );
  writeFileSync(join(dir, "scripts", "fetch.ts"), "export default () => 1;");
  return {
    base,
    skillsRoot,
    sessionsDir,
    grantsPath: join(base, "grants.json"),
    auditPath: join(base, "audit.jsonl"),
  };
}

// web-fetch 声明的 envelope hash（固定 fixture，跨用例复用而非每次现算）。
const WEB_FETCH_ENVELOPE_HASH = envelopeHash({
  allowedDomains: ["example.com"],
  extraWrites: ["~/out"],
  runnableScripts: ["fetch.ts"],
});

test("ungranted + no approval → needs_authorization, no grant written, no run", async () => {
  const f = fixture();
  let ran = false;
  const sandbox = fakeSkillSandbox(async () => { ran = true; return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }; });
  await expect(
    runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  expect(ran).toBe(false);
  expect(hasGrant("web-fetch", { allowedDomains: ["example.com"], extraWrites: ["~/out"], runnableScripts: ["fetch.ts"] }, f.grantsPath)).toBe(false);
  rmSync(f.base, { recursive: true, force: true });
});

test("approved → writes grant, runs with baseline+declared settings, returns stdout", async () => {
  const f = fixture();
  let seen: SandboxSettings | undefined;
  let seenCwd: string | undefined;
  let seenEnv: Record<string, string> | undefined;
  const sandbox = fakeSkillSandbox(async (_argv, cwd, env, settings) => {
    seen = settings;
    seenCwd = cwd;
    seenEnv = env;
    return { stdout: "RESULT", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
    { sandbox, now: () => 1, ...f },
  );
  expect(r.output).toBe("RESULT");
  expect(seen!.allowedDomains).toEqual(["example.com"]);
  // 可写区 = session workspace（迁出 skill 目录，按 session 隔离）
  expect(seen!.allowWrite.some((w) => w.endsWith(join(SID, "workspace")))).toBe(true);
  // 不再往 skill 目录写
  expect(seen!.allowWrite.some((w) => w.endsWith("/web-fetch/workspace"))).toBe(false);
  expect(seen!.allowWrite).toContain(expandTilde("~/out"));
  expect(seen!.denyRead.some((d) => d.endsWith("/.ssh"))).toBe(true);
  // cwd = workspace；env 注入 PIE_SKILL_DIR / PIE_WORKSPACE
  expect(seenCwd!.endsWith(join(SID, "workspace"))).toBe(true);
  expect(seenEnv!.PIE_WORKSPACE).toBe(seenCwd!);
  expect(seenEnv!.PIE_SKILL_DIR!.endsWith("/web-fetch")).toBe(true);
  expect(seenEnv!.BUN_BE_BUN).toBe("1");
  rmSync(f.base, { recursive: true, force: true });
});

test("second run after grant → no re-prompt", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "x", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
    { sandbox, now: () => 1, ...f },
  );
  const r = await runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 2, ...f }); // 无 grantApproved 也不弹
  expect(r.output).toBe("x");
  rmSync(f.base, { recursive: true, force: true });
});

test("entry not in scripts/ → unknown_entry (before any grant/run)", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "../../etc/passwd", sessionId: SID, grantApproved: true }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "unknown_entry" });
  rmSync(f.base, { recursive: true, force: true });
});

test("script non-zero exit → script_error with stderr tail", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false, truncated: false }));
  await expect(
    runSkillScript(
      { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
      { sandbox, now: () => 1, ...f },
    ),
  ).rejects.toMatchObject({ code: "script_error" });
  rmSync(f.base, { recursive: true, force: true });
});

test("needs_authorization error carries SkillAuthPayload with canonical envelope + hash", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  try {
    await runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 1, ...f });
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as { code?: string }).code).toBe("needs_authorization");
    const data = (e as { data?: SkillAuthPayload }).data;
    expect(data?.skillName).toBe("web-fetch");
    expect(data?.description).toBeTruthy();
    expect(data?.envelope.runnableScripts).toContain("fetch.ts");
    expect(data?.envelopeHash).toMatch(/^[0-9a-f]{32}$/);
  }
  rmSync(f.base, { recursive: true, force: true });
});

test("grantApproved without matching approvedEnvelopeHash → needs_authorization again, no grant written", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  await expect(
    runSkillScript(
      { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: "0".repeat(32) },
      { sandbox, now: () => 1, ...f },
    ),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  expect(listGrants(f.grantsPath)).toHaveLength(0);
  rmSync(f.base, { recursive: true, force: true });
});

test("grantApproved with correct hash writes grant and runs", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "RESULT", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  const payload = await runSkillScript({ name: "web-fetch", entry: "fetch.ts", sessionId: SID }, { sandbox, now: () => 1, ...f }).catch(
    (e) => (e as { data?: SkillAuthPayload }).data,
  );
  const res = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: payload!.envelopeHash },
    { sandbox, now: () => 1, ...f },
  );
  expect(res.output).toBeDefined();
  expect(listGrants(f.grantsPath)).toHaveLength(1);
  rmSync(f.base, { recursive: true, force: true });
});

// ── 副根污染修复（spec §1.2 / I1）：跑副根 skill 脚本 → 副根目录零写入 ──────────
test("secondary-root skill run → zero writes into the secondary skill dir", async () => {
  const base = join(import.meta.dir, ".tmp-sec-" + Math.random().toString(36).slice(2));
  const primary = join(base, "pie-skills"); // 空主根
  const secondary = join(base, "agents-skills");
  const sessionsDir = join(base, "sessions");
  const skillDir = join(secondary, "web-fetch");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n    write: [~/out]\n---\nb\n`,
  );
  writeFileSync(join(skillDir, "scripts", "fetch.ts"), "export default () => 1;");
  const before = readdirSync(skillDir).sort();

  // 沙箱模拟脚本往 cwd（= workspace）写文件；若 cwd 仍是 skillDir，副根会被污染。
  const sandbox = fakeSkillSandbox(async (_argv, cwd) => {
    writeFileSync(join(cwd, "out.csv"), "x");
    return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
    { sandbox, now: () => 1, roots: { primary, secondary }, sessionsDir, grantsPath: join(base, "g.json"), auditPath: join(base, "a.jsonl") },
  );

  // 副根 skill 目录内容完全不变；尤其没有 workspace/
  expect(readdirSync(skillDir).sort()).toEqual(before);
  expect(existsSync(join(skillDir, "workspace"))).toBe(false);
  // 产物落在 session workspace
  expect(existsSync(join(sessionsDir, SID, "workspace", "out.csv"))).toBe(true);
  rmSync(base, { recursive: true, force: true });
});

// ── outputs 清单（spec D5 / T2.3）────────────────────────────────────────────
test("run returns outputs manifest for files written this run", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async (_argv, cwd) => {
    writeFileSync(join(cwd, "out.csv"), "hello"); // 5 bytes
    mkdirSync(join(cwd, "sub"), { recursive: true });
    writeFileSync(join(cwd, "sub", "raw.json"), "{}"); // 2 bytes
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  });
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", sessionId: SID, grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
    { sandbox, now: () => 1, ...f },
  );
  const byPath = Object.fromEntries((r.outputs ?? []).map((o) => [o.path, o.bytes]));
  expect(byPath["out.csv"]).toBe(5);
  expect(byPath[join("sub", "raw.json")]).toBe(2);
  expect(r.outputsTruncated).toBeUndefined();
  rmSync(f.base, { recursive: true, force: true });
});

test("scanOutputs: mtime filter lists only files touched this run", () => {
  const base = join(import.meta.dir, ".tmp-scan-" + Math.random().toString(36).slice(2));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "old.txt"), "old");
  writeFileSync(join(ws, "new.txt"), "new");
  // old.txt 的 mtime 回拨到 1000s；startedAt=2000_000ms 介于两者之间。
  utimesSync(join(ws, "old.txt"), 1000, 1000);
  const { outputs, truncated } = scanOutputs(ws, 2_000_000);
  expect(outputs.map((o) => o.path)).toEqual(["new.txt"]);
  expect(truncated).toBe(false);
  rmSync(base, { recursive: true, force: true });
});

test("scanOutputs: caps at 50 files and sets truncated", () => {
  const base = join(import.meta.dir, ".tmp-cap-" + Math.random().toString(36).slice(2));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(ws, `f${i}.txt`), "x");
  const { outputs, truncated } = scanOutputs(ws, 0);
  expect(outputs).toHaveLength(50);
  expect(truncated).toBe(true);
  rmSync(base, { recursive: true, force: true });
});

test("scanOutputs: missing workspace → empty, not throw", () => {
  const { outputs, truncated } = scanOutputs(join(import.meta.dir, "does-not-exist-xyz"), 0);
  expect(outputs).toEqual([]);
  expect(truncated).toBe(false);
});
