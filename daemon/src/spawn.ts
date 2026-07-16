export type SpawnFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; exitCode: number; stderr?: string }>;

export const realSpawn: SpawnFn = async (cmd, args, cwd) => {
  // 必须同时用 env 覆写 PWD=cwd：Bun.spawn 的 `cwd` 只改子进程的 getcwd，但子进程
  // 继承 daemon 进程的 `PWD` 环境变量（= daemon 启动目录）。opencode 等工具链信
  // `PWD` 胜过 getcwd → headless agent 会把文件写进 daemon 启动目录而非 workspace
  // （手动/脚本起 daemon 的 Terminal 环境必带 PWD）。POSIX 语义上 PWD 本就该反映
  // cwd，对 claude/codex/pi 等用真实 getcwd 的后端无害。
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    env: { ...process.env, PWD: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  // 必须并发排空 stdout 和 stderr：只 await stdout 会让 stderr 管道（OS 缓冲区
  // ~64KB）写满后阻塞子进程，子进程卡住不退出 → await proc.exited 永久挂起，
  // 而 send() 又无超时，整条 agent loop 跟着卡死。
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, exitCode, stderr };
};
