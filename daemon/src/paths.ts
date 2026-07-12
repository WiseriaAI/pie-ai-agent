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
  grantsPath: join(pieDir, "grants.json"),
  auditPath: join(pieDir, "logs", "audit.jsonl"),
};
