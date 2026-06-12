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
import { onStoreChange } from "@/lib/store-bus";
import { enDict, type EnDict } from "./dictionaries/en";
import { resolveLocale, normalizeBrowserLocale } from "./locale-resolver";
import { LOCALE_REGISTRY } from "./locales";

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
    const dict = LOCALE_REGISTRY[locale].dictionary;
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
    // ui_locale now lives in the IDB `config` store; cross-context locale
    // sync rides the store-bus instead of the (now-dead) chrome.storage
    // onChanged signal. Re-resolve only when the locale key actually changed.
    return onStoreChange("config", (c) => {
      if (c.id !== STORAGE_KEY_UI_LOCALE) return;
      resolveLocale().then((l) => {
        _currentLocale = l;
        setLocaleState(l);
      });
    });
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
  // Always write the setting (including 'auto') so the store-bus "config"
  // event fires and other sidepanel windows update too. setConfig publishes
  // the change with id === STORAGE_KEY_UI_LOCALE.
  await setConfig(STORAGE_KEY_UI_LOCALE, next);
  // We don't directly setState here — the store-bus subscription in
  // I18nProvider picks up the change.
}

// Re-exports for callers that want resolver utilities without poking the
// resolver module directly.
export { normalizeBrowserLocale, resolveLocale };
