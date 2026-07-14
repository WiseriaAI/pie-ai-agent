import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { paths } from "./paths";
import { log } from "./log";
import { assertSkillName, listSkills, resolveSkillRoot, defaultRoots } from "./skill-store";
import type { SkillRoots } from "./skill-store";
import { hasGrant, putGrant, grantKey, canonicalEnvelope, envelopeHash } from "./grants";
import { appendAudit } from "./audit";
import { beginSkillRun, endSkillRun } from "./status";
import { realSkillSandbox } from "./skill-sandbox";
import type { SkillSandbox } from "./skill-sandbox";
import type { GrantEnvelope, RunSkillScriptParams, RunSkillScriptResult, SkillAuthPayload } from "../../src/types/local-bridge";

export interface SkillExecDeps {
  sandbox?: SkillSandbox;
  now?: () => number;
  /** 单根别名（既有测试用）：等价 roots={primary: skillsRoot}，不带默认副根 */
  skillsRoot?: string;
  roots?: SkillRoots;
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
  const roots: SkillRoots = deps.roots ?? (deps.skillsRoot ? { primary: deps.skillsRoot } : defaultRoots);
  const grantsPath = deps.grantsPath ?? paths.grantsPath;
  const auditPath = deps.auditPath ?? paths.auditPath;
  const sandbox = deps.sandbox ?? realSkillSandbox;

  const name = assertSkillName(params.name);
  const located = resolveSkillRoot(name, roots);
  if (!located) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  const summary = listSkills(located.root).find((s) => s.name === name);
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
    const hash = envelopeHash(envelope);
    if (!params.grantApproved || params.approvedEnvelopeHash !== hash) {
      const data: SkillAuthPayload = {
        skillName: name,
        displayName: summary.displayName,
        description: summary.description,
        envelope,
        envelopeHash: hash,
      };
      throw Object.assign(new Error("authorization required"), {
        code: "needs_authorization",
        data,
      });
    }
    putGrant({ key: grantKey(name, envelope), skillName: name, envelope, grantedAt: now() }, grantsPath);
  }

  const skillDir = join(located.root, name);
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
  // 活跃执行注册表：顶栏 app 的 status RPC 据此显示「正在运行的 skill」。
  const runId = beginSkillRun(name, params.entry);
  let res;
  try {
    res = await sandbox.run(argv, skillDir, env, settings);
  } finally {
    endSkillRun(runId);
  }

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
