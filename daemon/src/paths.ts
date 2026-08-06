import { homedir } from "os";
import nodePath from "path";

/** Windows named pipe basename（`\\.\pipe\<PIPE_NAME>`）；对齐 mac socket 语义的单实例键。 */
export const PIPE_NAME = "ai.wiseria.pie";

export interface Paths {
  pieDir: string;
  /** daemon listen / host connect 的 IPC 地址：mac/linux = unix socket 文件；win32 = named pipe。 */
  ipcPath: string;
  /**
   * 历史字段名，等于 ipcPath；保留给 doctor/日志等既有调用点。
   * ⚠️ Windows 下这是一条 named pipe（`\\.\pipe\...`），不是磁盘文件——
   * 不要对它做 existsSync/unlinkSync/chmodSync（见 isPipe 守卫）。
   */
  socketPath: string;
  /** true = ipcPath 是 named pipe（无磁盘残留）：socket 文件清理/权限收敛在此平台为 no-op。 */
  isPipe: boolean;
  handoffsDir: string;
  logsDir: string;
  skillsDir: string;
  agentsSkillsDir: string;
  /** per-session 产物根：脚本 cwd + 唯一可写区（除声明过的 extraWrites）住在这里下面。 */
  sessionsDir: string;
  grantsPath: string;
  auditPath: string;
}

/**
 * 平台分支的路径清单（纯函数，可测）：
 * - mac/linux：`~/.pie/...`，IPC = `~/.pie/daemon.sock`（unix domain socket 文件）。
 * - win32：`%USERPROFILE%\.pie\...`，IPC = `\\.\pipe\ai.wiseria.pie`（named pipe，无磁盘文件）。
 *
 * 目录结构（sessions/skills/grants.json/logs）跨平台不变，只是分隔符与根随平台切换。
 * 测试可显式传 platform + home（+ 对应的 path 实现）在 mac 上覆盖 win32 形状。
 */
export function computePaths(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  p: typeof nodePath.win32 = platform === "win32" ? nodePath.win32 : nodePath.posix,
): Paths {
  const isWin = platform === "win32";
  const pieDir = p.join(home, ".pie");
  const ipcPath = isWin ? `\\\\.\\pipe\\${PIPE_NAME}` : p.join(pieDir, "daemon.sock");
  return {
    pieDir,
    ipcPath,
    socketPath: ipcPath,
    isPipe: isWin,
    handoffsDir: p.join(home, "pie-handoffs"),
    logsDir: p.join(pieDir, "logs"),
    skillsDir: p.join(pieDir, "skills"),
    agentsSkillsDir: p.join(home, ".agents", "skills"),
    sessionsDir: p.join(pieDir, "sessions"),
    grantsPath: p.join(pieDir, "grants.json"),
    auditPath: p.join(pieDir, "logs", "audit.jsonl"),
  };
}

export const paths: Paths = computePaths();

// sessionId 来自 wire，是不可信输入。crypto.randomUUID() 产的标准 UUID 形状；
// 严格校验挡住 "../"、绝对路径、空串、超长串等一切能拼出 workspace 之外的输入。
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 校验 sessionId 为 UUID 形状，非法即 throw（防路径穿越）。 */
export function assertSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

/** 某 session 的 workspace 绝对路径（脚本 cwd + 唯一可写区）。 */
export function sessionWorkspace(sessionId: string, sessionsDir: string = paths.sessionsDir): string {
  return nodePath.join(sessionsDir, assertSessionId(sessionId), "workspace");
}
