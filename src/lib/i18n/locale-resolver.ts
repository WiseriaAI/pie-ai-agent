import {
  SUPPORTED_LOCALES,
  STORAGE_KEY_UI_LOCALE,
  type Locale,
  type LocaleSetting,
} from "./types";
import { getConfig } from "@/lib/idb/config-store";

export function normalizeBrowserLocale(raw: string): Locale {
  if (!raw) return "en";
  if (raw.toLowerCase().startsWith("zh")) return "zh-CN";
  if (raw.toLowerCase().startsWith("en")) return "en";
  return "en";
}

function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

function isLocaleSetting(v: unknown): v is LocaleSetting {
  return v === "auto" || isLocale(v);
}

export async function readLocaleSetting(): Promise<LocaleSetting> {
  const raw = await getConfig<string>(STORAGE_KEY_UI_LOCALE);
  return isLocaleSetting(raw) ? raw : "auto";
}

export async function resolveLocale(): Promise<Locale> {
  const setting = await readLocaleSetting();
  if (setting !== "auto") return setting;
  const browser = chrome.i18n.getUILanguage();
  return normalizeBrowserLocale(browser);
}
