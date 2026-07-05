import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { RunLocalAgentParams, RunLocalAgentResult } from "../../src/types/local-bridge";
import { paths } from "./paths";

export type SpawnFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; exitCode: number }>;

const realSpawn: SpawnFn = async (cmd, args, cwd) => {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
};

/** slug from prompt: 前 24 字符小写、非字母数字转 -。ponytail: 无需时间戳（无 Date 依赖测试）。 */
function slugify(prompt: string): string {
  return prompt.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "task";
}

export async function runLocalAgent(
  params: RunLocalAgentParams,
  opts?: { spawn?: SpawnFn },
): Promise<RunLocalAgentResult> {
  const spawn = opts?.spawn ?? realSpawn;
  let cwd = params.cwd;
  if (!cwd) {
    cwd = join(paths.handoffsDir, slugify(params.prompt));
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  }
  // Slice 0: 阻塞取 stdout（无 stream-json 解析，见 plan 顶部 defer）
  const { stdout, exitCode } = await spawn("claude", ["-p", params.prompt], cwd);
  return { output: stdout, exitCode, cwd };
}
