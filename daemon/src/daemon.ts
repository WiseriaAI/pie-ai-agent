import { unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { PROTOCOL_VERSION, BRIDGE_CAPABILITIES } from "../../src/types/local-bridge";
import type { BridgeResponse, RunLocalAgentParams } from "../../src/types/local-bridge";
import { paths } from "./paths";
import { runLocalAgent } from "./run-local-agent"; // Task 4

export async function handleMessage(line: string): Promise<string> {
  let msg: { id?: string; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify({ id: "", ok: false, error: { code: "bad_json", message: "invalid JSON" } });
  }
  const id = msg.id ?? "";
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
        return respond({ ok: false, error: { code: "run_failed", message: String(e) } });
      }
    }
    default:
      return respond({ ok: false, error: { code: "unknown_method", message: String(msg.method) } });
  }
}

export async function startDaemon(): Promise<void> {
  if (!existsSync(paths.pieDir)) mkdirSync(paths.pieDir, { recursive: true });
  if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath); // 清残留
  Bun.listen({
    unix: paths.socketPath,
    socket: {
      data(socket, data) {
        const text = data.toString();
        for (const line of text.split("\n").filter(Boolean)) {
          handleMessage(line).then((out) => socket.write(out + "\n"));
        }
      },
    },
  });
  chmodSync(paths.socketPath, 0o600); // 用户级信任边界
  console.error(`[pie daemon] listening on ${paths.socketPath}`);
  await new Promise(() => {}); // 常驻
}
