// src/lib/custom-rules.ts
//
// User custom rules (#344) — a single free-text block the user configures in
// Settings and that is spliced into the agent's STATIC system prompt as trusted
// user preferences (see buildCustomRulesBlock in src/lib/agent/prompt.ts).
//
// Stored unencrypted (non-sensitive preference) in the `config` store under
// `custom_rules`, mirroring the getConfig/setConfig read/write pattern used by
// src/lib/i18n/assistant-language.ts. Empty / unset ⇒ feature off ⇒ the whole
// prompt block is omitted.

import { getConfig, setConfig } from "@/lib/idb/config-store";

export const STORAGE_KEY_CUSTOM_RULES = "custom_rules";

/**
 * Hard length cap for the custom-rules text (≈1–2k tokens). Enforced in three
 * places — Settings textarea maxLength, save-time validation, and a defensive
 * slice in buildCustomRulesBlock — so a system prompt can never be bloated by
 * an oversized rules blob regardless of how the value got into storage.
 */
export const CUSTOM_RULES_MAX_LENGTH = 4000;

export async function getCustomRules(): Promise<string> {
  const raw = await getConfig<string>(STORAGE_KEY_CUSTOM_RULES);
  return typeof raw === "string" ? raw : "";
}

/**
 * Persist the custom-rules text. Clamped to CUSTOM_RULES_MAX_LENGTH so storage
 * can never hold more than the prompt block will ever render.
 */
export async function setCustomRules(next: string): Promise<void> {
  await setConfig(STORAGE_KEY_CUSTOM_RULES, next.slice(0, CUSTOM_RULES_MAX_LENGTH));
}
