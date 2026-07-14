import { mkdirSync } from "fs";
import { join } from "path";
import type { RunLocalAgentParams, RunLocalAgentResult } from "../../src/types/local-bridge";
import { paths } from "./paths";
import { log } from "./log";
import type { SpawnFn } from "./spawn";
import { realSpawn } from "./spawn";
import type { DetectedAgent } from "./agents";
import { AGENT_CANDIDATES, detectAgents } from "./agents";

/** 非零退出时给诊断用的 stderr 尾巴：截断避免把整段日志灌进 observation。 */
const STDERR_TAIL_MAX = 2000;
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_MAX ? trimmed.slice(-STDERR_TAIL_MAX) : trimmed;
}

const realEnsureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

/** slug from prompt: 前 24 字符小写、非字母数字转 -。ponytail: 无需时间戳（无 Date 依赖测试）。 */
function slugify(prompt: string): string {
  return prompt.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "task";
}

/** 候选表里可作 headless 后端（声明了 headlessArgv）的 bin 名，仅用于「一个都没装」的报错提示。 */
const HEADLESS_BINS = AGENT_CANDIDATES.filter((c) => c.headlessArgv?.length).map((c) => c.bin);

export async function runLocalAgent(
  params: RunLocalAgentParams,
  opts?: { spawn?: SpawnFn; ensureDir?: (dir: string) => void; detect?: () => DetectedAgent[] },
): Promise<RunLocalAgentResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? realEnsureDir;
  const detect = opts?.detect ?? detectAgents;
  // 后端选择 = 按候选表顺序取第一个「已装且有 headlessArgv」者（detectAgents 保表顺序，
  // claude-terminal 在最前 → 装了 claude 时行为与旧硬编码一致）。不再写死 "claude"：
  // 只装了 Cursor/Codex/OpenCode/Pi 的用户照样能用。spawn 用检测到的绝对路径（裸命令名
  // 在 launchd 裸 PATH 下会 not found）。
  const backend = detect().find((a) => a.headlessArgv?.length);
  if (!backend) {
    throw new Error(
      `run_local_agent: no local headless agent detected. Install one of: ${HEADLESS_BINS.join(", ")}`,
    );
  }
  let cwd = params.cwd;
  if (!cwd) {
    cwd = join(paths.handoffsDir, slugify(params.prompt));
    ensureDir(cwd);
  }
  const startedAt = Date.now();
  log("info", "run.spawn", { target: backend.id, cwd, promptLen: params.prompt.length });
  // 阻塞取 stdout（无 stream-json 解析，见 plan 顶部 defer）。headless argv 各家自带
  // 跳权限/自动放行 flag：headless 无人可批工具调用，会卡死写操作。用户已在 Pie 的 HITL
  // 授权卡层批准了这个 prompt+cwd（威胁模型里卡就是闸），故在受控的隔离 workspace 里
  // 跳过 agent 自身的交互审批。{prompt} 占位替换成原始 prompt 单参（spawn 不过 shell，无需引号转义）。
  const argv = backend.headlessArgv!.map((tok) => (tok === "{prompt}" ? params.prompt : tok));
  const { stdout, exitCode, stderr } = await spawn(backend.path, argv, cwd);
  // 非零退出时把 stderr 尾巴接到 output 里，给失败留点诊断（T4 defer note）；
  // 零退出保持 stdout 原样，不掺 stderr 噪音。
  const tail = exitCode !== 0 ? stderrTail(stderr ?? "") : "";
  const output = tail ? (stdout ? `${stdout}\n${tail}` : tail) : stdout;
  log("info", "run.done", { target: backend.id, cwd, exitCode, outputLen: output.length, ms: Date.now() - startedAt });
  return { output, exitCode, cwd, backend: { id: backend.id, label: backend.label } };
}
