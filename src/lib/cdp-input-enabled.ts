export const CDP_INPUT_ENABLED_STORAGE_KEY = "cdp_input_enabled";
export const LEGACY_KEYBOARD_FLAG_KEY = "keyboard_simulation_enabled";

export type CdpInputState = true | false | undefined;

export async function isCdpInputEnabled(): Promise<CdpInputState> {
  const result = await chrome.storage.local.get(CDP_INPUT_ENABLED_STORAGE_KEY);
  const v = result[CDP_INPUT_ENABLED_STORAGE_KEY];
  if (v === true) return true;
  if (v === false) return false;
  return undefined;
}

export async function setCdpInputEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({
    [CDP_INPUT_ENABLED_STORAGE_KEY]: !!value,
  });
}

/**
 * One-shot migration from the legacy keyboard_simulation_enabled flag.
 * Idempotent: if new key already set, leaves it alone. Always removes
 * the legacy key after copying (or when present and new key was set).
 */
export async function migrateLegacyKeyboardFlag(): Promise<void> {
  const current = await chrome.storage.local.get([
    CDP_INPUT_ENABLED_STORAGE_KEY,
    LEGACY_KEYBOARD_FLAG_KEY,
  ]);
  const newKeyAlreadySet =
    current[CDP_INPUT_ENABLED_STORAGE_KEY] === true ||
    current[CDP_INPUT_ENABLED_STORAGE_KEY] === false;
  const legacyExists = LEGACY_KEYBOARD_FLAG_KEY in current;

  if (legacyExists && !newKeyAlreadySet) {
    await chrome.storage.local.set({
      [CDP_INPUT_ENABLED_STORAGE_KEY]: !!current[LEGACY_KEYBOARD_FLAG_KEY],
    });
  }
  if (legacyExists) {
    await chrome.storage.local.remove(LEGACY_KEYBOARD_FLAG_KEY);
  }
}
