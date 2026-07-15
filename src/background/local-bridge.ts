import {
  PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
  type RunLocalAgentParams,
  type RunLocalAgentResult,
  type HandoffParams,
  type HandoffResult,
  type ListAgentsResult,
  type ListSkillsResult,
  type ReadSkillFileParams,
  type ReadSkillFileResult,
  type RunSkillScriptParams,
  type RunSkillScriptResult,
  type ReadSessionFileParams,
  type ReadSessionFileResult,
  type DeleteSessionWorkspaceParams,
  type DeleteSessionWorkspaceResult,
  type WriteSkillParams,
  type WriteSkillResult,
  type DeleteSkillParams,
  type DeleteSkillResult,
  type ListGrantsResult,
  type RevokeGrantParams,
  type RevokeGrantResult,
  type SkillAuthPayload,
  type ListAuditParams,
  type ListAuditResult,
} from "@/types/local-bridge";

const HOST_NAME = "ai.wiseria.pie";

let port: chrome.runtime.Port | null = null;
let ready = false;
let capabilities: string[] = [];

// ── 版本握手（spec §6）──────────────────────────────────────────────
// 扩展内置最低 daemon 版本；daemonVersion < MIN = 软升级提示（功能按 capability
// 降级继续用）。旧 daemon 不带 daemonVersion → daemonVersion=null → 视为过旧。
export const MIN_DAEMON_VERSION = "0.1.0";
let daemonVersion: string | null = null;
let protocolMismatch = false;

/** 简单三段 semver 比较，够用（daemon 版本我们自己发，无 prerelease）。 */
export function compareDaemonVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function bridgeDaemonVersion(): string | null {
  return daemonVersion;
}
/** 连上但版本过旧（含旧 daemon 不带 daemonVersion 的情况）。软提示：功能按 capability 降级继续用。 */
export function bridgeNeedsUpgrade(): boolean {
  return ready && (daemonVersion === null || compareDaemonVersions(daemonVersion, MIN_DAEMON_VERSION) < 0);
}
/** PROTOCOL_VERSION 差 >1 = 硬不兼容（沿用现有 ±1 兼容窗口判定）。 */
export function bridgeProtocolMismatch(): boolean {
  return protocolMismatch;
}

// ── 安装引导漏斗（spec §7）────────────────────────────────────────────
// 设置页安装卡片状态机的判定源。connected = 桥通；not_installed = host manifest
// 不存在（或 EXT_ID 不匹配，用户同样需重装）；installed_not_running = host 在但
// daemon 未跑；unknown = 从未连过 / 用户关掉开关（沿用旧文案，向后兼容）。
export type BridgeInstallState = "connected" | "not_installed" | "installed_not_running" | "unknown";
let installState: BridgeInstallState = "unknown";

/** Chrome onDisconnect lastError 文案分类。not found = 未装 host manifest；
 *  forbidden = manifest 在但 EXT_ID 不匹配（对用户同样呈现为「重新安装」）。 */
export function classifyDisconnect(message: string | undefined): "not_installed" | "installed_not_running" {
  if (!message) return "installed_not_running";
  return /not found|forbidden/i.test(message) ? "not_installed" : "installed_not_running";
}

export function bridgeInstallState(): BridgeInstallState {
  return installState;
}
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// 握手落定 promise：从未 init 过 → 已 resolve；initLocalBridge() 换上新的 pending
// promise，握手 .then/.catch 落定（或 connectNative 失败 / disconnect）后 resolve。
// 用途：SW 冷启动时想等"桥要么连上要么确定连不上"再决定要不要装配本地工具，避免竞态。
let settledPromise: Promise<void> = Promise.resolve();

export function bridgeSettled(): Promise<void> {
  return settledPromise;
}

export function isBridgeReady(): boolean {
  return ready;
}
export function bridgeCapabilities(): string[] {
  return capabilities;
}
export function bridgeHasSkillFs(): boolean {
  return ready && capabilities.includes("skill_fs");
}

// ── 自动重连（退避）──────────────────────────────────────────────────
// SW 存活期内桥意外断开（daemon 重启/热替换/崩溃）→ 按退避序列重试；用户显式
// 关闭不重试。SW 被回收则计时器自然消失，下次唤醒由 startup 兜底。真机案例：
// Slice 2 验收期 daemon 重启后 UI 掉回 IDB 模式直到手动刷新扩展。
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let userDisabled = false;
let reconnectAction: (() => void) | null = null;

/** index.ts 注入重连动作（initBridgeAndMigrate）——动作注入避免反向依赖 skill-migration。 */
export function setBridgeReconnectAction(fn: () => void): void {
  reconnectAction = fn;
}

/** Test-only：清重连状态。 */
export function __resetBridgeReconnectState(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  userDisabled = false;
  reconnectAction = null;
}

function scheduleReconnect(): void {
  if (userDisabled || !reconnectAction || reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAction?.();
  }, delay);
}

function send(method: BridgeRequest["method"], params: unknown): Promise<unknown> {
  if (!port) return Promise.reject(new Error("bridge not connected"));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ id, method, params });
  });
}

