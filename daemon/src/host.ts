import type { Socket } from "bun";
import { encodeFrame, decodeFrames, decodeNdjsonLines } from "./framing";
import { paths } from "./paths";
import { connectWithBootstrap } from "./daemon-launcher";

// host 由 Chrome spawn；stdin=Chrome→host，stdout=host→Chrome。
// 每条帧 → daemon socket（ndjson）→ 回复 → 重新加帧写 stdout。

/**
 * 连 daemon socket 并中继：回复行加帧经 writeOut 送出；socket close/error → onDown。
 * onDown 是本模块的生死契约：daemon socket 一断，host 的存在意义即终结——调用方
 * 必须退出进程，让 Chrome 触发扩展侧 port.onDisconnect，交给退避重连拉起新 host。
 * 否则 host 僵活会让扩展永远误判"桥已连接"（真机 C 验收案例：kickstart 重启
 * daemon 后设置页假"已连接"、列表全空）。
 */
export async function connectHostSocket(
  socketPath: string,
  writeOut: (bytes: Uint8Array) => Promise<unknown> | unknown,
  onDown: (reason: string) => void,
): Promise<Socket> {
  // Unix domain STREAM socket 不保留消息边界：一条 ndjson 回复可能跨多个 data
  // 事件被截断，未缓冲直接 split("\n") + JSON.parse 会在同步 socket 回调里对
  // 不完整的尾部片段抛异常，拖垮整个 host 进程。carry 跨 data 事件累积尾部；
  // writeQueue 把每次的写出串成一条 promise 链，保证多行/多次回调之间写
  // Chrome stdout 的顺序（请求/响应桥的消息顺序不能乱）。
  let carry = "";
  let writeQueue: Promise<unknown> = Promise.resolve();
  return await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data) {
        // socket 回复（ndjson）→ 加帧写出
        const { lines, carry: nextCarry } = decodeNdjsonLines(carry, data.toString());
        carry = nextCarry;
        for (const line of lines) {
          const frame = encodeFrame(JSON.parse(line));
          // 链上一次写完再写下一次；每一步都自带 catch，防止某次写失败让
          // 整条链变成 rejected（否则后续所有排队的写入都会被永久跳过）。
          writeQueue = writeQueue
            .then(() => writeOut(frame))
            .catch((err) => console.error("host: stdout write failed", err));
        }
      },
      close() {
        onDown("daemon socket closed");
      },
      error(_s, err) {
        onDown(`daemon socket error: ${err}`);
      },
    },
  });
}

export async function runHost(): Promise<void> {
  const connectOnce = (): Promise<Socket> =>
    connectHostSocket(
      paths.ipcPath,
      (frame) => Bun.write(Bun.stdout, frame),
      (reason) => {
        console.error(`host: ${reason}; exiting so the extension can reconnect`);
        process.exit(1);
      },
    );

  // Windows 无 launchd KeepAlive：host 连不上 daemon（首连或崩溃后）就自己把 daemon
  // 拉起来再按退避梯子重连（spec §4.4）。mac/linux 保持原有「连一次，失败即抛→退出」
  // 语义不变——launchd 负责崩溃自愈，host 不越俎代庖多拉一个 daemon。
  const conn = paths.isPipe ? await connectWithBootstrap({ connect: connectOnce }) : await connectOnce();

  let buf = new Uint8Array(0);
  for await (const chunk of Bun.stdin.stream()) {
    const newBuf = new Uint8Array(buf.byteLength + chunk.byteLength);
    newBuf.set(buf);
    newBuf.set(chunk, buf.byteLength);
    buf = newBuf;
    const { messages, rest } = decodeFrames(buf);
    buf = new Uint8Array(rest);
    for (const msg of messages) conn.write(JSON.stringify(msg) + "\n");
  }
}
