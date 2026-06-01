export type Locale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh-CN"] as const;

export type LocaleSetting = "auto" | Locale;

export const STORAGE_KEY_UI_LOCALE = "ui_locale";

// Dictionary tree is plain nested objects of strings. We don't allow arrays or
// other shapes — keeps the parity test and type derivation simple.
export interface DictNode {
  [key: string]: string | DictNode;
}

// Same key structure as the canonical (English) dictionary, but every leaf is a
// plain `string` instead of the English string literal. A translation dictionary
// is typed `satisfies Translations<EnDict>` so it must cover exactly the same keys
// (parity enforced) while being free to carry any translated string value.
export type Translations<T> = {
  [K in keyof T]: T[K] extends string ? string : Translations<T[K]>;
};

// Derive the dot-path key union from the English dictionary at the call site
// using `DotPathKey<typeof enDict>`. We export the helper here.
export type DotPathKey<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends DictNode
      ? DotPathKey<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

// Params object is loosely typed. Stronger typing (parsing `{name}` placeholders
// out of dict values into a Required keys map) is out of scope for v1.
export type TParams = Record<string, string | number>;
