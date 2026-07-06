export type SpawnFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; exitCode: number; stderr?: string }>;

export const realSpawn: SpawnFn = async (cmd, args, cwd) => {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
