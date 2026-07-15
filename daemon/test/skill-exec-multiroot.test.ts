import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSkillScript } from "../src/skill-exec";
import { putGrant, grantKey, canonicalEnvelope } from "../src/grants";
import type { SkillSandbox } from "../src/skill-sandbox";

let primary: string;
let secondary: string;
let sessionsDir: string;
let grantsPath: string;
let auditPath: string;

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => {
  primary = mkdtempSync(join(tmpdir(), "pie-xmr-p-"));
  secondary = mkdtempSync(join(tmpdir(), "pie-xmr-s-"));
  const misc = mkdtempSync(join(tmpdir(), "pie-xmr-m-"));
  sessionsDir = join(misc, "sessions");
  grantsPath = join(misc, "grants.json");
  auditPath = join(misc, "audit.jsonl");
});
afterEach(() => {
  rmSync(primary, { recursive: true, force: true });
  rmSync(secondary, { recursive: true, force: true });
});

function putSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
  writeFileSync(join(dir, "scripts", "run.sh"), "echo ok");
}

function grantFor(name: string): void {
  const envelope = canonicalEnvelope({ allowedDomains: [], extraWrites: [], runnableScripts: ["run.sh"] });
  putGrant({ key: grantKey(name, envelope), skillName: name, envelope, grantedAt: 1 }, grantsPath);
}

test("副根 skill 可执行：argv 指向副根 script，cwd = session workspace，副根目录零写入", async () => {
  putSkill(secondary, "agentskill");
  grantFor("agentskill");
  const calls: { argv: string[]; cwd: string }[] = [];
  const sandbox: SkillSandbox = {
    run: async (argv, cwd) => {
      calls.push({ argv: argv as string[], cwd: cwd as string });
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    },
  };
  const res = await runSkillScript(
    { name: "agentskill", entry: "run.sh", sessionId: SID },
    { roots: { primary, secondary }, sessionsDir, grantsPath, auditPath, sandbox, now: () => 1 },
  );
  expect(res.output).toBe("ok");
  // cwd 迁到 session workspace（不再是副根 skill 目录）
  expect(calls[0].cwd).toBe(join(sessionsDir, SID, "workspace"));
  // 脚本路径仍解析到副根 script
  expect(calls[0].argv.join(" ")).toContain(join(secondary, "agentskill", "scripts", "run.sh"));
  // I1：副根 skill 目录不再被建 workspace/（副根污染修复）
  expect(existsSync(join(secondary, "agentskill", "workspace"))).toBe(false);
});

test("同名遮蔽：主根版本被执行", async () => {
  putSkill(primary, "dup");
  putSkill(secondary, "dup");
  grantFor("dup");
  const calls: { argv: string[] }[] = [];
  const sandbox: SkillSandbox = {
    run: async (argv) => {
      calls.push({ argv: argv as string[] });
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    },
  };
  await runSkillScript(
    { name: "dup", entry: "run.sh", sessionId: SID },
    { roots: { primary, secondary }, sessionsDir, grantsPath, auditPath, sandbox, now: () => 1 },
  );
  // primary 版本被执行：其 scripts/run.sh 进 argv（cwd 一律是 session workspace，不再能区分根）
  expect(calls[0].argv.join(" ")).toContain(join(primary, "dup", "scripts", "run.sh"));
});

test("两根都无 → unknown_skill", async () => {
  let err: unknown;
  try {
    await runSkillScript(
      { name: "ghost", entry: "run.sh", sessionId: SID },
      { roots: { primary, secondary }, sessionsDir, grantsPath, auditPath, now: () => 1 },
    );
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).toBe("unknown_skill");
});
