export function encodeFrame(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, true); // 小端
  out.set(json, 4);
  return out;
}

export function decodeFrames(buf: Uint8Array): { messages: unknown[]; rest: Uint8Array } {
  const messages: unknown[] = [];
  let offset = 0;
  while (buf.byteLength - offset >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, true);
    if (buf.byteLength - offset - 4 < len) break; // 帧不全，留到下次
    const json = buf.slice(offset + 4, offset + 4 + len);
    messages.push(JSON.parse(new TextDecoder().decode(json)));
    offset += 4 + len;
  }
  return { messages, rest: buf.slice(offset) };
}

// Unix domain STREAM socket 不保留消息边界：daemon 的 ndjson 回复可能跨多个
// data 事件被截断（例如一行 JSON 被拆成两次回调）。这里做与 decodeFrames 对称的
// 纯函数累积：carry 存上次未完成的尾部片段，chunk 是本次新到达的数据；
// 只有以 \n 结尾的部分才算完整行，未完成的尾部继续留在新的 carry 里等下一次拼接。
export function decodeNdjsonLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split("\n");
  // split 后最后一个元素是没有被 \n 结尾的尾部（可能是空串，说明恰好整行结束）
  const newCarry = parts.pop() ?? "";
  const lines = parts.filter((line) => line.length > 0);
  return { lines, carry: newCarry };
}
