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
  /**
   * `false` = 该条命令/路径尚未在对应平台真机验证过——**detectAgents 默认排除**
   * （「未验证条目不得默认启用」，见 #364）。字段缺省视为已验证（mac 8 条历史条目无需触碰）。
   * Windows 表从零点亮：草案条目先落码（bin/flag 用跨平台已知语义），逐条真机验证
   * （PR need-human-test）通过后才把该条 `verified` 翻真、进入默认可用集。
   */
  verified?: boolean;
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
    // headless: `codex exec "<prompt>"`（exec 子命令 = 非交互一次性跑）。真机实证两处必须显式带上：
    // 1. --skip-git-repo-check：run_local_agent 的默认 workspace（~/.pie/handoffs/<slug>）是全新
    //    非 git 目录，缺此 flag codex 直接 `Not inside a trusted directory` exit 1。
    // 2. --sandbox workspace-write：exec 出厂默认沙箱是 read-only（无 ~/.codex/config.toml 覆盖时），
    //    agent 会因 "workspace is mounted read-only" 写不了文件；显式开 workspace-write 才可写 cwd。
    headlessArgv: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"] },

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
    // headless: `pi -p "<prompt>"`。-p（非交互）模式本就没有工具审批门控，工具直跑，无需任何跳权限
    // flag。不带 --approve：那个 flag 的真实语义是「信任项目本地文件（AGENTS.md 等）for this run」，
    // 不是自动放行工具调用；Pie 新建的 workspace 也不该默认 trust 本地文件。
    headlessArgv: ["-p", "{prompt}"] },
];

/**
 * Windows 候选表（spec §4.7）。**从零点亮**：mac 8 条不平移，每条 Windows 命令必须
 * 真机验证过才 `verified: true`——在此之前一律 `verified: false`，detectAgents 默认排除
 * （不会 spawn、不进 handoff 可选集）。首期只落码 terminal 草案：bin 名与 CLI flag 是
 * 跨平台已知语义（claude/codex/cursor-agent 都是 node CLI，`-p` / `--dangerously-*` /
 * `exec` 子命令在 Windows 上同形），故可安全草案化并靠 `where` 解绝对路径；app 形态的
 * Windows bundle 落点尚未真机确认，遵「命令必须真机验证过才进表」铁律暂不编造，留待
 * need-human-test 逐条补入。launch 层（handoff.ts 的 osascript/open 仍 mac-only）的
 * Windows 化是另一片，不在本检测片范围。
 */
export const WINDOWS_AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude",
    argv: ["{prompt}"],
    headlessArgv: ["-p", "--dangerously-skip-permissions", "{prompt}"], verified: false },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex",
    argv: ["--dangerously-bypass-approvals-and-sandbox", "{prompt}"],
    headlessArgv: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "{prompt}"],
    verified: false },
  { id: "cursor-terminal", label: "Cursor (Terminal)", kind: "terminal", bin: "cursor-agent",
    argv: ["{prompt}"],
    headlessArgv: ["-p", "--force", "{prompt}"], verified: false },
];

/** 平台分支的候选表（纯函数，可测）：win32 → Windows 草案表；其余 → mac 8 条。 */
export function agentCandidatesFor(
  platform: NodeJS.Platform = process.platform,
): readonly AgentCandidate[] {
  return platform === "win32" ? WINDOWS_AGENT_CANDIDATES : AGENT_CANDIDATES;
}

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
 * `reg query "<key>" /v Path` 的 stdout 里取 Path 值：命中形如
 * `    Path    REG_EXPAND_SZ    C:\...;C:\...` 的行，取第三列（值）。找不到 → 空串。
 * `REG_SZ` 与 `REG_EXPAND_SZ` 都认（用户 Path 通常 EXPAND，system 视配置而定）。
 */
export function parseRegQueryPath(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/i);
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * Windows PATH 合并（纯函数，可测）：进程 env PATH 打头，再拼注册表 user/system Path，
 * 按 `;` 切段、去空、大小写不敏感去重（Windows 路径大小写不敏感），`;` 重连。
 * 进程 env 优先（当前会话已解析的 PATH 最贴近用户意图），注册表补上未继承进 env 的段。
 */
