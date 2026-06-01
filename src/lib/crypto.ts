const SESSION_KEY_NAME = "encryption_key";

let keyPromise: Promise<CryptoKey> | null = null;

export async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;

  keyPromise = (async () => {
    try {
      const result = await chrome.storage.local.get(SESSION_KEY_NAME);
      if (result[SESSION_KEY_NAME]) {
        // Stored as Array.from(Uint8Array) → number[]; cast to satisfy Uint8Array constructor.
        const rawKey = new Uint8Array(result[SESSION_KEY_NAME] as number[]);
        return crypto.subtle.importKey("raw", rawKey, "AES-GCM", true, [
          "encrypt",
          "decrypt",
        ] as KeyUsage[]);
      }

      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey(
        "raw",
        rawKey,
        "AES-GCM",
        true,
        ["encrypt", "decrypt"] as KeyUsage[],
      );

      const exported = await crypto.subtle.exportKey("raw", key);
      await chrome.storage.local.set({
        [SESSION_KEY_NAME]: Array.from(new Uint8Array(exported)),
      });

      return key;
    } catch (e) {
      keyPromise = null;
      throw e;
    }
  })();

  return keyPromise;
}

export async function encrypt(
  plaintext: string,
  key: CryptoKey,
): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(
  encoded: string,
  key: CryptoKey,
): Promise<string> {
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error(
      "Failed to decrypt: encryption key may have changed after browser restart. Please re-enter your API key.",
    );
  }
}
