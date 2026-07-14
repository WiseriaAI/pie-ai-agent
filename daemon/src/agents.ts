import { existsSync } from "fs";
import { homedir } from "os";

/**
 * 静态候选表 = 唯一 launch 权威：spawn 的命令 / app 路径只住在这里，绝不来自 wire 或
 * LLM 参数（wire 上只传 id，daemon 用 id 查表）。加新 agent = 加一行，**但必须先在真机上
 * 验证过那条命令**——绝不凭空编 spawn 命令。
 *
 * 顺序即 HandoffCard 的预选顺序：品牌分组，每组 app 在前（app 无 shell、无 TCC，launch 最稳）。
 *
 * 不在表里的：Hermes（没有"交互式 + 自动带初始 prompt"的形态，-z 是 headless 打印即退，
 * hermes chat 无法注入初始 prompt）、Openclaw（gateway 架构，与 exec start.command 范式不同构）。
 */
export interface AgentCandidate {
  id:
    | "claude-app"
    | "claude-terminal"
    | "codex-app"
    | "codex-terminal"
    | "cursor-app"
    | "cursor-terminal"
    | "opencode-terminal"
    | "pi-terminal";
  label: string;
  kind: "app" | "terminal";
  /** terminal：检测用的 bin 名（spawn 用 DetectedAgent.path，不是这个） */
  bin?: string;
  /** terminal：argv 模板，"{prompt}" 占位。位置参数 vs flag 的差异只是数据。 */
  argv?: string[];
  /**
   * terminal：headless（非交互，一次性跑完回传 stdout）的 argv 模板，"{prompt}" 占位。
   * 与交互式 `argv` 同构但形态不同——headless 无人可批工具调用，故各家在此带上「跳权限/
   * 自动放行」flag（用户已在 run_local_agent 授权卡上批过 prompt+cwd，那张卡就是闸）。
   * 只有声明了 headlessArgv 的候选才可作为 run_local_agent 后端；app 形态无此字段（无 CLI）。
   */
  headlessArgv?: string[];
  /**
   * terminal：官方安装器的知名落点（"~" 开头，detect 时展开）。PATH 探测 miss 才回落——
   * 常规安装完全可能不进 login shell PATH（真机实证：opencode 装在 ~/.opencode/bin 而
   * rc 没配 PATH），不能要求用户自己配。PATH 命中永远优先（用户自装位置说了算）。
   */
  binPaths?: string[];
  /** app：按优先级探，命中第一个存在的；spawn 用命中的绝对路径。 */
  appPaths?: string[];
  /** app：目录内的约定引导文件名（app 无 prompt 注入面，靠它引导）。 */
  convention?: "CLAUDE.md" | "AGENTS.md";
}

export const AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-app", label: "Claude Code (App)", kind: "app",
    appPaths: ["/Applications/Claude.app"], convention: "CLAUDE.md" },
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude",
    argv: ["{prompt}"], binPaths: ["~/.local/bin/claude"],
    // headless: `claude -p "<prompt>"`；--dangerously-skip-permissions 让 headless claude
    // 不因无人审批而卡在写操作上。
    headlessArgv: ["-p", "--dangerously-skip-permissions", "{prompt}"] },

  // Codex 与 ChatGPT app 已合并为同一 bundle（com.openai.codex——本机
  // /Applications/ChatGPT.app 的 bundle id 实测就是它，没有独立的 Codex.app）。优先
  // Codex.app（万一 OpenAI 再拆回来），回落 ChatGPT.app。显示名合并成 "Codex / ChatGPT"。
  { id: "codex-app", label: "Codex / ChatGPT (App)", kind: "app",
    appPaths: ["/Applications/Codex.app", "/Applications/ChatGPT.app"], convention: "AGENTS.md" },
  // --dangerously-bypass-approvals-and-sandbox：产品拍板（2026-07-14 验收）——交棒要
  // 「到手即跑」，目录确认会卡住每一次 handoff（目录每次新建，信任记忆无效）。代价是
  // 交棒后的 codex 会话无审批、无沙箱，风险由用户在交棒动作本身承担。
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex",
    argv: ["--dangerously-bypass-approvals-and-sandbox", "{prompt}"],
    // headless: `codex exec "<prompt>"`（exec 子命令 = 非交互一次性跑）。exec 默认
    // workspace-write 沙箱即可写 cwd，无需额外跳权限 flag。
    headlessArgv: ["exec", "{prompt}"] },

  // Cursor 是 IDE：app 形态打开的是一个只有 context.md + AGENTS.md 的工作区，
  // 用户 ⌘L 发一句话让 agent 接手（已知取舍，见 spec §6）。
  // CLI 是 cursor-agent —— /Applications/Cursor.app 里的 `cursor` 是 IDE 启动器，不是 agent。
  { id: "cursor-app", label: "Cursor (App)", kind: "app",
    appPaths: ["/Applications/Cursor.app"], convention: "AGENTS.md" },
  // 不加 --trust：help 说它能跳工作区信任提示，但真机实测「--trust can only be used
  // with --print/headless mode」，交互式 TUI 直接报错退出。claude/codex 也无同粒度
  // flag（codex 只有全跳审批+沙箱的 dangerously-bypass，不能替用户开）——三家统一保持
  // 首次进目录一次 y 确认，那是 agent 自身的安全机制。
  { id: "cursor-terminal", label: "Cursor (Terminal)", kind: "terminal", bin: "cursor-agent",
    argv: ["{prompt}"], binPaths: ["~/.local/bin/cursor-agent"],
    // headless: `cursor-agent -p "<prompt>"`；--force 跳过工具审批（headless 无人可批）。
    headlessArgv: ["-p", "--force", "{prompt}"] },

  // opencode 的交互式 TUI 用 --prompt 带初始 prompt（真机验证：自动发送，不是预填输入框）。
  { id: "opencode-terminal", label: "OpenCode (Terminal)", kind: "terminal", bin: "opencode",
    argv: ["--prompt", "{prompt}"], binPaths: ["~/.opencode/bin/opencode"],
    // headless: `opencode run "<prompt>"`；--auto 自动放行工具调用（headless 无人可批）。
    headlessArgv: ["run", "--auto", "{prompt}"] },

  // pi（badlogic/pi-mono coding agent）：位置参数，`pi "<prompt>"`。
  { id: "pi-terminal", label: "Pi (Terminal)", kind: "terminal", bin: "pi", argv: ["{prompt}"],
    // headless: `pi -p "<prompt>"`；--approve 自动放行工具调用（headless 无人可批）。
    headlessArgv: ["-p", "--approve", "{prompt}"] },
];

