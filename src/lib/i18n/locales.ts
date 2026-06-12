import { enDict } from "./dictionaries/en";
import { zhCNDict } from "./dictionaries/zh-CN";
import type { DictNode } from "./types";

export const SUPPORTED_LOCALES = ["en", "zh-CN", "es-419", "ja", "pt-BR"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export interface LocaleMeta<L extends Locale = Locale> {
  locale: L;
  chromeLocale: string;
  nativeLabel: string;
  englishLabel: string;
  dir: "ltr" | "rtl";
  assistantLanguage: boolean;
  dictionary: DictNode;
}

export type LocaleRegistry = {
  [L in Locale]: LocaleMeta<L>;
};

export const LOCALE_REGISTRY = {
  en: {
    locale: "en",
    chromeLocale: "en",
    nativeLabel: "English",
    englishLabel: "English",
    dir: "ltr",
    assistantLanguage: true,
    dictionary: enDict,
  },
  "zh-CN": {
    locale: "zh-CN",
    chromeLocale: "zh_CN",
    nativeLabel: "中文（简体）",
    englishLabel: "Chinese (Simplified)",
    dir: "ltr",
    assistantLanguage: true,
    dictionary: zhCNDict,
  },
  "es-419": {
    locale: "es-419",
    chromeLocale: "es_419",
    nativeLabel: "Español (Latinoamérica)",
    englishLabel: "Spanish (Latin America)",
    dir: "ltr",
    assistantLanguage: true,
    dictionary: enDict,
  },
  ja: {
    locale: "ja",
    chromeLocale: "ja",
    nativeLabel: "日本語",
    englishLabel: "Japanese",
    dir: "ltr",
    assistantLanguage: true,
    dictionary: enDict,
  },
  "pt-BR": {
    locale: "pt-BR",
    chromeLocale: "pt_BR",
    nativeLabel: "Português (Brasil)",
    englishLabel: "Portuguese (Brazil)",
    dir: "ltr",
    assistantLanguage: true,
    dictionary: enDict,
  },
} satisfies LocaleRegistry;
