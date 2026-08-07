import { unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { PROTOCOL_VERSION, BRIDGE_CAPABILITIES } from "../../src/types/local-bridge";
import { DAEMON_VERSION } from "./version";
import type { BridgeResponse, RunLocalAgentParams, HandoffParams, ListAgentsResult } from "../../src/types/local-bridge";
import { paths } from "./paths";
import { runLocalAgent } from "./run-local-agent"; // Task 4
import { runHandoff } from "./handoff";
import { detectAgents, AGENT_CANDIDATES } from "./agents";
import { decodeNdjsonLines } from "./framing";
import { log } from "./log";
import { readSkillFile, writeSkill, listSkillsMerged, resolveSkillRoot, deleteSkillGuarded, readSessionFile, deleteSessionWorkspace, sweepSessions } from "./skill-store";
import { runSkillScript } from "./skill-exec";
import { listGrants, revokeGrant, sweepGrants } from "./grants";
import { readAuditTail } from "./audit";
import { getStatus, markExtensionSocket, dropSocket } from "./status";
import { isAddrInUseError } from "./daemon-launcher";
import type {
  ReadSkillFileParams, RunSkillScriptParams, WriteSkillParams, DeleteSkillParams, RevokeGrantParams,
  ListAuditParams, ListAuditResult, ReadSessionFileParams, DeleteSessionWorkspaceParams,
} from "../../src/types/local-bridge";

export async function handleMessage(line: string): Promise<string> {
  let msg: { id?: string; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    log("warn", "request.bad_json");
    return JSON.stringify({ id: "", ok: false, error: { code: "bad_json", message: "invalid JSON" } });
  }
  const id = msg.id ?? "";
  log("info", "request", { id, method: msg.method });
  const respond = (
    r: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; data?: unknown } },
  ): string => JSON.stringify({ id, ...r } as BridgeResponse);

  switch (msg.method) {
    case "hello":
      return respond({
        ok: true,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: [...BRIDGE_CAPABILITIES], daemonVersion: DAEMON_VERSION },
      });
    case "run_local_agent": {
      try {
        const result = await runLocalAgent(msg.params as RunLocalAgentParams);
        return respond({ ok: true, result });
      } catch (e) {
        log("error", "run.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "run_failed", message: String(e) } });
      }
    }
    case "handoff_to_agent": {
      try {
        const result = await runHandoff(msg.params as HandoffParams);
        return respond({ ok: true, result });
      } catch (e) {
        log("error", "handoff.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "handoff_failed", message: String(e) } });
      }
    }
    case "list_agents": {
      // 与兄弟 case 同构的 try/catch：SW 的 send() 无超时，这里若抛异常会
      // 让 handleMessage 整体 reject → socket 层只 log 不回包 → 工具永久挂起。
      try {
        const detected = new Set(detectAgents().map((a) => a.id));
        const result: ListAgentsResult = {
          agents: AGENT_CANDIDATES.map(({ id, label, kind, headlessArgv }) => ({
            id,
            label,
            kind,
            installed: detected.has(id),
            // run_local_agent 卡片据此只列可作 headless 后端者；与 daemon 校验闸同一真源。
            headless: !!headlessArgv?.length,
          })),
        };
        return respond({ ok: true, result });
      } catch (e) {
        log("error", "list_agents.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_agents_failed", message: String(e) } });
      }
    }
    case "list_skills": {
      try {
        const skills = listSkillsMerged();
        // 作者信号：某个 skill 的 metadata.pie.network 里有归一化不出合法域名的条目
        // （被安全丢弃、srt 运行时会断这些网），打一行 warn 让作者能查到原因。
        for (const s of skills) {
          if (s.invalidNetwork && s.invalidNetwork.length > 0) {
            log("warn", "skill.invalid_network", { skill: s.name, invalid: s.invalidNetwork });
          }
        }
        return respond({ ok: true, result: { skills } });
      } catch (e) {
        log("error", "list_skills.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_skills_failed", message: String(e) } });
      }
    }
    case "read_skill_file": {
      try {
        const p = msg.params as ReadSkillFileParams;
        const located = resolveSkillRoot(p.name);
        // 未命中任何根 → 按主根路径读，让 ENOENT 自然抛出（错误语义与单根时代一致）
        const content = readSkillFile(p.name, p.path, located?.root ?? paths.skillsDir);
        return respond({ ok: true, result: { content } });
      } catch (e) {
        log("error", "read_skill_file.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "read_skill_file_failed", message: String(e) } });
      }
    }
    case "run_skill_script": {
      try {
        const result = await runSkillScript(msg.params as RunSkillScriptParams);
        return respond({ ok: true, result });
      } catch (e) {
        // 保留业务错误码（needs_authorization / unknown_skill / unknown_entry / timeout / script_error）
        const code = (e as { code?: string }).code ?? "run_skill_script_failed";
        const data = (e as { data?: unknown }).data;
        log("error", "run_skill_script.failed", { id, code, error: String(e) });
        return respond({
          ok: false,
          error: { code, message: String(e), ...(data !== undefined ? { data } : {}) },
        });
      }
    }
    case "read_session_file": {
      try {
        const p = msg.params as ReadSessionFileParams;
        const content = readSessionFile(p.sessionId, p.path);
        return respond({ ok: true, result: { content } });
      } catch (e) {
        log("error", "read_session_file.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "read_session_file_failed", message: String(e) } });
      }
    }
    case "delete_session_workspace": {
      try {
        const p = msg.params as DeleteSessionWorkspaceParams;
        return respond({ ok: true, result: { deleted: deleteSessionWorkspace(p.sessionId) } });
      } catch (e) {
        log("error", "delete_session_workspace.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "delete_session_workspace_failed", message: String(e) } });
      }
    }
    case "write_skill": {
      try {
        const p = msg.params as WriteSkillParams;
        return respond({ ok: true, result: writeSkill(p.name, p.files) });
      } catch (e) {
        log("error", "write_skill.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "write_skill_failed", message: String(e) } });
      }
    }
    case "delete_skill": {
      try {
        const p = msg.params as DeleteSkillParams;
        return respond({ ok: true, result: { deleted: deleteSkillGuarded(p.name) } });
      } catch (e) {
        const code = (e as { code?: string }).code ?? "delete_skill_failed";
        log("error", "delete_skill.failed", { id, code, error: String(e) });
        return respond({ ok: false, error: { code, message: String(e) } });
      }
    }
    case "list_grants": {
      try {
        return respond({ ok: true, result: { grants: listGrants() } });
      } catch (e) {
        log("error", "list_grants.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_grants_failed", message: String(e) } });
      }
    }
    case "revoke_grant": {
      try {
        const p = msg.params as RevokeGrantParams;
        return respond({ ok: true, result: { revoked: revokeGrant(p.key) } });
      } catch (e) {
        log("error", "revoke_grant.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "revoke_grant_failed", message: String(e) } });
      }
    }
    case "list_audit": {
      try {
        const p = (msg.params ?? {}) as ListAuditParams;
        return respond({ ok: true, result: { entries: readAuditTail(p.limit) } satisfies ListAuditResult });
      } catch (e) {
        log("error", "list_audit.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "list_audit_failed", message: String(e) } });
      }
    }
    case "status": {
      try {
        return respond({ ok: true, result: getStatus() });
      } catch (e) {
        log("error", "status.failed", { id, error: String(e) });
        return respond({ ok: false, error: { code: "status_failed", message: String(e) } });
      }
    }
    default:
      log("warn", "request.unknown_method", { id, method: String(msg.method) });
      return respond({ ok: false, error: { code: "unknown_method", message: String(msg.method) } });
  }
}

// Unix domain STREAM socket 不保留消息边界：一个 run_local_agent 请求的 JSON
// 可能跨两次 data 回调被截断。未缓冲直接 split("\n") 会让两个半行各自 JSON.parse
// 失败 → daemon 回 {id:"",...bad_json} → SW 里没有 id="" 的 pending 请求能匹配
// 上 → 工具永久挂起。这是 host 侧（commit 69c17be1，见 host.ts）已经修过的同一个
// bug，这里对称地在 daemon 的 socket 层复用 decodeNdjsonLines。
//
// 抽成纯函数是为了绕开「Bun.listen 的真实 socket 不可单测」的问题：调用方只需
// 传入 carry + 本次 chunk + 一个 write 回调，就能在测试里断言半行不会被提前
// dispatch、且下一次 chunk 到达后能拼出完整消息。
export function processSocketChunk(
  carry: string,
  chunk: string,
  write: (out: string) => void,
): { carry: string; pending: Promise<void>; sawHello: boolean } {
  const { lines, carry: nextCarry } = decodeNdjsonLines(carry, chunk);
  // 扩展 host 连接会发 hello，顶栏 app 不发 → 发过 hello 的 socket 记为扩展连接。
  // 双 parse 只在含 hello 的这一次 chunk 发生，代价可忽略。
  const sawHello = lines.some((l) => {
    try {
      return (JSON.parse(l) as { method?: string }).method === "hello";
    } catch {
      return false;
    }
  });
  const pending = Promise.all(lines.map((line) => handleMessage(line).then((out) => write(out + "\n")))).then(
    () => undefined,
  );
  return { carry: nextCarry, pending, sawHello };
}

// socket.write 在内核缓冲满时只写入部分字节（真机案例：32 个 ~/.agents skill
// 的 list_skills 响应 >8KB，首个 8192B 块之外的余量被丢弃，客户端永远等不到
// 完整行）。写出器缓存余量、drain 回调续写；响应含多字节 UTF-8（skill 中文
// 描述），余量必须按字节切，故内部一律 Uint8Array。有积压时新响应只排队，
// 保证单条响应的字节连续性。
export interface BackpressureWriter {
  write(out: string): void;
  drain(): void;
  pendingBytes(): number;
}

export function makeBackpressureWriter(rawWrite: (bytes: Uint8Array) => number): BackpressureWriter {
  const enc = new TextEncoder();
  const outbox: Uint8Array[] = [];
  function flush(): void {
    while (outbox.length > 0) {
      const head = outbox[0]!;
      const n = rawWrite(head);
      if (n < head.length) {
        outbox[0] = head.subarray(Math.max(n, 0));
        return; // 缓冲又满了，等下一次 drain
      }
      outbox.shift();
    }
  }
  return {
    write(out: string) {
      outbox.push(enc.encode(out));
      if (outbox.length === 1) flush();
    },
    drain: flush,
    pendingBytes: () => outbox.reduce((a, b) => a + b.length, 0),
  };
}

/**
 * 抢 pipe 前先探一手：连得上说明已有 daemon 在服务这条 pipe，本进程让位。
 *
 * 为什么不能只靠 `Bun.listen` 抛 EADDRINUSE：Windows named pipe 名被占用时 Bun 1.3.11
 * **不是抛异常而是 panic**——listen 失败走 errdefer deinit，撞上
 * `Listener.zig:479` 的 `bun.assert(this.listener == .none)`，整个进程带着
 * "Internal assertion failure" 崩掉，catch 不到（Windows 11 真机实测，已报上游）。
 * 探测走「连接成功与否」而不是「异常长什么样」，与 Bun 的错误行为解耦。
 *
 * 残留竞态：两个 daemon 同时起、都探到没人时仍会撞 panic。这窗口只有毫秒级，且两边
 * 都是刚启动无状态，实践上由 host 侧「只拉一次」的约束兜住，不再加锁。
 */
export async function pipeAlreadyServed(ipcPath: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: ipcPath, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(): Promise<void> {
  if (!existsSync(paths.pieDir)) mkdirSync(paths.pieDir, { recursive: true });
  sweepGrants(); // 一次性幂等清扫 2b 旧格式死记录，保持授权账本干净
  // 启动 GC：清超 30 天的孤儿 session workspace（桥断/卸载遗留）。best-effort，不阻塞启动。
  try {
    const swept = sweepSessions();
    if (swept > 0) log("info", "sessions.gc", { removed: swept });
  } catch (e) {
    log("warn", "sessions.gc_failed", { error: String(e) });
  }
  // 单实例互斥（Windows）：named pipe 无磁盘文件，占用与否只能靠探测——且 Bun 在
  // pipe 被占时会 panic 而非抛错，必须抢 listen 之前就让位。见 pipeAlreadyServed。
  if (paths.isPipe && (await pipeAlreadyServed(paths.ipcPath))) {
    log("info", "daemon.already_running", { ipc: paths.ipcPath });
    return;
  }
  // socket 文件残留清理仅对 unix domain socket 有意义；Windows named pipe 无磁盘文件。
  if (!paths.isPipe && existsSync(paths.ipcPath)) unlinkSync(paths.ipcPath); // 清残留
  try {
    Bun.listen<{ carry: string; writer: BackpressureWriter }>({
      unix: paths.ipcPath,
      socket: {
        open(socket) {
          // 每个连接独立的 carry：Bun 的 per-socket data 绑定，多个 host 连接
          // （理论上）互不干扰各自的半行缓冲。
          socket.data = { carry: "", writer: makeBackpressureWriter((bytes) => socket.write(bytes)) };
          log("info", "client.connect");
        },
        close(socket) {
          dropSocket(socket);
          log("info", "client.disconnect");
        },
        data(socket, data) {
          const { carry, pending, sawHello } = processSocketChunk(socket.data.carry, data.toString(), (out) =>
            socket.data.writer.write(out),
          );
          if (sawHello) markExtensionSocket(socket);
          socket.data.carry = carry;
          pending.catch((err) => log("error", "socket.error", { err: String(err) }));
        },
        drain(socket) {
          socket.data.writer.drain();
        },
      },
    });
  } catch (e) {
    // 单实例互斥兜底：socket 已被在跑的 daemon 占用（mac unix socket = EADDRINUSE）
    // → 干净退出，把地盘让给现有实例，别抛栈污染日志。Windows 侧的主判定在上面的
    // pipeAlreadyServed（Bun 那条路径不抛异常、直接 panic，走不到这里）。
    if (isAddrInUseError(e)) {
      log("info", "daemon.already_running", { ipc: paths.ipcPath });
      return;
    }
    throw e;
  }
  // chmod 收敛到用户级信任边界仅适用于 socket 文件；named pipe 的 ACL 由创建者默认收敛，
  // 且路径不在文件系统命名空间，chmodSync 会 ENOENT——Windows 下跳过。
  if (!paths.isPipe) chmodSync(paths.ipcPath, 0o600); // 用户级信任边界
  log("info", "daemon.listening", { socket: paths.ipcPath });
  await new Promise(() => {}); // 常驻
}
