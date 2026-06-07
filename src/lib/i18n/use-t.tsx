import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  STORAGE_KEY_UI_LOCALE,
  type DictNode,
  type Locale,
  type LocaleSetting,
  type TParams,
  type DotPathKey,
} from "./types";
import { setConfig } from "@/lib/idb/config-store";
import { enDict, type EnDict } from "./dictionaries/en";
import { zhCNDict } from "./dictionaries/zh-CN";
import { resolveLocale, normalizeBrowserLocale } from "./locale-resolver";

const dictionaries: Record<Locale, DictNode> = {
  en: enDict,
  "zh-CN": zhCNDict,
};

export type DictKey = DotPathKey<EnDict>;

// Module-level effective locale, kept in sync with the Provider state.
// Allows non-React code (rare) to read the current locale without context.
let _currentLocale: Locale = "en";

export function getLocale(): Locale {
  return _currentLocale;
}

function lookup(dict: DictNode, path: string): string | undefined {
  let node: DictNode | string | undefined = dict;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as DictNode)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

function substitute(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

function makeT(locale: Locale) {
  return function t<K extends DictKey>(key: K, params?: TParams): string {
    const dict = dictionaries[locale];
    const hit = lookup(dict, key);
    if (hit !== undefined) return substitute(hit, params);
    const enHit = lookup(enDict, key);
    if (enHit !== undefined) return substitute(enHit, params);
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key: ${key}`);
    } else {
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  };
}

interface I18nContextValue {
  locale: Locale;
  t: ReturnType<typeof makeT>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    let cancelled = false;
    resolveLocale().then((l) => {
      if (cancelled) return;
      _currentLocale = l;
      setLocaleState(l);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handler(
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) {
      if (areaName !== "local") return;
      if (!(STORAGE_KEY_UI_LOCALE in changes)) return;
      resolveLocale().then((l) => {
        _currentLocale = l;
        setLocaleState(l);
      });
    }
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: makeT(locale) }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Outside Provider (e.g. early SSR-style render) — fall back to English.
    return makeT("en");
  }
  return ctx.t;
}

export async function setLocale(next: LocaleSetting): Promise<void> {
  // Always write the setting (including 'auto') so storage.onChanged fires
  // and other sidepanel windows update too.
  await setConfig(STORAGE_KEY_UI_LOCALE, next);
  // We don't directly setState here — the storage.onChanged subscription in
  // I18nProvider picks up the change. In tests that mutate __store directly
  // they call __emitChange manually.
}

// Re-exports for callers that want resolver utilities without poking the
// resolver module directly.
export { normalizeBrowserLocale, resolveLocale };
