import { getConfig, setConfig, removeConfig } from "@/lib/idb/config-store";

export const CDP_INPUT_ENABLED_STORAGE_KEY = "cdp_input_enabled";
export const LEGACY_KEYBOARD_FLAG_KEY = "keyboard_simulation_enabled";

export type CdpInputState = true | false | undefined;

export async function isCdpInputEnabled(): Promise<CdpInputState> {
  const v = await getConfig<boolean>(CDP_INPUT_ENABLED_STORAGE_KEY);
  if (v === true) return true;
  if (v === false) return false;
  return undefined;
}

export async function setCdpInputEnabled(value: boolean): Promise<void> {
  await setConfig(CDP_INPUT_ENABLED_STORAGE_KEY, !!value);
}

/**
 * One-shot migration from the legacy keyboard_simulation_enabled flag.
 * Idempotent: if new key already set, leaves it alone. Always removes
 * the legacy key after copying (or when present and new key was set).
 */
export async function migrateLegacyKeyboardFlag(): Promise<void> {
  const newVal = await getConfig<boolean>(CDP_INPUT_ENABLED_STORAGE_KEY);
  const newKeyAlreadySet = newVal === true || newVal === false;

  const legacyVal = await getConfig<boolean>(LEGACY_KEYBOARD_FLAG_KEY);
  const legacyExists = legacyVal !== undefined;

  if (legacyExists && !newKeyAlreadySet) {
    await setConfig(CDP_INPUT_ENABLED_STORAGE_KEY, !!legacyVal);
  }
  if (legacyExists) {
    await removeConfig(LEGACY_KEYBOARD_FLAG_KEY);
  }
}
