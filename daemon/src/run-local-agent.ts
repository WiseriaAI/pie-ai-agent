import { mkdirSync } from "fs";
import { join } from "path";
import type { RunLocalAgentParams, RunLocalAgentResult } from "../../src/types/local-bridge";
import { paths } from "./paths";

export type SpawnFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; exitCode: number; stderr?: string }>;

const realSpawn: SpawnFn = async (cmd, args, cwd) => {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  // 必须并发排空 stdout 和 stderr：只 await stdout 会让 stderr 管道（OS 缓冲区
  // ~64KB）写满后阻塞子进程，子进程卡住不退出 → await proc.exited 永久挂起，
  // 而 send() 又无超时，整条 agent loop 跟着卡死。
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, exitCode, stderr };
};

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

export async function runLocalAgent(
  params: RunLocalAgentParams,
  opts?: { spawn?: SpawnFn; ensureDir?: (dir: string) => void },
): Promise<RunLocalAgentResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? realEnsureDir;
  let cwd = params.cwd;
  if (!cwd) {
    cwd = join(paths.handoffsDir, slugify(params.prompt));
    ensureDir(cwd);
  }
  // Slice 0: 阻塞取 stdout（无 stream-json 解析，见 plan 顶部 defer）
  const { stdout, exitCode, stderr } = await spawn("claude", ["-p", params.prompt], cwd);
  // 非零退出时把 stderr 尾巴接到 output 里，给失败留点诊断（T4 defer note）；
  // 零退出保持 stdout 原样，不掺 stderr 噪音。
  const tail = exitCode !== 0 ? stderrTail(stderr ?? "") : "";
  const output = tail ? (stdout ? `${stdout}\n${tail}` : tail) : stdout;
  return { output, exitCode, cwd };
}
