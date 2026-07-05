import { test, expect } from "bun:test";
import { encodeFrame, decodeFrames } from "../src/framing";

test("encode then decode round-trips", () => {
  const frame = encodeFrame({ hello: "world" });
  // 前 4 字节 = 长度
  const len = new DataView(frame.buffer).getUint32(0, true);
  expect(len).toBe(frame.byteLength - 4);
  const { messages, rest } = decodeFrames(frame);
  expect(messages).toEqual([{ hello: "world" }]);
  expect(rest.byteLength).toBe(0);
});

test("decode handles partial frame (keeps rest)", () => {
  const full = encodeFrame({ a: 1 });
  const partial = full.slice(0, full.byteLength - 2); // 缺尾 2 字节
  const { messages, rest } = decodeFrames(partial);
  expect(messages).toEqual([]);
  expect(rest.byteLength).toBe(partial.byteLength);
});

test("decode handles two concatenated frames", () => {
  const a = encodeFrame({ n: 1 });
  const b = encodeFrame({ n: 2 });
  const buf = new Uint8Array([...a, ...b]);
  const { messages } = decodeFrames(buf);
  expect(messages).toEqual([{ n: 1 }, { n: 2 }]);
});