export function initLocalBridge(): void {
  // 每次 init 造一个新的落定 promise；resolver 由本次 init 的闭包独占——
  // 重叠 init 时，旧 handshake 只落定自己那个 promise，不会错序落定新的。
  let settleThis!: () => void;
  settledPromise = new Promise<void>((r) => { settleThis = r; });
  // (a) 重叠 init：若上一条连接还挂着（SW 唤醒兜底在活着的 SW 上重入
  // initBridgeAndMigrate 时会发生），先拆掉它，避免旧 host 进程泄漏 + 旧 port
  // 的 stale onDisconnect 迟到触发清掉健康的新连接。port.disconnect() 不触发
  // 自身的 onDisconnect（Chrome 语义），故这里不会误清新状态。
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already dead */
    }
  }
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    // 未装 daemon / 无 nativeMessaging 权限 → 静默降级；清掉任何残留状态，
    // 避免失败的重新 init 留下上一次连接的 stale ready/capabilities/pending。
    port = null;
    ready = false;
    capabilities = [];
    daemonVersion = null;
    installState = "not_installed"; // connectNative throw = host manifest/权限缺失
    pending.clear();
    settleThis();
    // 重连尝试本身失败（daemon 仍在重启中，端口都没建起来）→ onDisconnect 永远
    // 不会触发，若不在这里续排就等于梯子死掉；scheduleReconnect 自带
    // userDisabled/单飞守卫，此处调用安全不会重复排。
    scheduleReconnect();
    return;
  }
  // (b) 每个监听器/回调闭包捕获自己那次 init 的 port（myPort），共享的模块级
  // 状态（ready/capabilities/onDisconnect 清理、握手落定）只由「当前 port ===
  // myPort」的那一路改。重叠 init 后旧 port 的迟到回调 port !== myPort → 自动
  // 失效，不会清掉/污染健康的新连接。与 settledPromise「resolver 由本次 init
  // 闭包独占」是同一模式。
  const myPort = port;
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as BridgeResponse;
    // 回复按 uuid 路由（pending 全局唯一键），无需 port 门控——即便旧 port 迟到
    // 送回一条属于自己那次请求的回复，pending.get 命中的也只是它自己的 entry。
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(msg.error.message);
      // 非枚举：防止 JSON.stringify(err) 把内部错误码泄进 LLM 可见文案
      Object.defineProperty(err, "code", { value: msg.error.code, enumerable: false });
      if (msg.error.data !== undefined)
        // 非枚举：与 code 同理，防 JSON.stringify(err) 把 payload 泄进 LLM 可见文案
        Object.defineProperty(err, "data", { value: msg.error.data, enumerable: false });
      p.reject(err);
    }
  });
  port.onDisconnect.addListener(() => {
    // 读一下避免 Chrome 打印 "Unchecked runtime.lastError"，同时拿来分类安装态。
    const lastErr = chrome.runtime?.lastError?.message;
    // stale 守卫：旧 port 断开时若已被新 init 换掉，这里什么都不做——绝不清掉
    // 健康的新连接状态，也绝不 mass-reject 属于新连接的 pending。
    if (port !== myPort) return;
    installState = classifyDisconnect(lastErr);
    ready = false;
    port = null;
    capabilities = [];
    daemonVersion = null; // protocolMismatch 保留到下次握手覆盖（断连间隙仍显示硬不兼容提示）
    for (const p of pending.values()) p.reject(new Error("bridge disconnected"));
    pending.clear();
    scheduleReconnect();
  });
  // 握手
  send("hello", { protocolVersion: PROTOCOL_VERSION })
    .then((r) => {
      // stale 守卫：本次 init 已被后来的重叠 init 取代 → 只落定自己的 settled
      // promise（避免悬空），不碰共享的 ready/capabilities/reconnectAttempt/
      // protocolMismatch。
      if (port !== myPort) {
        settleThis();
        return;
      }
      const res = r as { protocolVersion: number; capabilities: string[]; daemonVersion?: string };
      // 兼容窗口：差 ≤1 视为兼容（spec §7）；差 >1 = 硬不兼容
      protocolMismatch = Math.abs(res.protocolVersion - PROTOCOL_VERSION) > 1;
      if (!protocolMismatch) {
        capabilities = res.capabilities;
        daemonVersion = res.daemonVersion ?? null;
        ready = true;
        installState = "connected";
        reconnectAttempt = 0;
      }
      settleThis();
    })
    .catch(() => {
      // stale 守卫同上：被取代的 init 不再清共享 ready、也不续排梯子（那是新
      // 连接的职责），只落定自己的 settled promise。
      if (port !== myPort) {
        settleThis();
        return;
      }
      ready = false;
      settleThis();
      // 握手本身失败（端口建起来了但 hello 被拒/超时）同样不会经过 onDisconnect
      // —— 同上，必须在这里主动续排梯子，否则 daemon 恢复后桥永远连不回去。
      scheduleReconnect();
    });
}

