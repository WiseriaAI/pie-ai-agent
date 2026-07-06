import { unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { PROTOCOL_VERSION, BRIDGE_CAPABILITIES } from "../../src/types/local-bridge";
import type { BridgeResponse, RunLocalAgentParams, HandoffParams } from "../../src/types/local-bridge";
import { paths } from "./paths";
import { runLocalAgent } from "./run-local-agent"; // Task 4
import { runHandoff } from "./handoff";
import { detectAgents } from "./agents";
import { decodeNdjsonLines } from "./framing";
import { log } from "./log";

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
  const respond = (r: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): string =>
    JSON.stringify({ id, ...r } as BridgeResponse);

  switch (msg.method) {
    case "hello":
      return respond({
        ok: true,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: [...BRIDGE_CAPABILITIES] },
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
    case "list_agents":
      return respond({
        ok: true,
        result: { agents: detectAgents().map(({ id, label }) => ({ id, label })) },
      });
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
): { carry: string; pending: Promise<void> } {
  const { lines, carry: nextCarry } = decodeNdjsonLines(carry, chunk);
  const pending = Promise.all(lines.map((line) => handleMessage(line).then((out) => write(out + "\n")))).then(
    () => undefined,
  );
  return { carry: nextCarry, pending };
}

export async function startDaemon(): Promise<void> {
  if (!existsSync(paths.pieDir)) mkdirSync(paths.pieDir, { recursive: true });
  if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath); // 清残留
  Bun.listen<{ carry: string }>({
    unix: paths.socketPath,
    socket: {
      open(socket) {
        // 每个连接独立的 carry：Bun 的 per-socket data 绑定，多个 host 连接
        // （理论上）互不干扰各自的半行缓冲。
        socket.data = { carry: "" };
        log("info", "client.connect");
      },
      close() {
        log("info", "client.disconnect");
      },
      data(socket, data) {
        const { carry, pending } = processSocketChunk(socket.data.carry, data.toString(), (out) =>
          socket.write(out),
        );
        socket.data.carry = carry;
        pending.catch((err) => log("error", "socket.error", { err: String(err) }));
      },
    },
  });
  chmodSync(paths.socketPath, 0o600); // 用户级信任边界
  log("info", "daemon.listening", { socket: paths.socketPath });
  await new Promise(() => {}); // 常驻
}
