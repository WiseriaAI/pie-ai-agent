// Pie 自有 SkillSandbox 接口 + srt 后端。把 @anthropic-ai/sandbox-runtime（研究预览，
// API 可能演进）挡在这一层后：上层 skill-exec 只依赖 SkillSandbox，换后端不动编排。
//
// Spike 结论（docs/plans/2026-07-10-skill-daemon-fs-foundation.spike.md）：
//   - srt 的 SandboxManager 在 bun runtime + `bun build --compile` 二进制里全部工作：
//     文件写限 / 敏感读拒 / 默认断网 / 按域名放行网络，端到端真机验证过。
//   - 硬约束：跑沙箱子进程必须用异步 Bun.spawn，绝不能 Bun.spawnSync——srt 的网络
//     放行靠一个进程内 JS 代理，spawnSync 会阻塞 bun 单线程事件循环 → 代理不转发 →
//     所有出站挂到超时（这个坑在 spike 里踩过，务必别复现）。
//   - SandboxManager 是全局单例（initialize/updateConfig/reset 改共享状态 + 起代理端口），
//     故 run() 全程串行化：一次只跑一个沙箱，避免并发请求互相踩配置/代理。
import { SandboxManager, resolveSrtWin, verifyWindowsWfpEgress } from "@anthropic-ai/sandbox-runtime";
import { dirname, join } from "path";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const IS_WIN = process.platform === "win32";

/**
 * srt-win.exe 是安装器伴随文件（与 pie.exe 同目录，spec §6.1 / open-question #1）：
 * v0.0.67 起无隐式 vendored 回落——省略 `windows.srtWin.path` 即 throw；且 bun compile
 * 单二进制里 `__dirname` 相对解析失效，必须运行时显式解出并传给 SandboxManager。
 */
export function srtWinPath(): string {
  return join(dirname(process.execPath), "srt-win.exe");
}

export interface SandboxSettings {
  /** 绝对路径白名单，只有这些子树可写（基线含 <skillDir>/workspace） */
  allowWrite: string[];
  /** 允许出口的域名；空 = 全断 */
  allowedDomains: string[];
  /** 拒读的绝对路径（敏感目录） */
  denyRead: string[];
}
export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}
export interface SkillSandbox {
  /** 在 settings 约束下跑 argv（argv[0] 是解释器绝对路径）。cwd/env 由调用方给。 */
  run(
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    settings: SandboxSettings,
  ): Promise<SandboxRunResult>;
}

/** 测试注入：直接把 impl 当 run，不碰真 srt/OS。 */
export function fakeSkillSandbox(impl: SkillSandbox["run"]): SkillSandbox {
  return { run: impl };
}

/** POSIX 单引号包每个 arg：'\'' 转义单引号。argv → 可交给 srt 的 shell 命令串。 */
function shellQuote(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

/** cmd.exe 引号语义：把每个 arg 包成 "..."，内部 `"` 转义为 `""`（CommandLineToArgvW 约定）。
 *  POSIX 单引号语义在 cmd 下不成立，故 win32 分支单列。纯函数，供单测覆盖。 */
export function cmdQuote(argv: string[]): string {
  return argv.map((a) => `"${a.replace(/"/g, `""`)}"`).join(" ");
}

/** F3：srt-win 经 `CreateProcessWithLogonW` 换账户后，broker 进程的自定义 env 不穿透到
 *  沙箱子进程，故 env 改经 cmd 内联 `set "K=V" && ...` 链前置到命令串（Gate 0 S6b 验证）。
 *  引号保护值里的空格/`&`；我们注入的都是受控绝对路径与常量，无需再防 `%`/`"`。 */
export function cmdEnvPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `set "${k}=${v}" && `)
    .join("");
}

/** Windows 沙箱的完整命令串 = env set 链 + quoted argv（交给 `wrapWithSandboxArgv(_, "cmd")`）。 */
export function buildWindowsCommand(argv: string[], env: Record<string, string>): string {
  return cmdEnvPrefix(env) + cmdQuote(argv);
}

