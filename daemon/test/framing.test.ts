import { test, expect } from "bun:test";
import { encodeFrame, decodeFrames, decodeNdjsonLines } from "../src/framing";

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

test("encode/decode round-trips multibyte UTF-8 content", () => {
  // 中文文本：字符数 ≠ UTF-8 字节数，用来防止长度头回归成 string.length。
  const payload = { text: "你好，世界！这是一段多字节 UTF-8 测试文本。" };
  const frame = encodeFrame(payload);
  const jsonByteLength = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  const len = new DataView(frame.buffer).getUint32(0, true);
  // 长度头必须等于 UTF-8 字节长度，而不是 JS 字符串的 .length（char 数）
  expect(len).toBe(jsonByteLength);
  expect(len).not.toBe(JSON.stringify(payload).length);
  const { messages, rest } = decodeFrames(frame);
  expect(messages).toEqual([payload]);
  expect(rest.byteLength).toBe(0);
});

test("decodeNdjsonLines: single full line in one chunk", () => {
  const { lines, carry } = decodeNdjsonLines("", '{"a":1}\n');
  expect(lines).toEqual(['{"a":1}']);
  expect(carry).toBe("");
  expect(JSON.parse(lines[0])).toEqual({ a: 1 });
});

test("decodeNdjsonLines: line split across two chunks", () => {
  const first = decodeNdjsonLines("", '{"a":1');
  expect(first.lines).toEqual([]);
  expect(first.carry).toBe('{"a":1');

  const second = decodeNdjsonLines(first.carry, "}\n");
  expect(second.lines).toEqual(['{"a":1}']);
  expect(second.carry).toBe("");
  expect(JSON.parse(second.lines[0])).toEqual({ a: 1 });
});

test("decodeNdjsonLines: two complete lines + trailing partial in one chunk", () => {
  const { lines, carry } = decodeNdjsonLines("", '{"n":1}\n{"n":2}\n{"n":3');
  expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  expect(carry).toBe('{"n":3');
  expect(lines.map((l) => JSON.parse(l))).toEqual([{ n: 1 }, { n: 2 }]);
});
