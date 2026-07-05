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
