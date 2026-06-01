import { chromium, type BrowserContext, type Worker } from "playwright";
import path from "node:path";

export interface LaunchResult {
  context: BrowserContext;
  serviceWorker: Worker;
  harPath: string;
}

/** 启一个带 Pie(dist-eval)的持久化 Chrome,开 recordHar,等扩展 SW active。 */
export async function launchPieChrome(opts: { userDataDir: string; harPath: string }): Promise<LaunchResult> {
  const distEval = path.resolve("dist-eval");
  const context = await chromium.launchPersistentContext(opts.userDataDir, {
    headless: false, // MV3 扩展需有头
    args: [`--disable-extensions-except=${distEval}`, `--load-extension=${distEval}`],
    recordHar: { path: opts.harPath, content: "embed" },
  });
  // 等扩展 Service Worker 注册
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  // __pieEval is mounted via an async dynamic import in the SW; wait for it
  // before returning so callers can immediately invoke bridge methods.
  await sw.evaluate(async () => {
    const deadline = Date.now() + 10_000;
    while (typeof (globalThis as { __pieEval?: unknown }).__pieEval === "undefined") {
      if (Date.now() > deadline) throw new Error("__pieEval not mounted after 10s (is this a dist-eval build?)");
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  return { context, serviceWorker: sw, harPath: opts.harPath };
}
