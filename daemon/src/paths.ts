import { homedir } from "os";
import { join } from "path";

const pieDir = join(homedir(), ".pie");
export const paths = {
  pieDir,
  socketPath: join(pieDir, "daemon.sock"),
  handoffsDir: join(homedir(), "pie-handoffs"),
  logsDir: join(pieDir, "logs"),
};
