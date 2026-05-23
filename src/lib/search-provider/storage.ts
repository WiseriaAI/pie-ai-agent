import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";
import type { SearchProviderId } from "./types";

interface StoredEntry {
  encryptedKey: string;
  lastVerifiedAt?: number;
}

function storageKeyFor(id: SearchProviderId): string {
  return `search_provider_${id}`;
}

async function read(id: SearchProviderId): Promise<StoredEntry | null> {
  const k = storageKeyFor(id);
  const got = await chrome.storage.local.get(k);
  const v = (got as Record<string, unknown>)[k];
  return (v as StoredEntry | undefined) ?? null;
}

async function write(id: SearchProviderId, entry: StoredEntry): Promise<void> {
  await chrome.storage.local.set({ [storageKeyFor(id)]: entry });
}

export async function getSearchProviderKey(id: SearchProviderId): Promise<string | null> {
  const entry = await read(id);
  if (!entry) return null;
  const cryptoKey = await getOrCreateEncryptionKey();
  return decrypt(entry.encryptedKey, cryptoKey);
}

export async function setSearchProviderKey(
  id: SearchProviderId,
  plainKey: string,
): Promise<void> {
  const cryptoKey = await getOrCreateEncryptionKey();
  const encryptedKey = await encrypt(plainKey, cryptoKey);
  await write(id, { encryptedKey });
}

export async function clearSearchProviderKey(id: SearchProviderId): Promise<void> {
  await chrome.storage.local.remove(storageKeyFor(id));
}

export async function markVerified(id: SearchProviderId): Promise<void> {
  const entry = await read(id);
  if (!entry) return;
  await write(id, { ...entry, lastVerifiedAt: Date.now() });
}

export async function getSearchProviderStatus(
  id: SearchProviderId,
): Promise<{ configured: boolean; lastVerifiedAt?: number; maskedKey?: string }> {
  const entry = await read(id);
  if (!entry) return { configured: false };
  const plain = await getSearchProviderKey(id);
  return {
    configured: true,
    lastVerifiedAt: entry.lastVerifiedAt,
    ...(plain ? { maskedKey: maskKey(plain) } : {}),
  };
}

function maskKey(k: string): string {
  if (k.length <= 10) return k;
  return `${k.slice(0, 5)}${"·".repeat(Math.min(20, k.length - 10))}${k.slice(-5)}`;
}
