import { existsSync } from "fs";

/**
 * 静态候选表 = 唯一 launch 权威：spawn 的命令 / app 名只住在这里，绝不来自
 * wire 或 LLM 参数（wire 上只传 id，daemon 用 id 查表）。加新 agent = 加一行；
 * Hermes/Openclaw 等待用户提供真实 CLI 命令后再加——绝不凭空编 spawn 命令。
 * 顺序即 HandoffCard 的预选顺序：app 优先（无 shell、无 TCC，launch 最稳）。
 */
export interface AgentCandidate {
  id: "claude-app" | "claude-terminal" | "codex-terminal";
  label: string;
  kind: "app" | "terminal";
  /** terminal：start.command 里 exec 的命令 */
  bin?: "claude" | "codex";
  /** app：存在性检测路径 */
  appPath?: string;
  /** app：`open -a <appName>` 用的名字 */
  appName?: string;
}

export const AGENT_CANDIDATES: readonly AgentCandidate[] = [
  { id: "claude-app", label: "Claude Code (App)", kind: "app", appPath: "/Applications/Claude.app", appName: "Claude" },
  { id: "claude-terminal", label: "Claude Code (Terminal)", kind: "terminal", bin: "claude" },
  { id: "codex-terminal", label: "Codex (Terminal)", kind: "terminal", bin: "codex" },
];

export interface DetectOpts {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
}

/** 每次调用现检测（Bun.which / existsSync 都便宜，无缓存必要）；保持表顺序。 */
export function detectAgents(opts?: DetectOpts): AgentCandidate[] {
  const which = opts?.which ?? ((b: string) => Bun.which(b));
  const exists = opts?.exists ?? existsSync;
  return AGENT_CANDIDATES.filter((c) => (c.kind === "app" ? exists(c.appPath!) : which(c.bin!) != null));
}
