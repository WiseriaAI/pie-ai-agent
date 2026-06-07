import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests, getOrCreateEncryptionKey, encrypt, decrypt } from "./crypto";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("getOrCreateEncryptionKey", () => {
  it("returns a CryptoKey", async () => {
    const key = await getOrCreateEncryptionKey();
    expect(key).toBeInstanceOf(CryptoKey);
  });

  it("persists the raw key in config store", async () => {
    const { getConfig } = await import("@/lib/idb/config-store");
    await getOrCreateEncryptionKey();
    const raw = await getConfig<number[]>("encryption_key");
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(32);
  });

  it("returns the same key on second call (in-memory cache)", async () => {
    const key1 = await getOrCreateEncryptionKey();
    const key2 = await getOrCreateEncryptionKey();
    expect(key1).toBe(key2);
  });

  it("restores key from config store after cache reset", async () => {
    const { getConfig } = await import("@/lib/idb/config-store");

    // First call: creates and stores
    const key1 = await getOrCreateEncryptionKey();
    const raw = await getConfig<number[]>("encryption_key");
    expect(raw).toHaveLength(32);

    // Reset in-memory cache only (simulates SW restart, IDB persists)
    _resetKeyForTests();

    // Second call: should restore from IDB
    const key2 = await getOrCreateEncryptionKey();

    // Both keys should encrypt/decrypt the same data
    const plaintext = "hello world";
    const ciphertext = await encrypt(plaintext, key1);
    const decrypted = await decrypt(ciphertext, key2);
    expect(decrypted).toBe(plaintext);
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips plaintext", async () => {
    const key = await getOrCreateEncryptionKey();
    const plaintext = "secret message";
    const ciphertext = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for same plaintext (random IV)", async () => {
    const key = await getOrCreateEncryptionKey();
    const plaintext = "same input";
    const c1 = await encrypt(plaintext, key);
    const c2 = await encrypt(plaintext, key);
    expect(c1).not.toBe(c2);
  });

  it("throws on tampered ciphertext", async () => {
    const key = await getOrCreateEncryptionKey();
    const ciphertext = await encrypt("data", key);
    // Flip the last byte
    const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decrypt(tampered, key)).rejects.toThrow();
  });
});
