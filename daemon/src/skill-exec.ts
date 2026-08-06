import { mkdirSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { paths, sessionWorkspace } from "./paths";
import { log } from "./log";
import { assertSkillName, listSkills, resolveSkillRoot, defaultRoots } from "./skill-store";
import type { SkillRoots } from "./skill-store";
import { hasGrant, putGrant, grantKey, canonicalEnvelope, envelopeHash } from "./grants";
import { appendAudit } from "./audit";
import { beginSkillRun, endSkillRun } from "./status";
import { realSkillSandbox, checkWindowsSandboxReady } from "./skill-sandbox";
import type { SkillSandbox } from "./skill-sandbox";
import type { GrantEnvelope, RunSkillScriptParams, RunSkillScriptResult, SkillAuthPayload } from "../../src/types/local-bridge";

export interface SkillExecDeps {
  sandbox?: SkillSandbox;
  now?: () => number;
  /** 沙箱设施就绪探针（F6）：非 win32 恒 ready；win32 走 WFP egress 行为探针。测试可注入。 */
  readinessCheck?: () => Promise<{ ready: boolean; reason?: string }>;
  /** 单根别名（既有测试用）：等价 roots={primary: skillsRoot}，不带默认副根 */
  skillsRoot?: string;
  roots?: SkillRoots;
  /** session workspace 根覆盖（测试隔离真实 ~/.pie/sessions） */
  sessionsDir?: string;
  grantsPath?: string;
  auditPath?: string;
}

/** 本次产物清单上限：脚本可能生成上千分片，无上限会撑爆 observation。 */
const OUTPUTS_CAP = 50;

/** run 后递归扫 workspace，收 mtime >= startedAt 的文件（本次产物），path 相对 workspace 根。
 *  封顶 OUTPUTS_CAP，超出置 truncated。workspace 不存在（脚本没写任何文件）→ 空。 */
export function scanOutputs(
  workspace: string,
  startedAt: number,
): { outputs: { path: string; bytes: number }[]; truncated: boolean } {
  const outputs: { path: string; bytes: number }[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // workspace 不存在或不可读
    }
    for (const e of entries) {
      if (truncated) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.mtimeMs >= startedAt) {
          if (outputs.length >= OUTPUTS_CAP) {
            truncated = true;
            return;
          }
          outputs.push({ path: relative(workspace, abs), bytes: st.size });
        }
      }
    }
  };
  walk(workspace);
  return { outputs, truncated };
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

/** 全局安装 Python 缺失时的引导文案（F4：per-user / Store 别名沙箱账户不可见）。 */
const PY_NOT_FOUND_MSG =
  '未找到全局安装的 Python（已排除 Microsoft Store 执行别名）。请从 python.org 安装 Python 时勾选 "Install for all users"（全局安装），沙箱账户才能访问它。';
/** Windows 不支持 .sh 的引导文案（建议作者提供跨平台 ts 版本）。 */
const SH_UNSUPPORTED_MSG =
  "Windows 上不支持执行 .sh 脚本；请让该 skill 的作者提供跨平台的 .ts 版本。";

/** F4：`where python` 常同时命中 `\WindowsApps\` 的 Store 执行别名 stub（per-user
 *  reparse point，沙箱账户必然拒访问）。排除这些后取第一个真实候选；无候选 = null
 *  （按"无全局 python"处理）。纯函数，供单测覆盖排除规则。 */
export function pickWindowsPython(candidates: string[]): string | null {
  const real = candidates
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/\\WindowsApps\\/i.test(c));
  return real[0] ?? null;
}

/** 宿主侧探测全局 python（非沙箱内，spawnSync 无害——那条铁律只针对沙箱子进程）。
 *  排除 WindowsApps stub 后返回绝对路径，探测不到返回 null。 */
function findWindowsPython(): string | null {
  try {
    const r = Bun.spawnSync(["where.exe", "python"]);
    if (r.exitCode !== 0) return null;
    return pickWindowsPython(r.stdout.toString().split(/\r?\n/));
  } catch {
    return null;
  }
}

