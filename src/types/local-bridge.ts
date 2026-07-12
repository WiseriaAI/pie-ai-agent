// 扩展 ↔ daemon 桥协议。此文件是唯一权威源；daemon 相对 import，不复制。
// 加字段只增不改语义；破坏性变更才 bump PROTOCOL_VERSION（spec §7）。

export const PROTOCOL_VERSION = 1;

/** daemon 声明它能处理的方法。扩展按此决定装配哪些本地工具。 */
export const BRIDGE_CAPABILITIES = [
  "run_local_agent",
  "handoff_to_agent",
  "list_agents",
  "skill_fs",
] as const;
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
/** daemon 静态候选表全量（含未安装项，installed 标注检测结果——settings 页渲染"未安装"态需要）。 */
export interface ListAgentsResult {
  agents: { id: string; label: string; installed: boolean }[];
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

// ── skill_fs ──────────────────────────────────────────────────────────
/** skill 声明的高危能力（来自 SKILL.md metadata.pie）。 */
export interface SkillCaps {
  /** 允许出口的域名 */
  network: string[];
  /** 工作区外额外可写路径（可含 ~） */
  write: string[];
}
/** list_skills 每项：catalog 呈现 + 授权卡渲染所需的结构化摘要。 */
export interface SkillSummary {
  name: string;
  /** 展示名 = frontmatter.name（目录名产不出 ASCII slug 时两者不同，如中文名
   *  skill 迁到 hash 目录）；缺省同 name。身份/调用一律用 name（目录名）。 */
  displayName?: string;
  description: string;
  /** scripts/ 下可执行文件的相对名（如 "fetch.ts"）；run_skill_script 的 allowlist */
  runnableScripts: string[];
  declaredCaps: SkillCaps;
  /** 包内文件相对路径（POSIX 分隔；排除 workspace/ 与 .runs/ 及点文件；上限 200） */
  files: string[];
  /** 来源根：主根 ~/.pie/skills = "pie"，只读副根 ~/.agents/skills = "agents"。
   *  optional 加法字段：旧 daemon 不给 → 扩展按 "pie" 处理（无 badge）。 */
  source?: "pie" | "agents";
}
export interface ListSkillsResult {
  skills: SkillSummary[];
}

export interface ReadSkillFileParams {
  name: string;
  /** skill 目录内相对路径（如 "SKILL.md" / "references/foo.md"） */
  path: string;
}
export interface ReadSkillFileResult {
  content: string;
}

export interface RunSkillScriptParams {
  name: string;
  /** 必须 ∈ 该 skill runnableScripts */
  entry: string;
  /** CLI 风格参数 */
  args?: string[];
  /** 用户在授权卡批准后置 true；缺省首跑 ungranted skill 会回 needs_authorization */
  grantApproved?: boolean;
  /** 授权卡批准的信封 hash（grantApproved=true 时必带）；daemon 校验它等于
   *  当前磁盘信封的 hash，不等 → 重新 needs_authorization（堵卡片挂起期间
   *  skill 声明被改的 TOCTOU）。 */
  approvedEnvelopeHash?: string;
}
export interface RunSkillScriptResult {
  /** 脚本 stdout，调用方包 <untrusted_skill_content> */
  output: string;
  truncated?: boolean;
}

export interface WriteSkillFile {
  /** skill 目录内相对路径 */
  path: string;
  content: string;
}
export interface WriteSkillParams {
  name: string;
  files: WriteSkillFile[];
}
export interface WriteSkillResult {
  /** 落盘的 skill 目录绝对路径 */
  dir: string;
}

export interface DeleteSkillParams {
  name: string;
}
export interface DeleteSkillResult {
  deleted: boolean;
}

/** grant 信封：三者规范化后哈希即 grant 身份。 */
export interface GrantEnvelope {
  allowedDomains: string[];
  extraWrites: string[];
  runnableScripts: string[];
}
export interface GrantRecord {
  key: string;
  skillName: string;
  envelope: GrantEnvelope;
  grantedAt: number;
}
/** needs_authorization 错误随带的结构化 payload：授权卡的唯一渲染源（daemon 权威给出）。 */
export interface SkillAuthPayload {
  skillName: string;
  displayName?: string;
  description: string;
  /** canonical 化后的信封（卡上原文展示） */
  envelope: GrantEnvelope;
  /** 批准后随 run 回传（approvedEnvelopeHash） */
  envelopeHash: string;
}
export interface ListGrantsResult {
  grants: GrantRecord[];
}
export interface RevokeGrantParams {
  key: string;
}
export interface RevokeGrantResult {
  revoked: boolean;
}

/** audit.jsonl 单行（daemon 每次脚本执行追加）。 */
export interface AuditEntry {
  ts: number;
  skillName: string;
  entry: string;
  envelope: GrantEnvelope;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}
export interface ListAuditParams {
  /** 返回最近 N 条（默认 20，上限 200） */
  limit?: number;
}
export interface ListAuditResult {
  entries: AuditEntry[];
}

// ── 通用信封 ──────────────────────────────────────────────────────────
export interface BridgeRequest {
  id: string;
  method:
    | "hello"
    | "run_local_agent"
    | "handoff_to_agent"
    | "list_agents"
    | "list_skills"
    | "read_skill_file"
    | "run_skill_script"
    | "write_skill"
    | "delete_skill"
    | "list_grants"
    | "revoke_grant"
    | "list_audit";
  params: unknown;
}
export type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };
