// 扩展 ↔ daemon 桥协议。此文件是唯一权威源；daemon 相对 import，不复制。
// 加字段只增不改语义；破坏性变更才 bump PROTOCOL_VERSION（spec §7）。

export const PROTOCOL_VERSION = 1;

/** daemon 声明它能处理的方法。扩展按此决定装配哪些本地工具。 */
export const BRIDGE_CAPABILITIES = ["run_local_agent", "handoff_to_agent", "list_agents"] as const;
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

// ── 握手 ──────────────────────────────────────────────────────────────
export interface HelloRequest {
  id: string;
  method: "hello";
  params: { protocolVersion: number };
}
export interface HelloResponse {
  id: string;
  ok: true;
  result: { protocolVersion: number; capabilities: string[] };
}

// ── run_local_agent ──────────────────────────────────────────────────
export interface RunLocalAgentParams {
  target: "claude"; // Slice 0 只 claude；codex 后续 slice
  prompt: string;
  /** 缺省 = daemon 建的临时 workspace ~/pie-handoffs/<slug>/ */
  cwd?: string;
}
export interface RunLocalAgentResult {
  output: string;
  exitCode: number;
  /** daemon 实际使用的 cwd（回填给卡片/audit） */
  cwd: string;
}

// ── list_agents ──────────────────────────────────────────────────────
/** daemon 静态候选表 ∩ 本机检测（CLI 走 Bun.which，app 走存在性）的结果。 */
export interface ListAgentsResult {
  agents: { id: string; label: string }[];
}

// ── handoff_to_agent ─────────────────────────────────────────────────
export interface HandoffParams {
  /**
   * agent id（用户在 HandoffCard 上选的，非 LLM 传入）。daemon 运行时校验
   * ∈ 本次检测到的 id 集；旧 wire 值 "claude" 是 claude-terminal 的 alias。
   */
  target: string;
  /** markdown brief，daemon 落盘为 context.md 供交互式 session 读取 */
  context: string;
  /** 可选：随交棒 stage 进 handoff 目录的文件（名字取 basename，防遍历） */
  files?: { name: string; content: string }[];
}
export interface HandoffResult {
  /** daemon 建的 handoff 目录（回填给侧栏卡片/observation） */
  dir: string;
  /** terminal = 自动开跑；app = Cowork 已打开但需用户发一句话启动 */
  mode: "terminal" | "app";
}

// ── 通用信封 ──────────────────────────────────────────────────────────
export interface BridgeRequest {
  id: string;
  method: "hello" | "run_local_agent" | "handoff_to_agent" | "list_agents";
  params: unknown;
}
export type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