export async function requestLocalAgent(params: RunLocalAgentParams): Promise<RunLocalAgentResult> {
  const r = await send("run_local_agent", params);
  return r as RunLocalAgentResult;
}

export async function requestHandoff(params: HandoffParams): Promise<HandoffResult> {
  const r = await send("handoff_to_agent", params);
  return r as HandoffResult;
}

export async function requestListAgents(): Promise<
  { id: string; label: string; installed: boolean; kind?: "app" | "terminal" }[]
> {
  // 旧 daemon（无 list_agents capability）降级为单项 legacy 列表：id "claude"
  // 是旧 wire 值，installed 视为 true（维持旧 daemon 可 handoff 的语义）。
  if (!capabilities.includes("list_agents")) {
    return [{ id: "claude", label: "Claude Code (Terminal)", installed: true }];
  }
  const r = (await send("list_agents", {})) as ListAgentsResult;
  return r.agents;
}

export async function requestListSkills(): Promise<ListSkillsResult> {
  return (await send("list_skills", {})) as ListSkillsResult;
}
export async function requestReadSkillFile(p: ReadSkillFileParams): Promise<ReadSkillFileResult> {
  return (await send("read_skill_file", p)) as ReadSkillFileResult;
}
export type RunSkillScriptOutcome =
  | { ok: true; result: RunSkillScriptResult }
  | { ok: false; needsAuth: true; auth?: SkillAuthPayload }
  | { ok: false; needsAuth: false; error: string };
export async function requestRunSkillScript(p: RunSkillScriptParams): Promise<RunSkillScriptOutcome> {
  try {
    return { ok: true, result: (await send("run_skill_script", p)) as RunSkillScriptResult };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "needs_authorization") {
      return { ok: false, needsAuth: true, auth: (e as { data?: SkillAuthPayload }).data };
    }
    return { ok: false, needsAuth: false, error: e instanceof Error ? e.message : String(e) };
  }
}
/** 读回 session workspace 内产物（read_skill_output tool → 此 RPC）。 */
export async function requestReadSessionFile(p: ReadSessionFileParams): Promise<ReadSessionFileResult> {
  return (await send("read_session_file", p)) as ReadSessionFileResult;
}
/** 硬删 / 归档 session 时清 workspace（幂等；桥断时静默失败由调用方 .catch 吞）。 */
export async function requestDeleteSessionWorkspace(
  p: DeleteSessionWorkspaceParams,
): Promise<DeleteSessionWorkspaceResult> {
  return (await send("delete_session_workspace", p)) as DeleteSessionWorkspaceResult;
}
export async function requestWriteSkill(p: WriteSkillParams): Promise<WriteSkillResult> {
  return (await send("write_skill", p)) as WriteSkillResult;
}
export async function requestDeleteSkill(p: DeleteSkillParams): Promise<DeleteSkillResult> {
  return (await send("delete_skill", p)) as DeleteSkillResult;
}
export async function requestListGrants(): Promise<ListGrantsResult> {
  return (await send("list_grants", {})) as ListGrantsResult;
}
export async function requestRevokeGrant(p: RevokeGrantParams): Promise<RevokeGrantResult> {
  return (await send("revoke_grant", p)) as RevokeGrantResult;
}
export async function requestListAudit(p: ListAuditParams = {}): Promise<ListAuditResult> {
  return (await send("list_audit", p)) as ListAuditResult;
}

/** SW 启动调用：仅当已授予 nativeMessaging 才连桥（纯 BYOK 用户零感知）。 */
export async function maybeInitLocalBridge(): Promise<void> {
  userDisabled = false;
  // 同步换上「init 决策」promise：SW 冷启动时，消息处理器里同 tick 的
  // bridgeSettled() 调用方若跑在 permissions IPC 前，拿到的不再是
  // module-init 的已 resolve promise（那会让首次读误判成 IDB 模式），
  // 而是等到决策（无权限→立即 / 有权限→握手落定）才 resolve。
  let settleDecision!: () => void;
  settledPromise = new Promise<void>((r) => { settleDecision = r; });
  try {
    const has = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
    if (has) {
      initLocalBridge(); // 同步把 settledPromise 换成真握手 promise
      // 决策 promise 链到握手落定：早抓到决策 promise 的调用方与
      // 晚抓到握手 promise 的调用方在同一时刻解除等待。
      void settledPromise.then(settleDecision);
    } else {
      settleDecision();
    }
  } catch {
    // permissions API 不可用（测试/老 Chrome）→ 静默跳过，但决策必须落定
    settleDecision();
  }
}

/** 用户在设置里关掉本地打通（移除 nativeMessaging）时断桥并清状态。 */
export function disconnectLocalBridge(): void {
  userDisabled = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already dead */
    }
  }
  port = null;
  ready = false;
  capabilities = [];
  daemonVersion = null;
  installState = "unknown"; // 用户主动关闭 → 回到「未启用」的中性态（沿用旧文案）
  for (const p of pending.values()) p.reject(new Error("bridge disabled"));
  pending.clear();
  // 落定级联：disconnect reject 掉 pending 的 hello → 其 .catch 调自己的 settleThis
}
