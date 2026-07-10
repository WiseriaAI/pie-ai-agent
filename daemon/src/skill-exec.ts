import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { paths } from "./paths";
import { log } from "./log";
import { assertSkillName, listSkills } from "./skill-store";
import { hasGrant, putGrant, grantKey, canonicalEnvelope } from "./grants";
import { appendAudit } from "./audit";
import { realSkillSandbox } from "./skill-sandbox";
import type { SkillSandbox } from "./skill-sandbox";
import type { GrantEnvelope, RunSkillScriptParams, RunSkillScriptResult } from "../../src/types/local-bridge";

export interface SkillExecDeps {
  sandbox?: SkillSandbox;
  now?: () => number;
  skillsRoot?: string;
  grantsPath?: string;
  auditPath?: string;
}

export function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** 敏感目录默认拒读（write 类外泄面靠默认断网压制，这里挡直接读密钥）。 */
export function baselineDenyRead(): string[] {
  const h = homedir();
  return [
    join(h, ".ssh"),
    join(h, ".aws"),
    join(h, ".gnupg"),
    paths.grantsPath,
    paths.logsDir,
  ];
}

/** 解释器 argv 前缀：.ts/.js/.mjs → pie-as-bun；.py → python3；.sh → bash。 */
export function interpreterFor(entry: string): string[] {
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run"]; // 需 BUN_BE_BUN=1
  if (/\.py$/.test(entry)) return ["python3"];
  if (/\.sh$/.test(entry)) return ["bash"];
  return [process.execPath, "run"]; // 默认按 JS 跑
}

export async function runSkillScript(
  params: RunSkillScriptParams,
  deps: SkillExecDeps = {},
): Promise<RunSkillScriptResult> {
  const now = deps.now ?? Date.now;
  const skillsRoot = deps.skillsRoot ?? paths.skillsDir;
  const grantsPath = deps.grantsPath ?? paths.grantsPath;
  const auditPath = deps.auditPath ?? paths.auditPath;
  const sandbox = deps.sandbox ?? realSkillSandbox;

  const name = assertSkillName(params.name);
  const summary = listSkills(skillsRoot).find((s) => s.name === name);
  if (!summary) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  if (!summary.runnableScripts.includes(params.entry)) {
    throw Object.assign(new Error(`entry not in scripts/: ${JSON.stringify(params.entry)}`), { code: "unknown_entry" });
  }

  const envelope: GrantEnvelope = canonicalEnvelope({
    allowedDomains: summary.declaredCaps.network,
    extraWrites: summary.declaredCaps.write,
    runnableScripts: summary.runnableScripts,
  });

  if (!hasGrant(name, envelope, grantsPath)) {
    if (!params.grantApproved) {
      throw Object.assign(new Error("authorization required"), { code: "needs_authorization" });
    }
    putGrant({ key: grantKey(name, envelope), skillName: name, envelope, grantedAt: now() }, grantsPath);
  }

  const skillDir = join(skillsRoot, name);
  const workspace = join(skillDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  const settings = {
    allowWrite: [workspace, ...summary.declaredCaps.write.map(expandTilde)],
    allowedDomains: summary.declaredCaps.network,
    denyRead: baselineDenyRead(),
  };
  const argv = [...interpreterFor(params.entry), join(skillDir, "scripts", params.entry), ...(params.args ?? [])];
  const env = { BUN_BE_BUN: "1" };

  const startedAt = now();
  log("info", "skill.run", { name, entry: params.entry });
  const res = await sandbox.run(argv, skillDir, env, settings);

  appendAudit(
    { ts: now(), skillName: name, entry: params.entry, envelope, exitCode: res.exitCode, timedOut: res.timedOut, truncated: res.truncated, ms: now() - startedAt },
    auditPath,
  );

  if (res.timedOut) throw Object.assign(new Error("skill script timed out"), { code: "timeout" });
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(`skill script exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`), { code: "script_error" });
  }
  return { output: res.stdout, truncated: res.truncated || undefined };
}
