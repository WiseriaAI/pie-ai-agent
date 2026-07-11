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
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

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
  };
  await SandboxManager.initialize(runtimeConfig);
  try {
    await SandboxManager.waitForNetworkInitialization();
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      shellQuote(argv),
      undefined,
      undefined,
      undefined,
      cwd,
    );
    // 异步 spawn（关键：绝不 spawnSync，见文件头注释）。
    const proc = Bun.spawn({
      cmd: wrapped.argv,
      cwd,
      env: { ...process.env, ...env, ...(wrapped.env as Record<string, string>) },
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
