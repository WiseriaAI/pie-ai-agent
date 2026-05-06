const STORAGE_KEY = "skip_permissions_enabled";

export async function isSkipPermissionsEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return !!result[STORAGE_KEY];
}

export async function setSkipPermissionsEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: !!value });
}

export const SKIP_PERMISSIONS_STORAGE_KEY = STORAGE_KEY;
