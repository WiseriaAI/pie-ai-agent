import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { HandoffParams, HandoffResult } from "../../src/types/local-bridge";
import type { SpawnFn } from "./spawn";
import { realSpawn } from "./spawn";
import type { AgentCandidate } from "./agents";
import { detectAgents } from "./agents";
import { paths } from "./paths";
import { log } from "./log";

/** 我们在 handoff 目录里写死的文件名——用户传的文件不许撞它们。 */
const RESERVED = new Set(["context.md", "start.command", "claude.md"]);

/** app 模式的约定注入：Cowork 没有 prompt 参数面，靠目录内 CLAUDE.md 引导。 */
const CLAUDE_MD_CONVENTION =
  "Read context.md in this directory for the handed-off context, then continue the task.\n";

/**
 * do script 注入串的前导牺牲空格数。zsh 启动期的 stdin 消费者（omz 升级提示
 * read -k 1 等）每次吃 1 字符；8 个空格覆盖多个消费者叠加，剩余空格 shell 忽略。
 */
const LAUNCH_PAD = 8;

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
    detect?: () => AgentCandidate[];
  },
): Promise<HandoffResult> {
  const spawn = opts?.spawn ?? realSpawn;
  const ensureDir = opts?.ensureDir ?? ((d) => mkdirSync(d, { recursive: true }));
  const writeFile =
    opts?.writeFile ?? ((p, c, m) => writeFileSync(p, c, m != null ? { mode: m } : undefined));
  const now = opts?.now ?? (() => new Date().toISOString().slice(0, 10));
  const detect = opts?.detect ?? detectAgents;

  // params 是 JSON 解析自 socket 的运行时值（daemon.ts 里只是 `as HandoffParams`
  // 断言，编译期类型在运行时不提供任何保证）。target 决定 spawn 什么：闸 =
  // 「∈ 本次现检测到的 id 集」——launch 命令/app 名全部来自静态候选表，wire 上
  // 的 target 只用来查表，未通过检测的 id（包括注入串）在任何写盘/spawn 之前
  // 被拒。旧 wire 值 "claude"（Slice 1 扩展）alias 到 claude-terminal。
  const requestedId = params.target === "claude" ? "claude-terminal" : params.target;
  const agent = detect().find((a) => a.id === requestedId);
  if (!agent) {
    throw new Error(`unsupported handoff target: ${JSON.stringify(params.target)}`);
  }

  const dir = join(paths.handoffsDir, `${now()}-${slugify(params.context)}`);
  ensureDir(dir);
  writeFile(join(dir, "context.md"), params.context);
  for (const f of params.files ?? []) {
    writeFile(join(dir, safeFileName(f.name)), f.content);
  }

  if (agent.kind === "app") {
    // app 直开（真机已验证）：`open -a Claude <dir>` → Cowork 会话根在该目录。
    // 无 prompt 注入面 → 目录内 CLAUDE.md 约定引导；人到场发一句即开跑。
    // 无 shell、无 TCC，launch 比 Terminal 稳，但不自动开跑（mode 回传给扩展，
    // observation 明示用户需发一句话启动）。
    writeFile(join(dir, "CLAUDE.md"), CLAUDE_MD_CONVENTION);
    log("info", "handoff.open_app", { dir, target: agent.id, files: (params.files ?? []).length });
    const r = await spawn("open", ["-a", agent.appName!, dir], dir);
    if (r.exitCode !== 0) {
      throw new Error(
        `failed to open ${agent.label} (open exit ${r.exitCode}): ${(r.stderr ?? "").trim().slice(0, 300)} — ` +
          `open the folder manually in the app: ${dir}`,
      );
    }
    return { dir, mode: "app" };
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
  const script =
    `#!/bin/bash\n` +
    `cd ${JSON.stringify(dir)} || exit 1\n` +
    `exec ${agent.bin} "Read context.md in this directory for the handed-off context, then continue the task."\n`;
  const scriptPath = join(dir, "start.command");
  writeFile(scriptPath, script, 0o755);
  log("info", "handoff.open", { dir, target: agent.id, files: (params.files ?? []).length });
  // 为什么不用 `open start.command`：Terminal 打开 .command 的机制是「spawn 交互式
  // login zsh + 把脚本路径当键盘输入喂进 TTY」（真机 ps 链验证：Terminal → login →
  // -zsh → script）。zsh 启动期任何读 stdin 的东西（oh-my-zsh 升级提示的 read -k 1
  // 是实锤案例）会吃掉路径首字符 → 路径残缺 → 交棒静默失败。改走 AppleScript
  // do script：注入的字符串由我们控制，前面垫 LAUNCH_PAD 个牺牲空格——启动期
  // 消费者吃掉的只是空格，命令本体无损（shell 忽略前导空白）。
  // scriptPath 是 daemon 派生路径（homedir + ISO 日期 + [a-z0-9-] slug），不含
  // 双引号/反斜杠，可安全嵌入 AppleScript 双引号字符串与 shell 单引号。
  const padded = `${" ".repeat(LAUNCH_PAD)}exec '${scriptPath}'`;
  const r = await spawn(
    "osascript",
    ["-e", 'tell application "Terminal"', "-e", `do script "${padded}"`, "-e", "activate", "-e", "end tell"],
    dir,
  );
  // osascript 非零 = Terminal 没被唤起（典型：TCC Automation 权限被拒 -1743）。
  // fire-and-forget 只对 claude 进程成立，唤起终端这步失败必须让用户知道并给
  // 自救路径（手动跑 start.command，文件已落盘）。
  if (r.exitCode !== 0) {
    throw new Error(
      `failed to open Terminal (osascript exit ${r.exitCode}): ${(r.stderr ?? "").trim().slice(0, 300)} — ` +
        `grant Automation permission for pie → Terminal in System Settings › Privacy & Security › Automation, ` +
        `or run it manually: ${scriptPath}`,
    );
  }
  return { dir, mode: "terminal" };
}
