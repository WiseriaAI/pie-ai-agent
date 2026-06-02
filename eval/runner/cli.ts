import { readFileSync } from "node:fs";
import { runOneTask } from "./run-task";
import type { TaskDef } from "./types";

// 用法: tsx eval/runner/cli.ts <task.json 路径> [outRoot]
// 需要环境变量: PIE_EVAL_PROVIDER / PIE_EVAL_MODEL / PIE_EVAL_API_KEY
// 可选: PIE_EVAL_TIMEOUT_MS(单任务超时,默认 600000=10min;模拟态+LLM 延迟下 5min 偏紧)
async function main() {
  const taskPath = process.argv[2];
  const outRoot = process.argv[3] ?? "eval/runs";
  if (!taskPath) throw new Error("usage: tsx eval/runner/cli.ts <task.json> [outRoot]");

  const task = JSON.parse(readFileSync(taskPath, "utf8")) as TaskDef;
  const model = {
    provider: requireEnv("PIE_EVAL_PROVIDER"),
    model: requireEnv("PIE_EVAL_MODEL"),
    apiKey: requireEnv("PIE_EVAL_API_KEY"),
  };
  const timeoutMs = Number(process.env.PIE_EVAL_TIMEOUT_MS) || 10 * 60_000;
  const stamp = String(Date.now());
  const res = await runOneTask({ task, model, outRoot, stamp, timeoutMs });
  console.log(`[orchestrator] status=${res.status} runDir=${res.runDir}`);
  if (res.status === "harness-error") process.exit(2);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
