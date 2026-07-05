import { encodeFrame, decodeFrames } from "./framing";
import { paths } from "./paths";

// host 由 Chrome spawn；stdin=Chrome→host，stdout=host→Chrome。
// 每条帧 → daemon socket（ndjson）→ 回复 → 重新加帧写 stdout。
export async function runHost(): Promise<void> {
  const conn = await Bun.connect({
    unix: paths.socketPath,
    socket: {
      data(_s, data) {
        // socket 回复（ndjson）→ 加帧写 Chrome stdout
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const frame = encodeFrame(JSON.parse(line));
          Bun.write(Bun.stdout, frame);
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
