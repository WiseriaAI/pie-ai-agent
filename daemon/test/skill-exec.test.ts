import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { runSkillScript, expandTilde } from "../src/skill-exec";
import { fakeSkillSandbox } from "../src/skill-sandbox";
import { hasGrant, listGrants, envelopeHash } from "../src/grants";
import type { SandboxSettings } from "../src/skill-sandbox";
import { setLogEnabled } from "../src/log";
import type { SkillAuthPayload } from "../../src/types/local-bridge";

setLogEnabled(false);

function fixture() {
  const base = join(import.meta.dir, ".tmp-exec-" + Math.random().toString(36).slice(2));
  const skillsRoot = join(base, "skills");
  const dir = join(skillsRoot, "web-fetch");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n    write: [~/out]\n---\nb\n`,
  );
  writeFileSync(join(dir, "scripts", "fetch.ts"), "export default () => 1;");
  return { base, skillsRoot, grantsPath: join(base, "grants.json"), auditPath: join(base, "audit.jsonl") };
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
    runSkillScript({ name: "web-fetch", entry: "fetch.ts" }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  expect(ran).toBe(false);
  expect(hasGrant("web-fetch", { allowedDomains: ["example.com"], extraWrites: ["~/out"], runnableScripts: ["fetch.ts"] }, f.grantsPath)).toBe(false);
  rmSync(f.base, { recursive: true, force: true });
});

test("approved → writes grant, runs with baseline+declared settings, returns stdout", async () => {
  const f = fixture();
  let seen: SandboxSettings | undefined;
  const sandbox = fakeSkillSandbox(async (_argv, _cwd, _env, settings) => { seen = settings; return { stdout: "RESULT", stderr: "", exitCode: 0, timedOut: false, truncated: false }; });
  const r = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
    { sandbox, now: () => 1, ...f },
  );
  expect(r.output).toBe("RESULT");
  expect(seen!.allowedDomains).toEqual(["example.com"]);
  expect(seen!.allowWrite.some((w) => w.endsWith("/web-fetch/workspace"))).toBe(true);
  expect(seen!.allowWrite).toContain(expandTilde("~/out"));
  expect(seen!.denyRead.some((d) => d.endsWith("/.ssh"))).toBe(true);
  rmSync(f.base, { recursive: true, force: true });
});

test("second run after grant → no re-prompt", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "x", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
    { sandbox, now: () => 1, ...f },
  );
  const r = await runSkillScript({ name: "web-fetch", entry: "fetch.ts" }, { sandbox, now: () => 2, ...f }); // 无 grantApproved 也不弹
  expect(r.output).toBe("x");
  rmSync(f.base, { recursive: true, force: true });
});

test("entry not in scripts/ → unknown_entry (before any grant/run)", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  await expect(
    runSkillScript({ name: "web-fetch", entry: "../../etc/passwd", grantApproved: true }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "unknown_entry" });
  rmSync(f.base, { recursive: true, force: true });
});

test("script non-zero exit → script_error with stderr tail", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false, truncated: false }));
  await expect(
    runSkillScript(
      { name: "web-fetch", entry: "fetch.ts", grantApproved: true, approvedEnvelopeHash: WEB_FETCH_ENVELOPE_HASH },
      { sandbox, now: () => 1, ...f },
    ),
  ).rejects.toMatchObject({ code: "script_error" });
  rmSync(f.base, { recursive: true, force: true });
});

test("needs_authorization error carries SkillAuthPayload with canonical envelope + hash", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  try {
    await runSkillScript({ name: "web-fetch", entry: "fetch.ts" }, { sandbox, now: () => 1, ...f });
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
    runSkillScript({ name: "web-fetch", entry: "fetch.ts", grantApproved: true }, { sandbox, now: () => 1, ...f }),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  await expect(
    runSkillScript(
      { name: "web-fetch", entry: "fetch.ts", grantApproved: true, approvedEnvelopeHash: "0".repeat(32) },
      { sandbox, now: () => 1, ...f },
    ),
  ).rejects.toMatchObject({ code: "needs_authorization" });
  expect(listGrants(f.grantsPath)).toHaveLength(0);
  rmSync(f.base, { recursive: true, force: true });
});

test("grantApproved with correct hash writes grant and runs", async () => {
  const f = fixture();
  const sandbox = fakeSkillSandbox(async () => ({ stdout: "RESULT", stderr: "", exitCode: 0, timedOut: false, truncated: false }));
  const payload = await runSkillScript({ name: "web-fetch", entry: "fetch.ts" }, { sandbox, now: () => 1, ...f }).catch(
    (e) => (e as { data?: SkillAuthPayload }).data,
  );
  const res = await runSkillScript(
    { name: "web-fetch", entry: "fetch.ts", grantApproved: true, approvedEnvelopeHash: payload!.envelopeHash },
    { sandbox, now: () => 1, ...f },
  );
  expect(res.output).toBeDefined();
  expect(listGrants(f.grantsPath)).toHaveLength(1);
  rmSync(f.base, { recursive: true, force: true });
});
