import type { DictKey } from "./use-t";
import type { TParams } from "./types";

/**
 * Builtin providers whose display name is locale-dependent and therefore lives
 * in the i18n dictionary instead of the static registry `name`. The registry
 * `name` stays as the locale-neutral default (used as fallback, nickname seed,
 * and in non-React contexts like error labels).
 */
const LOCALIZED_PROVIDER_NAME_KEYS: Record<string, DictKey> = {
  zhipu: "providers.zhipu",
  mimo: "providers.mimo",
  // Only the China entry is locale-dependent ("China" / "中国区"); the
  // international `moonshot` entry's registry name ("Moonshot(Kimi)") is
  // identical across locales, so it falls back to the registry name.
  "moonshot-cn": "providers.moonshotCn",
};

/**
 * Localized display name for a provider. Providers listed in
 * LOCALIZED_PROVIDER_NAME_KEYS resolve via the dictionary (e.g. Zhipu shows
 * "GLM(Zhipu)" in English, "GLM(智谱)" in Chinese); every other builtin and all
 * custom providers fall back to the registry/stored `name`.
 */
export function providerDisplayName(
  provider: { id: string; name: string },
  t: (key: DictKey, params?: TParams) => string,
): string {
  const key = LOCALIZED_PROVIDER_NAME_KEYS[provider.id];
  return key ? t(key) : provider.name;
}
