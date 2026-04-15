import type { Provider, ModelConfig } from "@/lib/model-router";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";

interface StoredProviderConfig {
  encryptedKey: string;
  model: string;
  baseUrl?: string;
}

function storageKey(provider: Provider): string {
  return `provider_${provider}`;
}

export async function saveProviderConfig(
  provider: Provider,
  apiKey: string,
  model: string,
  baseUrl?: string,
): Promise<void> {
  if (!apiKey.trim()) {
    throw new Error("API key cannot be empty");
  }

  const key = await getOrCreateEncryptionKey();
  const encryptedKey = await encrypt(apiKey, key);

  const config: StoredProviderConfig = { encryptedKey, model };
  if (baseUrl?.trim()) {
    config.baseUrl = baseUrl.trim();
  }

  await chrome.storage.local.set({ [storageKey(provider)]: config });
}

export async function getProviderConfig(
  provider: Provider,
): Promise<ModelConfig | null> {
  const result = await chrome.storage.local.get(storageKey(provider));
  const stored: StoredProviderConfig | undefined = result[storageKey(provider)];
  if (!stored) return null;

  const key = await getOrCreateEncryptionKey();
  const apiKey = await decrypt(stored.encryptedKey, key);

  return {
    provider,
    model: stored.model,
    apiKey,
    baseUrl: stored.baseUrl,
  };
}

export async function deleteProviderConfig(
  provider: Provider,
): Promise<void> {
  await chrome.storage.local.remove(storageKey(provider));
}

export async function getActiveProvider(): Promise<Provider | null> {
  const result = await chrome.storage.local.get("active_provider");
  return (result.active_provider as Provider) ?? null;
}

export async function setActiveProvider(provider: Provider): Promise<void> {
  await chrome.storage.local.set({ active_provider: provider });
}
