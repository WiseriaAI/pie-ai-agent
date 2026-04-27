// Phase 2.5 — keyboard simulation toggle (binary on/off).
// When ON, the Agent's tool registry exposes `dispatch_keyboard_input` and
// `press_key`, which use chrome.debugger + CDP to send isTrusted keyboard
// events. Default is OFF — users opt in explicitly via Settings.
//
// See docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md

const STORAGE_KEY = "keyboard_simulation_enabled";

export async function isKeyboardSimulationEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return !!result[STORAGE_KEY];
}

export async function setKeyboardSimulationEnabled(
  value: boolean,
): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: !!value });
}

export const KEYBOARD_SIMULATION_STORAGE_KEY = STORAGE_KEY;
