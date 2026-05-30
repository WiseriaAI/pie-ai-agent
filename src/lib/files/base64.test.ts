import { describe, it, expect } from "vitest";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64";

describe("base64 round-trip", () => {
  it("encodes and decodes a small known byte sequence", () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 128]).buffer;
    const b64 = arrayBufferToBase64(original);
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);
    const decoded = base64ToArrayBuffer(b64);
    expect(new Uint8Array(decoded)).toEqual(new Uint8Array(original));
  });

  it("round-trips a large buffer (100 000 bytes) to exercise chunking", () => {
    const size = 100_000;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = i % 256;
    const b64 = arrayBufferToBase64(original.buffer);
    const decoded = base64ToArrayBuffer(b64);
    expect(new Uint8Array(decoded)).toEqual(original);
  });

  it("handles an empty ArrayBuffer", () => {
    const b64 = arrayBufferToBase64(new ArrayBuffer(0));
    expect(b64).toBe("");
    const decoded = base64ToArrayBuffer(b64);
    expect(decoded.byteLength).toBe(0);
  });
});
