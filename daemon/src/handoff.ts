import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { HandoffParams, HandoffResult } from "../../src/types/local-bridge";
import type { SpawnFn } from "./spawn";
import { realSpawn } from "./spawn";
import { paths } from "./paths";
import { log } from "./log";

/** 我们在 handoff 目录里写死的文件名——用户传的文件不许撞它们。 */
const RESERVED = new Set(["context.md", "start.command"]);

/** slug：context 前 24 字符小写、非字母数字转 -。 */
function slugify(context: string): string {
  return (
    context.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "handoff"
  );
}

/**
 * 用户（被 untrusted 页面驱动的 LLM）传来的文件名一律取 basename：剥掉任何目录
 * 成分（`../` 遍历被中和成落在 handoff 目录内的裸名），并挡掉空名 / . / .. / 保留名。
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // 大小写不敏感比对：Slice 1 macOS-only，默认文件系统（APFS/HFS+）大小写不敏感——
  // `START.COMMAND` / `Context.MD` 这类变体若只做大小写敏感比对会放过检查，却
  // 在磁盘上解析成同一份保留文件，构成潜在的 start.command 覆盖。
  if (!base || base === "." || base === ".." || RESERVED.has(base.toLowerCase())) {
    throw new Error(`unsafe file name: ${JSON.stringify(name)}`);
  }
  return base;
}

export async function runHandoff(
  params: HandoffParams,
  opts?: {
    spawn?: SpawnFn;
    ensureDir?: (dir: string) => void;
    writeFile?: (path: string, content: string, mode?: number) => void;
    now?: () => string;
  },
): Promise<HandoffResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const writeFile =
    opts?.writeFile ?? ((p, c, m) => writeFileSync(p, c, m != null ? { mode: m } : undefined));
  const now = opts?.now ?? (() => new Date().toISOString().slice(0, 10));

  // params 是 JSON 解析自 socket 的运行时值（daemon.ts 里只是 `as HandoffParams`
  // 断言，编译期字面量类型在运行时不提供任何保证）；target 最终会被拼进
  // start.command 的 `exec ${cmd} "..."` 里，未经校验的 shell 元字符会在
  // `open` 拉起 Terminal 的瞬间执行——早于人在终端前的任何审批，直接击穿
  // hand-off 相对 round-trip 的安全前提。Slice 1 只认 "claude"；引入 codex
  // 时这里改成 allow-list。
  if (params.target !== "claude") {
    throw new Error(`unsupported handoff target: ${JSON.stringify(params.target)}`);
  }

  const dir = join(paths.handoffsDir, `${now()}-${slugify(params.context)}`);
  ensureDir(dir);
  writeFile(join(dir, "context.md"), params.context);
  for (const f of params.files ?? []) {
    writeFile(join(dir, safeFileName(f.name)), f.content);
  }
  // 交互式会话脚本：cd 进目录、用初始 prompt 拉起 claude。**不带**
  // --dangerously-skip-permissions —— 人就在终端前，claude 自己的交互审批有人可批，
  // 这正是 hand-off 区别于 round-trip 的地方。exec 让 claude 接管终端；退出后
  // Terminal 显示 process completed，错误（如 claude 未装）对用户可见。
  // dir 是 daemon 派生（homedir + ISO 日期 + slugify 限制字符集在
  // [a-z0-9-]），charset 由构造方式圈定，不是靠 JSON.stringify 的引号规则
  // 恰好兼容 bash 双引号语义（两者其实不等价：JSON 的 \n / \uXXXX 转义与 bash
  // 双引号转义规则不同）——这里安全性来自 dir 本身不含双引号/反引号/`$`
  // 等元字符，JSON.stringify 只是顺手拿来加一层引号。
  const cmd = params.target; // Slice 1 只 claude（上面已校验）
  const script =
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${cmd} "Read context.md in this directory for the handed-off context, then continue the task."\n`;
  const scriptPath = join(dir, "start.command");
  writeFile(scriptPath, script, 0o755);
  log("info", "handoff.open", { dir, target: cmd, files: (params.files ?? []).length });
  // macOS `open` 双击 .command → 默认 Terminal.app 跑它 → 交互式会话。
  // fire-and-forget：open 启动终端后立刻退，不等 claude。
  await spawn("open", [scriptPath], dir);
  return { dir };
}
