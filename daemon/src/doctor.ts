import { existsSync } from "fs";
import { paths } from "./paths";

export async function doctor(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const socketExists = existsSync(paths.socketPath);
  lines.push(`socket ${paths.socketPath}: ${socketExists ? "present" : "absent (daemon not running?)"}`);
  const claude = Bun.which("claude");
  lines.push(`claude CLI: ${claude ?? "NOT FOUND on PATH"}`);
  const ok = socketExists && claude != null;
  return { ok, lines };
}
