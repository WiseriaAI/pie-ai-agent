import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { paths } from "./paths";
import { log } from "./log";
import { hasGrant, putGrant, permsHash, grantKey, type ScriptPerms } from "./grants";
import { appendAudit } from "./audit";

// Task 3 把这两个 interface 迁进 src/types/local-bridge.ts（共享源）后，改成
// `import type { RunSkillScriptParams, RunSkillScriptResult } from "../../src/types/local-bridge"`。
// 本 task 先本地定义以保持可独立编译/测试。
export interface RunSkillScriptParams {
  skillId: string;
  entry: string;
  code: string; // 扩展从已安装包解析；LLM 传不了
  perms: ScriptPerms;
  input: unknown;
  grantApproved?: boolean;
}
export interface RunSkillScriptResult {
  output: string; // 脚本返回值 JSON string；<untrusted_skill_content> 包裹在扩展侧做
  truncated?: boolean;
}

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface SkillExecDeps {
  spawn?: (
    argv: string[],
    cwd: string,
    env: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>;
  now?: () => number;
  skillsRoot?: string;
  grantsPath?: string;
  auditPath?: string;
}

/** skillId 来自扩展（已安装包 id），仍去路径分隔符防目录遍历。 */
export function sanitizeSkillId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// fs-only sandbox-exec profile：写限 skillDir 子树、网络全断、读放开（需读 pie
// 二进制+运行时+entry/input）、exec/fork 允许（bun self-spawn）。2c 才放网络。
export function buildSandboxProfile(skillDir: string): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${JSON.stringify(skillDir)}))`,
    "(deny network*)",
    "",
  ].join("\n");
}

// runner：读 entry+input 绝对路径 → 动态 import → 调 default(input) → stdout JSON。
export const RUNNER_SOURCE = `const [entryPath, inputPath] = process.argv.slice(2);
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const mod = await import(entryPath);
if (typeof mod.default !== "function") { console.error("script must export default a function"); process.exit(3); }
const out = await mod.default(input);
process.stdout.write(JSON.stringify(out === undefined ? null : out));
`;

// 真 spawn：BUN_BE_BUN=1 让编译后的 pie 二进制当 bun 跑 runner；60s 超时 kill、
// 增量读 stdout 到 1MB 上限即停+kill（防脚本在超时窗口内狂吐撑爆内存）。
// ponytail: 真隔离靠 sandbox-exec，本函数只管进程生命周期+读上限；真 spawn 不
// 单测（注入 fake），走真机清单。
const realSkillSpawn: NonNullable<SkillExecDeps["spawn"]> = async (argv, cwd, env) => {
  const proc = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  // 必须并发排空 stdout 和 stderr（同 src/spawn.ts 的教训）：只顺序读 stdout 会让
  // stderr 管道（OS 缓冲区 ~64KB）写满后阻塞子进程，子进程卡住不退出，读 stdout
  // 的循环也就卡住，直到 60s 超时才误判成 timeout（脚本本身可能早跑完了）。
  const stderrPromise = new Response(proc.stderr).text();
  try {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let stdout = "";
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += dec.decode(value, { stream: true });
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
        proc.kill();
        break;
      }
    }
    const stderr = await stderrPromise;
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode, timedOut, truncated };
  } finally {
    clearTimeout(timer);
  }
};

export async function runSkillScript(
  params: RunSkillScriptParams,
  deps: SkillExecDeps = {},
): Promise<RunSkillScriptResult> {
  // 2b 防御性：sandbox-exec 做不到 per-domain，network 一律不在 2b 执行（→ 2c）。
  if (params.perms.network.length > 0) {
    throw Object.assign(new Error("network capability not supported yet (Slice 2c)"), {
      code: "network_not_supported",
    });
  }
  const now = deps.now ?? Date.now;
  const skillsRoot = deps.skillsRoot ?? paths.skillsDir;
  const grantsPath = deps.grantsPath ?? paths.grantsPath;
  const auditPath = deps.auditPath ?? paths.auditPath;
  const skillDir = join(skillsRoot, sanitizeSkillId(params.skillId));

  // grant 门禁：miss + 未批准 → needs_authorization（零副作用）；批准 → 写 grant。
  if (!hasGrant(params.skillId, params.perms, params.code, grantsPath)) {
    if (!params.grantApproved) {
      throw Object.assign(new Error("authorization required"), { code: "needs_authorization" });
    }
    putGrant(
      {
        key: grantKey(params.skillId, permsHash(params.perms, params.code)),
        skillId: params.skillId,
        entry: params.entry,
        perms: params.perms,
        grantedAt: now(),
      },
      grantsPath,
    );
  }

  const startedAt = now();
  const workspace = join(skillDir, "workspace");
  const runDir = join(skillDir, ".runs", String(startedAt));
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const entryPath = join(runDir, "entry.mjs");
  const inputPath = join(runDir, "input.json");
  const runnerPath = join(runDir, "runner.mjs");
  const profilePath = join(runDir, "profile.sb");
  writeFileSync(entryPath, params.code);
  writeFileSync(inputPath, JSON.stringify(params.input ?? null));
  writeFileSync(runnerPath, RUNNER_SOURCE);
  writeFileSync(profilePath, buildSandboxProfile(skillDir));

  const argv = ["sandbox-exec", "-f", profilePath, process.execPath, "run", runnerPath, entryPath, inputPath];
  const env = { BUN_BE_BUN: "1", TMPDIR: runDir }; // bun 临时/缓存进沙箱可写区
  const spawn = deps.spawn ?? realSkillSpawn;
  log("info", "skill.spawn", { skillId: params.skillId, entry: params.entry });

  let res;
  try {
    res = await spawn(argv, workspace, env);
  } finally {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* scratch cleanup best-effort */
    }
  }

  appendAudit(
    {
      ts: now(),
      skillId: params.skillId,
      entry: params.entry,
      perms: params.perms,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      truncated: res.truncated,
      ms: now() - startedAt,
    },
    auditPath,
  );

  if (res.timedOut) {
    throw Object.assign(new Error(`skill script timed out after ${TIMEOUT_MS}ms`), { code: "timeout" });
  }
  if (res.exitCode !== 0) {
    throw Object.assign(new Error(`skill script exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`), {
      code: "script_error",
    });
  }
  return { output: res.stdout, truncated: res.truncated || undefined };
}
