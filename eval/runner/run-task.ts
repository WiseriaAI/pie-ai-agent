import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { launchPieChrome } from "./launch";
import { scrubHar } from "./har-scrub";
import { seedAuth, type AuthConfig } from "./auth";
import type { TaskDef, EvalTrace, RunStatus, Har } from "./types";

export interface ModelEnv { provider: string; model: string; apiKey: string }

export interface RunResult { runDir: string; status: RunStatus; trace: EvalTrace | null }

/** 跑一个 task:启 Chrome+Pie → seed key → 导航 → startTask → waitForDone →
 *  getTrace → reset → 关 context(flush HAR)→ 清洗 HAR → 落盘 artifact bundle。 */
export async function runOneTask(opts: {
  task: TaskDef;
  model: ModelEnv;
  outRoot: string;
  stamp: string;
  timeoutMs: number;
}): Promise<RunResult> {
  const runDir = path.join(opts.outRoot, `${opts.task.taskId}-${opts.stamp}`);
  mkdirSync(runDir, { recursive: true });
  const harPath = path.join(runDir, "network.raw.har");
  const userDataDir = path.join(runDir, "profile");

  let status: RunStatus = "harness-error";
  let trace: EvalTrace | null = null;
  let context: import("playwright").BrowserContext | undefined;

  try {
    const launched = await launchPieChrome({ userDataDir, harPath });
    context = launched.context;
    const { serviceWorker } = launched;

    // Optional auth-seeding: log into sites so the agent starts already authenticated.
    const pieEvalAuth = process.env.PIE_EVAL_AUTH;
    if (pieEvalAuth && pieEvalAuth.trim() !== "") {
      let authConfigs: AuthConfig[];
      try {
        authConfigs = JSON.parse(pieEvalAuth) as AuthConfig[];
      } catch (parseErr) {
        throw new Error(`[orchestrator] PIE_EVAL_AUTH is not valid JSON: ${parseErr}`);
      }
      await seedAuth(context, authConfigs);
    }

    await serviceWorker.evaluate(async (cfg) => {
      await (globalThis as any).__pieEval.seedConfig(cfg);
    }, opts.model);

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.task.startUrl, { waitUntil: "domcontentloaded" });

    const { sessionId } = await serviceWorker.evaluate(
      async (goal) => (globalThis as any).__pieEval.startTask({ goal }),
      opts.task.goal,
    );

    const done = await serviceWorker.evaluate(
      async (args) => (globalThis as any).__pieEval.waitForDone(args),
      { sessionId, timeoutMs: opts.timeoutMs },
    );
    status = done.status as RunStatus;

    trace = await serviceWorker.evaluate(
      async (args) => (globalThis as any).__pieEval.getTrace(args),
      { sessionId },
    );

    await serviceWorker.evaluate(async () => (globalThis as any).__pieEval.reset());
  } catch (e) {
    status = "harness-error";
    console.error("[orchestrator] harness error:", e);
  } finally {
    if (context) await context.close(); // flush HAR
  }

  // 清洗 HAR(剔除 provider 调用 / 剥敏感 header),写最终 network.har,删原始。
  // launch 若失败可能没有 HAR 文件 → 容错跳过。
  if (existsSync(harPath)) {
    const rawHar = JSON.parse(readFileSync(harPath, "utf8")) as Har;
    const cleanHar = scrubHar(rawHar, opts.task.webarenaHosts);
    writeFileSync(path.join(runDir, "network.har"), JSON.stringify(cleanHar, null, 2));
    rmSync(harPath, { force: true });
  }

  // artifact bundle
  writeFileSync(path.join(runDir, "task.json"), JSON.stringify(opts.task, null, 2));
  if (trace) {
    writeFileSync(path.join(runDir, "run.json"), JSON.stringify(trace, null, 2));
    writeFileSync(path.join(runDir, "answer.txt"), trace.answer);
  }
  writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify({ model: opts.model.model, provider: opts.model.provider, status, stamp: opts.stamp }, null, 2),
  );

  // profile 用完即弃(强隔离)
  rmSync(userDataDir, { recursive: true, force: true });

  return { runDir, status, trace };
}