/**
 * Windows 脚本沙箱设施就绪探针（spec §3.2 / F6）。非 win32 恒 ready（mac/linux 的沙箱
 * 就绪由 srt 在 run 时保证，既有行为不变）。win32 走 `verifyWindowsWfpEgress` 行为探针
 * （BLOCKED=围栏在位）——不看 BFE filter 枚举（非管理员必 cannot-read）。任何非 blocked
 * 结果都会 throw，转成 `{ ready:false }` + 原因，供 fail-closed 报错引导重装。
 */
export async function checkWindowsSandboxReady(): Promise<{ ready: boolean; reason?: string }> {
  if (!IS_WIN) return { ready: true };
  try {
    await verifyWindowsWfpEgress({ srtWin: resolveSrtWin({ path: srtWinPath() }) });
    return { ready: true };
  } catch (e) {
    return { ready: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// 全局串行化：SandboxManager 是单例，一次只允许一个沙箱运行。
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function drainCapped(stream: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  // 增量读 + 封顶 MAX_OUTPUT_BYTES：读满即停拼接，但继续排空管道（防子进程写阻塞死锁，
  // 同 2b realSkillSpawn 的教训——stdout/stderr 必须都排空）。
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (text.length <= MAX_OUTPUT_BYTES) {
      text += dec.decode(value, { stream: true });
      if (text.length > MAX_OUTPUT_BYTES) {
        text = text.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
      }
    }
    // 已封顶：继续读走剩余 chunk，只是不再拼接。
  }
  return { text, truncated };
}

async function runViaSrt(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  settings: SandboxSettings,
): Promise<SandboxRunResult> {
  const runtimeConfig = {
    network: { allowedDomains: settings.allowedDomains, deniedDomains: [] },
    filesystem: {
      denyRead: settings.denyRead,
      allowRead: [],
      allowWrite: settings.allowWrite,
      denyWrite: [],
    },
    // win32：srt-win.exe 无隐式回落，须显式给出伴随文件路径（spec §6.1）。
    ...(IS_WIN ? { windows: { srtWin: { path: srtWinPath() } } } : {}),
  };
  await SandboxManager.initialize(runtimeConfig);
  try {
    await SandboxManager.waitForNetworkInitialization();
    // win32：cmd 引号语义 + env 内联 set 链（F3）；mac/linux：POSIX 引号，env 走 spawn。
    const command = IS_WIN ? buildWindowsCommand(argv, env) : shellQuote(argv);
    const binShell = IS_WIN ? "cmd" : undefined;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      binShell,
      undefined,
      undefined,
      cwd,
    );
    // 异步 spawn（关键：绝不 spawnSync，见文件头注释）。
    // win32 的 env 已内联进命令串（不穿透沙箱账户，见 F3），这里只带 process.env +
    // wrapped.env（srt 代理注入，配置 srt-win 自身，必须保留）；mac/linux 才把 caller env
    // 交给 spawn。
    const proc = Bun.spawn({
      cmd: wrapped.argv,
      cwd,
      env: { ...process.env, ...(IS_WIN ? {} : env), ...(wrapped.env as Record<string, string>) },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);
    try {
      const [out, err, exitCode] = await Promise.all([
        drainCapped(proc.stdout),
        drainCapped(proc.stderr),
        proc.exited,
      ]);
      // F2：win32 上 Bun 会把 NTSTATUS 退出码截断为低 8 位（如 0xC0000135→53）。
      // 原样透传，不做武断分类——诊断时用低 8 位反推 NTSTATUS。
      return {
        stdout: out.text,
        stderr: err.text,
        exitCode,
        timedOut,
        truncated: out.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  }
}

export const realSkillSandbox: SkillSandbox = {
  run: (argv, cwd, env, settings) => serialize(() => runViaSrt(argv, cwd, env, settings)),
};
