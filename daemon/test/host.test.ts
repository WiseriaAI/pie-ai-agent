import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import type { Socket } from "bun";
import { connectHostSocket } from "../src/host";
import { encodeFrame } from "../src/framing";

// unix socket 路径受 sun_path ~104 字节上限——repo 深路径会 Failed to listen，
// 必须用系统 tmpdir 短路径。
function tmpSock(): string {
  return join(tmpdir(), "pie-host-" + Math.random().toString(36).slice(2) + ".sock");
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("relays daemon ndjson replies as framed writeOut bytes", async () => {
  const path = tmpSock();
  let serverSide: Socket | null = null;
  const server = Bun.listen({
    unix: path,
    socket: { data() {}, open(s) { serverSide = s; } },
  });
  const out: Uint8Array[] = [];
  const conn = await connectHostSocket(path, (b) => { out.push(b as Uint8Array); }, () => {});
  await until(() => serverSide !== null);
  const reply = { id: "1", ok: true, result: { x: 1 } };
  serverSide!.write(JSON.stringify(reply) + "\n");
  await until(() => out.length === 1);
  expect(out[0]).toEqual(encodeFrame(reply));
  conn.end();
  server.stop(true);
});

test("daemon dropping the socket triggers onDown (host must exit → Chrome fires onDisconnect)", async () => {
  const path = tmpSock();
  let serverSide: Socket | null = null;
  const server = Bun.listen({
    unix: path,
    socket: { data() {}, open(s) { serverSide = s; } },
  });
  let down: string | null = null;
  await connectHostSocket(path, () => {}, (reason) => { down ??= reason; });
  await until(() => serverSide !== null);
  serverSide!.end(); // daemon 进程死亡/重启 = 服务端掐掉连接
  await until(() => down !== null);
  expect(down).toContain("closed");
  server.stop(true);
});

test("connect failure rejects (daemon socket missing — runHost startup path exits the host)", async () => {
  const path = tmpSock(); // 从未 listen
  await expect(connectHostSocket(path, () => {}, () => {})).rejects.toBeDefined();
});
