import { getConfig, setConfig } from "@/lib/idb/config-store";
import { SUPPORTED_LOCALES } from "./locales";
import {
  STORAGE_KEY_ASSISTANT_LANGUAGE,
  type AssistantLanguageSetting,
  type Locale,
} from "./types";

export const DEFAULT_ASSISTANT_LANGUAGE: AssistantLanguageSetting = "auto-follow-ui";

export function isAssistantLanguageSetting(v: unknown): v is AssistantLanguageSetting {
  return (
    v === "auto-follow-ui" ||
    v === "auto-detect-user-message" ||
    (typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v))
  );
}

export async function getAssistantLanguageSetting(): Promise<AssistantLanguageSetting> {
  const raw = await getConfig<string>(STORAGE_KEY_ASSISTANT_LANGUAGE);
  return isAssistantLanguageSetting(raw) ? raw : DEFAULT_ASSISTANT_LANGUAGE;
}

export async function setAssistantLanguageSetting(next: AssistantLanguageSetting): Promise<void> {
  await setConfig(STORAGE_KEY_ASSISTANT_LANGUAGE, next);
}

export function resolveAssistantLanguage(
  setting: AssistantLanguageSetting,
  effectiveUiLocale: Locale,
): Locale | "auto-detect-user-message" {
  if (setting === "auto-follow-ui") return effectiveUiLocale;
  if (setting === "auto-detect-user-message") return "auto-detect-user-message";
  return setting;
}
