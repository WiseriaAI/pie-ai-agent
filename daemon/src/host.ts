import { encodeFrame, decodeFrames, decodeNdjsonLines } from "./framing";
import { paths } from "./paths";

// host 由 Chrome spawn；stdin=Chrome→host，stdout=host→Chrome。
// 每条帧 → daemon socket（ndjson）→ 回复 → 重新加帧写 stdout。
export async function runHost(): Promise<void> {
  // Unix domain STREAM socket 不保留消息边界：一条 ndjson 回复可能跨多个 data
  // 事件被截断，未缓冲直接 split("\n") + JSON.parse 会在同步 socket 回调里对
  // 不完整的尾部片段抛异常，拖垮整个 host 进程。carry 跨 data 事件累积尾部；
  // writeQueue 把每次的 stdout 写入串成一条 promise 链，保证多行/多次回调之间
  // 写 Chrome stdout 的顺序（请求/响应桥的消息顺序不能乱）。
  let carry = "";
  let writeQueue: Promise<unknown> = Promise.resolve();
  const conn = await Bun.connect({
    unix: paths.socketPath,
    socket: {
      data(_s, data) {
        // socket 回复（ndjson）→ 加帧写 Chrome stdout
        const { lines, carry: nextCarry } = decodeNdjsonLines(carry, data.toString());
        carry = nextCarry;
        for (const line of lines) {
          const frame = encodeFrame(JSON.parse(line));
          // 链上一次写完再写下一次；每一步都自带 catch，防止某次写失败让
          // 整条链变成 rejected（否则后续所有排队的写入都会被永久跳过）。
          writeQueue = writeQueue
            .then(() => Bun.write(Bun.stdout, frame))
            .catch((err) => console.error("host: stdout write failed", err));
        }
      },
    },
  });

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