export function mergeWindowsPath(processPath: string, registryPaths: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [processPath, ...registryPaths]) {
    for (const seg of (src ?? "").split(";")) {
      const t = seg.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out.join(";");
}

/**
 * Windows 无 login shell 概念，PATH 真相 = 进程继承的 env PATH ＋ 注册表两处 Path：
 * HKCU\Environment（user）与 HKLM\...\Session Manager\Environment（system）。
 * 注册表读走 `reg query`（Windows 自带）；任一失败/超时只丢那一段，不影响其余。
 * stdin: "ignore" / timeout 3000：对齐 mac 分支的挂死防护。
 */
function getWindowsPath(): string {
  const processPath = process.env.PATH ?? process.env.Path ?? "";
  const regKeys: string[] = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const registryPaths: string[] = [];
  for (const key of regKeys) {
    try {
      const r = Bun.spawnSync(["reg", "query", key, "/v", "Path"], {
        stdin: "ignore",
        timeout: 3000,
      });
      registryPaths.push(parseRegQueryPath(r.stdout.toString()));
    } catch {
      /* 该注册表段读不到就跳过，靠其余来源兜底 */
    }
  }
  return mergeWindowsPath(processPath, registryPaths);
}

/**
 * daemon 跑在 launchd 下，PATH 是裸的 /usr/bin:/bin:/usr/sbin:/sbin ——
 * 看不见 ~/.local/bin、/opt/homebrew/bin、~/.opencode/bin 里的任何 agent CLI
 * （"Dock 启动的 app 找不到 node/brew" 同款坑）。问用户自己的 login shell 要真相。
 * Windows 无 login shell，改走 env + 注册表合并（getWindowsPath）。
 *
 * 不缓存：实测 0.10–0.16s，而 detect 只在「弹授权卡」「打开设置页」两个点被调用，
 * 无感。不缓存换来的是：用户装完新 agent 立刻可见，不需要重启 daemon，也不需要
 * 教用户什么叫「刷新」。
 *
 * stdin: "ignore" —— 防 zsh 启动期读 stdin 的东西（oh-my-zsh 升级提示的 read -k）
 * 把探测挂死；与 handoff.ts 的 LAUNCH_PAD 是同一个坑的两面。
 * timeout 3000 —— rc 重度定制的用户可能要一两秒；超时宁可检测不到，也不能卡住授权卡。
 */
export function getUserPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return getWindowsPath();
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

/**
 * Store 执行别名 stub：`%LOCALAPPDATA%\Microsoft\WindowsApps\<name>.exe` 下的 0 字节
 * reparse 占位（App Installer 装的「别名」）。`where python` 会把它列在最前，但 spawn
 * 它行为诡异（Gate 0 F4 实测：要么弹 Store 页要么 exit 9009），一律当没装。
 */
export function isWindowsAppsStub(p: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(p);
}

/**
 * `where <bin>` 的 stdout 解析（纯函数，可测）：每行一个绝对路径命中，取**第一个非
 * WindowsApps stub** 的路径。全是 stub / 空输出（未装，where exit 1）→ null。
 */
export function parseWherePath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || isWindowsAppsStub(t)) continue;
    return t;
  }
  return null;
}

export interface DetectOpts {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  /** true = 连 `verified:false` 的草案条目也纳入（供 need-human-test 逐条点亮用）；默认排除。 */
  includeUnverified?: boolean;
}

/** 平台对应的 which：win32 走 `where`（排 WindowsApps stub），其余走 Bun.which。 */
function makeWhich(platform: NodeJS.Platform, userPath: string): (bin: string) => string | null {
  if (platform === "win32") {
    return (bin: string) => {
      try {
        const r = Bun.spawnSync(["where", bin], {
          env: { ...process.env, PATH: userPath, Path: userPath },
          stdin: "ignore",
          timeout: 3000,
        });
        return parseWherePath(r.stdout.toString());
      } catch {
        return null;
      }
    };
  }
  return (b: string) => Bun.which(b, { PATH: userPath });
}

/** 每次调用现检测（which/exists 都便宜，PATH 探测 0.1s 级，无缓存必要）；保持表顺序。 */
export function detectAgents(opts?: DetectOpts): DetectedAgent[] {
  const platform = opts?.platform ?? process.platform;
  const userPath = opts?.which ? "" : getUserPath(platform); // 注入 which 时不必探 PATH
  const which = opts?.which ?? makeWhich(platform, userPath);
  const exists = opts?.exists ?? existsSync;
  const candidates = agentCandidatesFor(platform).filter(
    (c) => opts?.includeUnverified || c.verified !== false,
  );
  const out: DetectedAgent[] = [];
  for (const c of candidates) {
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
