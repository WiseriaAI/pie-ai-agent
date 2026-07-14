import { homedir } from "os";
import { join } from "path";

const pieDir = join(homedir(), ".pie");
export const paths = {
  pieDir,
  socketPath: join(pieDir, "daemon.sock"),
  handoffsDir: join(homedir(), "pie-handoffs"),
  logsDir: join(pieDir, "logs"),
  skillsDir: join(pieDir, "skills"),
  agentsSkillsDir: join(homedir(), ".agents", "skills"),
  /** per-session 产物根：脚本 cwd + 唯一可写区（除声明过的 extraWrites）住在这里下面。 */
  sessionsDir: join(pieDir, "sessions"),
  grantsPath: join(pieDir, "grants.json"),
  auditPath: join(pieDir, "logs", "audit.jsonl"),
};

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
  return join(sessionsDir, assertSessionId(sessionId), "workspace");
}