/**
 * shell 输出里取 PATH：只认最后一个非空行。rc 里的 banner / 提示会先打出来，
 * 真正的 `echo $PATH` 永远在最后。空输出（shell 挂了 / 超时）回落 fallback。
 */
export function parseShellPath(stdout: string, fallback: string): string {
  const last = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  return last || fallback;
}

/**
 * daemon 跑在 launchd 下，PATH 是裸的 /usr/bin:/bin:/usr/sbin:/sbin ——
 * 看不见 ~/.local/bin、/opt/homebrew/bin、~/.opencode/bin 里的任何 agent CLI
 * （"Dock 启动的 app 找不到 node/brew" 同款坑）。问用户自己的 login shell 要真相。
 *
 * 不缓存：实测 0.10–0.16s，而 detect 只在「弹授权卡」「打开设置页」两个点被调用，
 * 无感。不缓存换来的是：用户装完新 agent 立刻可见，不需要重启 daemon，也不需要
 * 教用户什么叫「刷新」。
 *
 * stdin: "ignore" —— 防 zsh 启动期读 stdin 的东西（oh-my-zsh 升级提示的 read -k）
 * 把探测挂死；与 handoff.ts 的 LAUNCH_PAD 是同一个坑的两面。
 * timeout 3000 —— rc 重度定制的用户可能要一两秒；超时宁可检测不到，也不能卡住授权卡。
 */
export function getUserPath(): string {
  const fallback = process.env.PATH ?? "";
  try {
    const r = Bun.spawnSync([process.env.SHELL ?? "/bin/zsh", "-lic", "echo $PATH"], {
      stdin: "ignore",
      timeout: 3000,
    });
    return parseShellPath(r.stdout.toString(), fallback);
  } catch {
    return fallback;
  }
}

/** 检测结果 = 候选 + 解析出的绝对路径。spawn 只许用 path（裸命令名依赖运行时 PATH，真机上会 not found）。 */
export type DetectedAgent = AgentCandidate & { path: string };

export interface DetectOpts {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
}

/** 每次调用现检测（which/exists 都便宜，PATH 探测 0.1s 级，无缓存必要）；保持表顺序。 */
export function detectAgents(opts?: DetectOpts): DetectedAgent[] {
  const userPath = opts?.which ? "" : getUserPath(); // 注入 which 时不必探 shell
  const which = opts?.which ?? ((b: string) => Bun.which(b, { PATH: userPath }));
  const exists = opts?.exists ?? existsSync;
  const out: DetectedAgent[] = [];
  for (const c of AGENT_CANDIDATES) {
    const path =
      c.kind === "app"
        ? (c.appPaths!.find((p) => exists(p)) ?? null)
        : (which(c.bin!) ??
          c.binPaths?.map((p) => p.replace(/^~/, homedir())).find((p) => exists(p)) ??
          null);
    if (path) out.push({ ...c, path });
  }
  return out;
}