/** 解释器 argv 前缀（spec §4.8）：
 *  - `.ts/.js/.mjs/.cjs` → 内嵌 Bun（`[execPath, "run"]`，需 `BUN_BE_BUN=1`），三平台一致；
 *  - `.py` → mac/linux 走 `python3`；Windows 探测全局 python（排除 Store 别名），无则 `no_python`；
 *  - `.sh` → mac/linux 走 `bash`；Windows 明确报 `unsupported_script`（建议 ts 版本）。
 *  opts 供测试注入 platform / findPython，产品调用走 process.platform + 真机探测。 */
export function interpreterFor(
  entry: string,
  opts: { platform?: NodeJS.Platform; findPython?: () => string | null } = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run"]; // 需 BUN_BE_BUN=1
  if (/\.py$/.test(entry)) {
    if (platform !== "win32") return ["python3"];
    const py = (opts.findPython ?? findWindowsPython)();
    if (!py) throw Object.assign(new Error(PY_NOT_FOUND_MSG), { code: "no_python" });
    return [py];
  }
  if (/\.sh$/.test(entry)) {
    if (platform === "win32") throw Object.assign(new Error(SH_UNSUPPORTED_MSG), { code: "unsupported_script" });
    return ["bash"];
  }
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
  const sessionsDir = deps.sessionsDir ?? paths.sessionsDir;
  const sandbox = deps.sandbox ?? realSkillSandbox;
  const readinessCheck = deps.readinessCheck ?? checkWindowsSandboxReady;

  const name = assertSkillName(params.name);
  const located = resolveSkillRoot(name, roots);
  if (!located) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  const summary = listSkills(located.root).find((s) => s.name === name);
  if (!summary) throw Object.assign(new Error(`unknown skill: ${name}`), { code: "unknown_skill" });
  if (!summary.runnableScripts.includes(params.entry)) {
    throw Object.assign(new Error(`entry not in scripts/: ${JSON.stringify(params.entry)}`), { code: "unknown_entry" });
  }

  // 解释器解析先行（spec §4.8）：.sh/win 或缺 python 的 skill 直接失败，不弹授权卡。
  // interpreterFor 在 Windows 上可能 throw（unsupported_script / no_python），随 code 透传。
  const interp = interpreterFor(params.entry);

  // 沙箱设施就绪检查（F6，fail-closed）：设施未就绪 → 明确报错引导重装，且先于授权卡与执行。
  // 非 win32 宿主上 checkWindowsSandboxReady 恒 ready，既有 mac 行为不变。
  const readiness = await readinessCheck();
  if (!readiness.ready) {
    throw Object.assign(
      new Error(`Windows 脚本沙箱未就绪${readiness.reason ? `：${readiness.reason}` : ""}。请重装 Pie Link 以修复沙箱设施。`),
      { code: "sandbox_not_ready" },
    );
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
  // 产物区按 session 隔离，且搬出 skill 目录——脚本进程永不写入任何 skill 目录（主根或
  // 只读副根）。这里是「副根污染」bug（旧 mkdir skillDir/workspace）的修复点。
  const workspace = sessionWorkspace(params.sessionId, sessionsDir);
  mkdirSync(workspace, { recursive: true });

  const settings = {
    allowWrite: [workspace, ...summary.declaredCaps.write.map(expandTilde)],
    allowedDomains: summary.declaredCaps.network,
    denyRead: baselineDenyRead(),
  };
  const argv = [...interp, join(skillDir, "scripts", params.entry), ...(params.args ?? [])];
  // cwd = workspace（可写区），skillDir 通过 PIE_SKILL_DIR 供脚本读自身资源。
  const env = { BUN_BE_BUN: "1", PIE_SKILL_DIR: skillDir, PIE_WORKSPACE: workspace };

  const startedAt = now();
  log("info", "skill.run", { name, entry: params.entry });
  // 活跃执行注册表：顶栏 app 的 status RPC 据此显示「正在运行的 skill」。
  const runId = beginSkillRun(name, params.entry);
  let res;
  try {
    res = await sandbox.run(argv, workspace, env, settings);
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
  // 本次产物 = workspace 里 mtime >= startedAt 的文件（daemon 扫盘得出运行时事实，
  // 不靠脚本自觉 print 清单）。
  const { outputs, truncated: outputsTruncated } = scanOutputs(workspace, startedAt);
  const result: RunSkillScriptResult = { output: res.stdout, truncated: res.truncated || undefined };
  if (outputs.length > 0) result.outputs = outputs;
  if (outputsTruncated) result.outputsTruncated = true;
  return result;
}
