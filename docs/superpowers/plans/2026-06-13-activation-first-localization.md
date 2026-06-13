# Activation-First Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add market-ready localization for Latin American Spanish, Japanese, and Brazilian Portuguese across Pie's activation path, assistant response language preference, store/landing assets, and setup docs.

**Architecture:** Introduce a locale registry as the single source of truth for UI locales, Chrome locale ids, dictionaries, formatting, and assistant-language availability. Keep LLM-visible tool/system prompt body in English, and inject only a small trusted response-language preference block. Treat market copy and screenshots as launch packs with explicit QA gates rather than hidden code comments.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Chrome MV3 `_locales`, Vitest + Testing Library, plain landing page JavaScript, Markdown launch docs.

---

## Scope Check

The approved design spans code, UI copy, Chrome Web Store copy, landing page copy, README docs, and QA. This plan keeps those as separate milestones so each can be reviewed and committed independently:

1. Code capability and tests.
2. Activation path dictionaries and visible UI.
3. Assistant response language.
4. Market assets and docs.
5. QA checklists and launch handoff.

Do not add telemetry. Do not translate tool names, tool schemas, built-in skill instructions, or the main agent system prompt body.

## File Structure

### i18n Core

- Create `src/lib/i18n/locales.ts`
  - Registry for locale metadata, dictionary loading, Chrome locale ids, native labels, direction, and assistant-language availability.
- Modify `src/lib/i18n/types.ts`
  - Move hard-coded locale unions to types derived from the registry where possible.
  - Add `AssistantLanguageSetting` and `STORAGE_KEY_ASSISTANT_LANGUAGE`.
- Modify `src/lib/i18n/locale-resolver.ts`
  - Resolve browser locales through the registry.
- Modify `src/lib/i18n/use-t.tsx`
  - Derive dictionaries from the registry.
  - Export `useI18n()` with `{ locale, t }`.
- Create dictionary files:
  - `src/lib/i18n/dictionaries/es-419.ts`
  - `src/lib/i18n/dictionaries/ja.ts`
  - `src/lib/i18n/dictionaries/pt-BR.ts`
- Modify tests:
  - `src/lib/i18n/__tests__/locale-resolver.test.ts`
  - `src/lib/i18n/__tests__/dictionary-parity.test.ts`
  - `src/lib/i18n/__tests__/use-t.test.tsx`

### Settings UI

- Modify `src/sidepanel/components/LanguageSelect.tsx`
  - Read UI language options from the registry.
- Create `src/sidepanel/components/AssistantLanguageSelect.tsx`
  - Separate selector for assistant response language.
- Modify `src/sidepanel/components/Settings.tsx`
  - Render Assistant language near UI language in General settings.
- Add tests:
  - `src/sidepanel/components/__tests__/LanguageSelect.test.tsx`
  - `src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx`

### Agent Prompt

- Modify `src/lib/agent/prompt.ts`
  - Add response-language block builder.
  - Extend `buildAgentSystemPrompt` with an optional response-language parameter.
- Modify prompt call sites:
  - `src/lib/agent/loop.ts`
  - Any test mocks that call `buildAgentSystemPrompt`.
- Modify `src/lib/agent/prompt.test.ts`
  - Verify block position, override wording, and no tool/schema translation.

### Formatting

- Modify activation-path formatting:
  - `src/sidepanel/components/ContextRing.tsx`
  - `src/sidepanel/components/Schedules/SchedulesPanel.tsx`
  - `src/sidepanel/components/Schedules/ScheduleRunHistory.tsx`
  - `src/sidepanel/components/ProviderModelList.tsx`
  - `src/sidepanel/components/SessionRow.tsx`
  - `src/sidepanel/components/SessionDrawer.tsx`
- Add focused tests where existing tests cover rendered text.

### Chrome MV3 Locale Assets

- Create:
  - `_locales/es_419/messages.json`
  - `_locales/ja/messages.json`
  - `_locales/pt_BR/messages.json`
- Keep manifest keys unchanged:
  - `extension_name`
  - `extension_description`

### Landing Page

- Modify `landing/main.js`
  - Convert current `en`/`zh` lookup to route-aware locale ids.
  - Add `es-419`, `ja`, and `pt-BR` bundles.
- Modify `landing/index.html`
  - Add visible language links.
  - Ensure meta tags can be set per locale by JavaScript or static route copies.
- Modify `landing/README.md`
  - Document localized routes and local preview.

### Launch Docs

- Create:
  - `docs/localization/glossary.md`
  - `docs/localization/launch-pack-es-419.md`
  - `docs/localization/launch-pack-ja.md`
  - `docs/localization/launch-pack-pt-BR.md`
  - `docs/localization/qa-checklist.md`
  - `README.es-419.md`
  - `README.ja.md`
  - `README.pt-BR.md`

### Scripts

- Create `scripts/check-i18n-hardcoded.mjs`
  - Scan changed sidepanel files for visible string literals that should use `t()`.
- Modify `package.json`
  - Add `check:i18n`.

---

## Task 1: Locale Registry Skeleton

**Files:**
- Create: `src/lib/i18n/locales.ts`
- Modify: `src/lib/i18n/types.ts`
- Test: `src/lib/i18n/__tests__/locale-resolver.test.ts`

- [ ] **Step 1: Write failing registry tests**

Add these tests to `src/lib/i18n/__tests__/locale-resolver.test.ts`:

```ts
import { SUPPORTED_LOCALES, LOCALE_REGISTRY } from "../locales";

describe("locale registry", () => {
  it("registers all launch locales in stable order", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh-CN", "es-419", "ja", "pt-BR"]);
  });

  it("maps app locales to Chrome locale folder ids", () => {
    expect(LOCALE_REGISTRY["es-419"].chromeLocale).toBe("es_419");
    expect(LOCALE_REGISTRY.ja.chromeLocale).toBe("ja");
    expect(LOCALE_REGISTRY["pt-BR"].chromeLocale).toBe("pt_BR");
  });

  it("marks every launch locale as ltr in this release", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_REGISTRY[locale].dir).toBe("ltr");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/i18n/__tests__/locale-resolver.test.ts`

Expected: FAIL because `../locales` does not exist.

- [ ] **Step 3: Add registry implementation**

Create `src/lib/i18n/locales.ts`:

```ts
import { enDict } from "./dictionaries/en";
import { zhCNDict } from "./dictionaries/zh-CN";

export const SUPPORTED_LOCALES = ["en", "zh-CN", "es-419", "ja", "pt-BR"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export interface LocaleMeta {
  locale: Locale;
  chromeLocale: string;
  nativeLabel: string;
  englishLabel: string;
  dir: "ltr" | "rtl";
  assistantLanguage: boolean;
  dictionary: unknown;
}

export const LOCALE_REGISTRY: Record<Locale, LocaleMeta> = {
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
};
```

Update `src/lib/i18n/types.ts`:

```ts
import type { Locale } from "./locales";
export type { Locale } from "./locales";

export { SUPPORTED_LOCALES } from "./locales";

export type LocaleSetting = "auto" | Locale;

export type AssistantLanguageSetting =
  | "auto-follow-ui"
  | "auto-detect-user-message"
  | Locale;

export const STORAGE_KEY_UI_LOCALE = "ui_locale";
export const STORAGE_KEY_ASSISTANT_LANGUAGE = "assistant_language";
```

Keep the existing `DictNode`, `Translations`, `DotPathKey`, and `TParams` definitions below those exports.

- [ ] **Step 4: Run registry tests**

Run: `pnpm test src/lib/i18n/__tests__/locale-resolver.test.ts`

Expected: PASS for registry tests; resolver tests may still fail until Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/locales.ts src/lib/i18n/types.ts src/lib/i18n/__tests__/locale-resolver.test.ts
git commit -m "feat(i18n): add locale registry"
```

---

## Task 2: Browser Locale Resolution From Registry

**Files:**
- Modify: `src/lib/i18n/locale-resolver.ts`
- Test: `src/lib/i18n/__tests__/locale-resolver.test.ts`

- [ ] **Step 1: Replace resolver tests with launch-locale cases**

Update the `normalizeBrowserLocale` tests in `src/lib/i18n/__tests__/locale-resolver.test.ts`:

```ts
describe("normalizeBrowserLocale", () => {
  it.each([
    ["zh-CN", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["en-US", "en"],
    ["es-MX", "es-419"],
    ["es-AR", "es-419"],
    ["ja-JP", "ja"],
    ["pt-BR", "pt-BR"],
    ["pt-PT", "en"],
    ["fr-FR", "en"],
    ["", "en"],
  ] as const)("%s → %s", (raw, expected) => {
    expect(normalizeBrowserLocale(raw)).toBe(expected);
  });
});
```

Add resolver override tests:

```ts
it("returns 'es-419' when storage override is 'es-419'", async () => {
  await setConfig(STORAGE_KEY_UI_LOCALE, "es-419");
  expect(await resolveLocale()).toBe("es-419");
});

it("returns 'ja' when storage override is 'ja'", async () => {
  await setConfig(STORAGE_KEY_UI_LOCALE, "ja");
  expect(await resolveLocale()).toBe("ja");
});

it("returns 'pt-BR' when storage override is 'pt-BR'", async () => {
  await setConfig(STORAGE_KEY_UI_LOCALE, "pt-BR");
  expect(await resolveLocale()).toBe("pt-BR");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test src/lib/i18n/__tests__/locale-resolver.test.ts`

Expected: FAIL because Spanish, Japanese, and Portuguese are still falling back to English.

- [ ] **Step 3: Implement normalization**

Update `src/lib/i18n/locale-resolver.ts`:

```ts
import {
  SUPPORTED_LOCALES,
  STORAGE_KEY_UI_LOCALE,
  type Locale,
  type LocaleSetting,
} from "./types";
import { getConfig } from "@/lib/idb/config-store";

export function normalizeBrowserLocale(raw: string): Locale {
  const v = raw.toLowerCase();
  if (!v) return "en";
  if (v.startsWith("zh")) return "zh-CN";
  if (v.startsWith("es")) return "es-419";
  if (v === "ja" || v.startsWith("ja-")) return "ja";
  if (v === "pt-br") return "pt-BR";
  if (v.startsWith("en")) return "en";
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
```

- [ ] **Step 4: Run resolver tests**

Run: `pnpm test src/lib/i18n/__tests__/locale-resolver.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/locale-resolver.ts src/lib/i18n/__tests__/locale-resolver.test.ts
git commit -m "feat(i18n): resolve launch browser locales"
```

---

## Task 3: Complete Dictionary Files And Registry-Derived Parity

**Files:**
- Create: `src/lib/i18n/dictionaries/es-419.ts`
- Create: `src/lib/i18n/dictionaries/ja.ts`
- Create: `src/lib/i18n/dictionaries/pt-BR.ts`
- Modify: `src/lib/i18n/locales.ts`
- Modify: `src/lib/i18n/__tests__/dictionary-parity.test.ts`

- [ ] **Step 1: Write failing all-locale parity tests**

Replace the dictionary parity comparison in `src/lib/i18n/__tests__/dictionary-parity.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { enDict } from "../dictionaries/en";
import { LOCALE_REGISTRY, SUPPORTED_LOCALES } from "../locales";

function collectKeys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(path);
    else out.push(...collectKeys(v, path));
  }
  return out.sort();
}

function valueAt(dict: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], dict);
}

describe("dictionary parity", () => {
  it("every registered locale has the same key set as English", () => {
    const enKeys = collectKeys(enDict);
    for (const locale of SUPPORTED_LOCALES) {
      expect(collectKeys(LOCALE_REGISTRY[locale].dictionary), locale).toEqual(enKeys);
    }
  });

  it("every registered dictionary value is a non-empty string", () => {
    const keys = collectKeys(enDict);
    for (const locale of SUPPORTED_LOCALES) {
      for (const path of keys) {
        const v = valueAt(LOCALE_REGISTRY[locale].dictionary, path);
        expect(typeof v, `${locale}: ${path}`).toBe("string");
        expect((v as string).length, `${locale}: ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it("launch locales translate critical activation labels", () => {
    expect(LOCALE_REGISTRY["es-419"].dictionary.common.cancel).toBe("Cancelar");
    expect(LOCALE_REGISTRY.ja.dictionary.common.cancel).toBe("キャンセル");
    expect(LOCALE_REGISTRY["pt-BR"].dictionary.common.cancel).toBe("Cancelar");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`

Expected: FAIL because the new dictionaries do not exist and registry entries still point at `enDict`.

- [ ] **Step 3: Create complete translated dictionaries**

For each new dictionary file, copy the full object shape from `src/lib/i18n/dictionaries/en.ts`, replace every string leaf with market-reviewed translated copy, and keep the export names below. These files are content artifacts: the implementation commit must contain the full object tree in each file, not aliases, spreads from `enDict`, or runtime fallback strings.

Create `src/lib/i18n/dictionaries/es-419.ts`:

```ts
import type { EnDict } from "./en";
import type { Translations } from "../types";

export const es419Dict = {
  /* Full translated EnDict object tree. */
} satisfies Translations<EnDict>;
```

Create `src/lib/i18n/dictionaries/ja.ts`:

```ts
import type { EnDict } from "./en";
import type { Translations } from "../types";

export const jaDict = {
  /* Full translated EnDict object tree. */
} satisfies Translations<EnDict>;
```

Create `src/lib/i18n/dictionaries/pt-BR.ts`:

```ts
import type { EnDict } from "./en";
import type { Translations } from "../types";

export const ptBRDict = {
  /* Full translated EnDict object tree. */
} satisfies Translations<EnDict>;
```

Before this task is complete, delete the `/* Full translated EnDict object tree. */` marker from each file and replace it with the complete translated tree. The commit is blocked unless all of these checks pass:

```bash
pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts
pnpm typecheck
rg -n "Full translated EnDict object tree|enDict|TODO|TBD|FIXME|Continue with" src/lib/i18n/dictionaries/es-419.ts src/lib/i18n/dictionaries/ja.ts src/lib/i18n/dictionaries/pt-BR.ts
```

Expected for the `rg` command: no matches and exit code 1.

Minimum critical translation checks that must stay true in the parity test:

```ts
expect(LOCALE_REGISTRY["es-419"].dictionary.common.cancel).toBe("Cancelar");
expect(LOCALE_REGISTRY["es-419"].dictionary.common.save).toBe("Guardar");
expect(LOCALE_REGISTRY.ja.dictionary.common.cancel).toBe("キャンセル");
expect(LOCALE_REGISTRY.ja.dictionary.common.save).toBe("保存");
expect(LOCALE_REGISTRY["pt-BR"].dictionary.common.cancel).toBe("Cancelar");
expect(LOCALE_REGISTRY["pt-BR"].dictionary.common.save).toBe("Salvar");
```

- [ ] **Step 4: Wire dictionaries into registry**

Update `src/lib/i18n/locales.ts` imports:

```ts
import { es419Dict } from "./dictionaries/es-419";
import { jaDict } from "./dictionaries/ja";
import { ptBRDict } from "./dictionaries/pt-BR";
```

Change the registry dictionary references:

```ts
"es-419": { /* same metadata */, dictionary: es419Dict },
ja: { /* same metadata */, dictionary: jaDict },
"pt-BR": { /* same metadata */, dictionary: ptBRDict },
```

- [ ] **Step 5: Run dictionary tests and typecheck**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/dictionaries/es-419.ts src/lib/i18n/dictionaries/ja.ts src/lib/i18n/dictionaries/pt-BR.ts src/lib/i18n/locales.ts src/lib/i18n/__tests__/dictionary-parity.test.ts
git commit -m "feat(i18n): add launch locale dictionaries"
```

---

## Task 4: Registry-Derived Runtime Translation

**Files:**
- Modify: `src/lib/i18n/use-t.tsx`
- Modify: `src/lib/i18n/index.ts`
- Test: `src/lib/i18n/__tests__/use-t.test.tsx`

- [ ] **Step 1: Add failing runtime tests for new locales and useI18n**

Add to `src/lib/i18n/__tests__/use-t.test.tsx`:

```tsx
function LocaleProbe() {
  const { locale, t } = useI18n();
  return (
    <span data-testid="locale-probe">
      {locale}:{t("common.cancel")}
    </span>
  );
}

it("renders Spanish from the registry dictionary", async () => {
  await setConfig(STORAGE_KEY_UI_LOCALE, "es-419");
  render(<I18nProvider><Probe k="common.cancel" /></I18nProvider>);
  await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Cancelar"));
});

it("renders Japanese from the registry dictionary", async () => {
  await setConfig(STORAGE_KEY_UI_LOCALE, "ja");
  render(<I18nProvider><Probe k="common.cancel" /></I18nProvider>);
  await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("キャンセル"));
});

it("useI18n exposes the effective locale and translator", async () => {
  await setConfig(STORAGE_KEY_UI_LOCALE, "pt-BR");
  render(<I18nProvider><LocaleProbe /></I18nProvider>);
  await waitFor(() => expect(screen.getByTestId("locale-probe").textContent).toBe("pt-BR:Cancelar"));
});
```

Update imports:

```ts
import { I18nProvider, useT, useI18n, setLocale, getLocale } from "../use-t";
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/lib/i18n/__tests__/use-t.test.tsx`

Expected: FAIL because `useI18n` is not exported and runtime dictionaries are still hard-coded.

- [ ] **Step 3: Derive runtime dictionaries from registry**

Update `src/lib/i18n/use-t.tsx`:

```ts
import { LOCALE_REGISTRY } from "./locales";
```

Replace the hard-coded dictionaries object:

```ts
const dictionaries: Record<Locale, DictNode> = Object.fromEntries(
  Object.entries(LOCALE_REGISTRY).map(([locale, meta]) => [locale, meta.dictionary]),
) as Record<Locale, DictNode>;
```

Add `useI18n()`:

```ts
export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    return { locale: "en" as Locale, t: makeT("en") };
  }
  return ctx;
}
```

Keep `useT()` as:

```ts
export function useT() {
  return useI18n().t;
}
```

- [ ] **Step 4: Export useI18n**

Update `src/lib/i18n/index.ts`:

```ts
export {
  I18nProvider,
  useI18n,
  useT,
  setLocale,
  getLocale,
  resolveLocale,
  normalizeBrowserLocale,
  type DictKey,
} from "./use-t";
```

- [ ] **Step 5: Run runtime tests**

Run: `pnpm test src/lib/i18n/__tests__/use-t.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/use-t.tsx src/lib/i18n/index.ts src/lib/i18n/__tests__/use-t.test.tsx
git commit -m "feat(i18n): derive runtime translations from locale registry"
```

---

## Task 5: UI Language Selector From Registry

**Files:**
- Modify: `src/sidepanel/components/LanguageSelect.tsx`
- Test: `src/sidepanel/components/__tests__/LanguageSelect.test.tsx`

- [ ] **Step 1: Create failing LanguageSelect test**

Create `src/sidepanel/components/__tests__/LanguageSelect.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import LanguageSelect from "../LanguageSelect";

afterEach(cleanup);

describe("LanguageSelect", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("renders every registered launch locale", async () => {
    render(<I18nProvider><LanguageSelect /></I18nProvider>);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("English")).toBeTruthy();
    expect(screen.getByText("中文（简体）")).toBeTruthy();
    expect(screen.getByText("Español (Latinoamérica)")).toBeTruthy();
    expect(screen.getByText("日本語")).toBeTruthy();
    expect(screen.getByText("Português (Brasil)")).toBeTruthy();
  });

  it("writes a selected locale to config", async () => {
    render(<I18nProvider><LanguageSelect /></I18nProvider>);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("日本語"));
    await waitFor(async () => {
      expect(await getConfig<string>(STORAGE_KEY_UI_LOCALE)).toBe("ja");
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/sidepanel/components/__tests__/LanguageSelect.test.tsx`

Expected: FAIL because only `auto`, `en`, and `zh-CN` render.

- [ ] **Step 3: Refactor LanguageSelect**

Update `src/sidepanel/components/LanguageSelect.tsx`:

```tsx
import { useState, useEffect, useRef } from "react";
import { useT, setLocale, type LocaleSetting } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { LOCALE_REGISTRY, SUPPORTED_LOCALES } from "@/lib/i18n/locales";
import { STORAGE_KEY_UI_LOCALE } from "@/lib/i18n";

const OPTIONS: { value: LocaleSetting; label: string; labelKey?: Parameters<ReturnType<typeof useT>>[0] }[] = [
  { value: "auto", label: "", labelKey: "settings.language.optionAuto" },
  ...SUPPORTED_LOCALES.map((locale) => ({
    value: locale,
    label: LOCALE_REGISTRY[locale].nativeLabel,
  })),
];
```

In the effect, validate against the derived options:

```ts
useEffect(() => {
  getConfig<string>(STORAGE_KEY_UI_LOCALE).then((v) => {
    if (OPTIONS.some((o) => o.value === v)) setValue(v as LocaleSetting);
  });
}, []);
```

For labels:

```ts
const labelFor = (o: (typeof OPTIONS)[number]) => o.labelKey ? t(o.labelKey) : o.label;
const currentLabel = labelFor(OPTIONS.find((o) => o.value === value)!);
```

Render `{labelFor(o)}` inside option buttons.

- [ ] **Step 4: Run LanguageSelect test**

Run: `pnpm test src/sidepanel/components/__tests__/LanguageSelect.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/LanguageSelect.tsx src/sidepanel/components/__tests__/LanguageSelect.test.tsx
git commit -m "feat(i18n): derive language selector options"
```

---

## Task 6: Assistant Language Setting

**Files:**
- Create: `src/lib/i18n/assistant-language.ts`
- Create: `src/sidepanel/components/AssistantLanguageSelect.tsx`
- Modify: `src/sidepanel/components/Settings.tsx`
- Modify: `src/lib/i18n/index.ts`
- Test: `src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx`

- [ ] **Step 1: Write failing AssistantLanguageSelect tests**

Create `src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, STORAGE_KEY_ASSISTANT_LANGUAGE } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { _resetForTests } from "@/lib/idb/db";
import AssistantLanguageSelect from "../AssistantLanguageSelect";

afterEach(cleanup);

describe("AssistantLanguageSelect", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("renders assistant language modes and explicit launch locales", async () => {
    render(<I18nProvider><AssistantLanguageSelect /></I18nProvider>);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Follow UI language")).toBeTruthy();
    expect(screen.getByText("Detect from user message")).toBeTruthy();
    expect(screen.getByText("Español (Latinoamérica)")).toBeTruthy();
    expect(screen.getByText("日本語")).toBeTruthy();
    expect(screen.getByText("Português (Brasil)")).toBeTruthy();
  });

  it("stores explicit assistant language selection", async () => {
    render(<I18nProvider><AssistantLanguageSelect /></I18nProvider>);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByText("Português (Brasil)"));
    await waitFor(async () => {
      expect(await getConfig<string>(STORAGE_KEY_ASSISTANT_LANGUAGE)).toBe("pt-BR");
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Add assistant language storage helpers**

Create `src/lib/i18n/assistant-language.ts`:

```ts
import { getConfig, setConfig } from "@/lib/idb/config-store";
import {
  STORAGE_KEY_ASSISTANT_LANGUAGE,
  type AssistantLanguageSetting,
  type Locale,
} from "./types";
import { SUPPORTED_LOCALES } from "./locales";

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
```

- [ ] **Step 4: Add AssistantLanguageSelect**

Create `src/sidepanel/components/AssistantLanguageSelect.tsx` with the same dropdown structure as `LanguageSelect.tsx`, but using:

```ts
const OPTIONS = [
  { value: "auto-follow-ui", label: "Follow UI language" },
  { value: "auto-detect-user-message", label: "Detect from user message" },
  ...SUPPORTED_LOCALES.map((locale) => ({
    value: locale,
    label: LOCALE_REGISTRY[locale].nativeLabel,
  })),
] as const;
```

Use `getAssistantLanguageSetting()` to initialize and `setAssistantLanguageSetting()` on selection.

- [ ] **Step 5: Render it in Settings**

Update imports in `src/sidepanel/components/Settings.tsx`:

```ts
import AssistantLanguageSelect from "./AssistantLanguageSelect";
```

Render it directly below the existing `LanguageSelect` in the General tab:

```tsx
<div className="flex flex-col gap-1.5">
  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">
    Assistant language
  </div>
  <AssistantLanguageSelect />
</div>
```

Add dictionary keys for `settings.language.assistantLabel`, `settings.language.assistantFollowUi`, and `settings.language.assistantDetectMessage` in Task 3 dictionaries if you choose to translate this label instead of the literal English shown above.

- [ ] **Step 6: Export helpers**

Update `src/lib/i18n/index.ts`:

```ts
export {
  DEFAULT_ASSISTANT_LANGUAGE,
  getAssistantLanguageSetting,
  setAssistantLanguageSetting,
  resolveAssistantLanguage,
} from "./assistant-language";
```

- [ ] **Step 7: Run tests**

Run: `pnpm test src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/i18n/assistant-language.ts src/lib/i18n/index.ts src/sidepanel/components/AssistantLanguageSelect.tsx src/sidepanel/components/Settings.tsx src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx
git commit -m "feat(i18n): add assistant language setting"
```

---

## Task 7: Response Language Prompt Block

**Files:**
- Modify: `src/lib/agent/prompt.ts`
- Modify: `src/lib/agent/loop.ts`
- Modify: `src/lib/agent/prompt.test.ts`
- Test: `src/lib/agent/prompt.test.ts`

- [ ] **Step 1: Add failing prompt block tests**

Add to `src/lib/agent/prompt.test.ts`:

```ts
describe("buildResponseLanguageBlock", () => {
  it("returns empty string for auto-detect-user-message", () => {
    expect(buildResponseLanguageBlock("auto-detect-user-message")).toBe("");
  });

  it("renders explicit Japanese response guidance", () => {
    const block = buildResponseLanguageBlock("ja");
    expect(block).toContain("<response_language>");
    expect(block).toContain("Japanese (ja)");
    expect(block).toContain("If the user's latest message explicitly asks for another language");
    expect(block).toContain("Do not translate tool names");
  });

  it("places response_language before user_task and after pinned context", () => {
    const prompt = buildAgentSystemPrompt(
      "my task",
      false,
      true,
      [{ tabId: 5, origin: "https://example.com" }],
      undefined,
      [],
      "pt-BR",
    );
    expect(prompt.indexOf("<response_language>")).toBeGreaterThan(0);
    expect(prompt.indexOf("<user_task>my task</user_task>")).toBeGreaterThan(
      prompt.indexOf("<response_language>"),
    );
  });
});
```

Update prompt test imports:

```ts
import {
  buildAgentSystemPrompt,
  buildCurrentTimeBlock,
  buildObservationMessage,
  buildResponseLanguageBlock,
  buildSkillCatalogBlock,
} from "./prompt";
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test src/lib/agent/prompt.test.ts`

Expected: FAIL because `buildResponseLanguageBlock` does not exist and `buildAgentSystemPrompt` has no response language parameter.

- [ ] **Step 3: Implement block builder**

Add to `src/lib/agent/prompt.ts`:

```ts
import type { Locale } from "@/lib/i18n";

const RESPONSE_LANGUAGE_LABELS: Record<Locale, string> = {
  en: "English (en)",
  "zh-CN": "Simplified Chinese (zh-CN)",
  "es-419": "Latin American Spanish (es-419)",
  ja: "Japanese (ja)",
  "pt-BR": "Brazilian Portuguese (pt-BR)",
};

export function buildResponseLanguageBlock(
  responseLanguage: Locale | "auto-detect-user-message" | undefined,
): string {
  if (!responseLanguage || responseLanguage === "auto-detect-user-message") return "";
  return `\n\n<response_language>
Default assistant response language: ${RESPONSE_LANGUAGE_LABELS[responseLanguage]}.
If the user's latest message explicitly asks for another language, follow the user's request.
Do not translate tool names, tool arguments, URLs, code, selectors, or quoted page content unless asked.
</response_language>`;
}
```

Extend `buildAgentSystemPrompt` signature:

```ts
export function buildAgentSystemPrompt(
  task: string,
  hasKeyboardTools = false,
  hasMetaTools = false,
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> = [],
  currentFocusTabId?: number,
  skillCatalog: SkillCatalogEntry[] = [],
  responseLanguage?: Locale | "auto-detect-user-message",
): string {
```

Add:

```ts
const responseLanguageBlock = buildResponseLanguageBlock(responseLanguage);
```

Insert `${responseLanguageBlock}` before `<user_task>`:

```ts
`${...}${pinnedContext}${responseLanguageBlock}\n\n<user_task>${task}</user_task>\n\n${R15_IMAGE_UNTRUSTED}`
```

- [ ] **Step 4: Wire loop call site**

In `src/lib/agent/loop.ts`, read assistant language before building the system prompt:

```ts
import {
  getAssistantLanguageSetting,
  resolveAssistantLanguage,
  resolveLocale,
} from "@/lib/i18n";
```

Near the existing `buildAgentSystemPrompt` call, compute:

```ts
const uiLocale = await resolveLocale();
const assistantLanguageSetting = await getAssistantLanguageSetting();
const responseLanguage = resolveAssistantLanguage(assistantLanguageSetting, uiLocale);
```

Pass `responseLanguage` as the final argument to `buildAgentSystemPrompt`.

- [ ] **Step 5: Run prompt tests**

Run: `pnpm test src/lib/agent/prompt.test.ts`

Expected: PASS.

Run: `pnpm test src/lib/agent/loop.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/prompt.ts src/lib/agent/loop.ts src/lib/agent/prompt.test.ts
git commit -m "feat(agent): inject assistant response language preference"
```

---

## Task 8: Locale-Aware Formatting On Activation Path

**Files:**
- Modify: `src/sidepanel/components/ContextRing.tsx`
- Modify: `src/sidepanel/components/Schedules/SchedulesPanel.tsx`
- Modify: `src/sidepanel/components/Schedules/ScheduleRunHistory.tsx`
- Modify: `src/sidepanel/components/ProviderModelList.tsx`
- Test existing component tests where present.

- [ ] **Step 1: Update ContextRing to use `useI18n()`**

Replace:

```ts
import { useT } from "@/lib/i18n";
const numberFormat = new Intl.NumberFormat("en");
```

With:

```ts
import { useI18n } from "@/lib/i18n";
```

Inside the component:

```ts
const { locale, t } = useI18n();
const numberFormat = new Intl.NumberFormat(locale);
```

- [ ] **Step 2: Update schedule time formatting**

In `SchedulesPanel.tsx`, change:

```ts
function fmtNextRun(ms: number | undefined, enabled: boolean, status: ScheduleRecord["status"]): string {
```

To:

```ts
function fmtNextRun(
  ms: number | undefined,
  enabled: boolean,
  status: ScheduleRecord["status"],
  locale: string,
): string {
```

Use:

```ts
return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
```

In the component, use:

```ts
const { locale, t } = useI18n();
```

And call:

```tsx
{t("schedules.nextPrefix")} {fmtNextRun(rec.nextRunAt, rec.enabled, rec.status, locale)}
```

- [ ] **Step 3: Update run history formatting**

In `ScheduleRunHistory.tsx`, change `fmtTime(ms: number)` to `fmtTime(ms: number, locale: string)` and use `toLocaleString(locale, ...)`.

Inside the component, use:

```ts
const { locale, t } = useI18n();
```

Render:

```tsx
{fmtTime(run.startedAt, locale)}
```

- [ ] **Step 4: Update provider model fetched time**

In `ProviderModelList.tsx`, replace `useT()` with `useI18n()` and format fetched times with:

```ts
new Date(props.fetchedAt).toLocaleString(locale)
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test src/sidepanel/components/__tests__/ContextRing.test.tsx src/sidepanel/components/Schedules/SchedulesPanel.test.tsx src/sidepanel/components/Schedules/ScheduleRunHistory.test.tsx src/sidepanel/components/ProviderModelList.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/ContextRing.tsx src/sidepanel/components/Schedules/SchedulesPanel.tsx src/sidepanel/components/Schedules/ScheduleRunHistory.tsx src/sidepanel/components/ProviderModelList.tsx
git commit -m "feat(i18n): format activation path values by locale"
```

---

## Task 9: Chrome Extension Locale Message Files

**Files:**
- Create: `_locales/es_419/messages.json`
- Create: `_locales/ja/messages.json`
- Create: `_locales/pt_BR/messages.json`
- Test: `pnpm build`

- [ ] **Step 1: Create Spanish Chrome locale messages**

Create `_locales/es_419/messages.json`:

```json
{
  "extension_name": {
    "message": "Pie · Agente de IA abierto para tu navegador",
    "description": "Extension name shown in Chrome and the Web Store."
  },
  "extension_description": {
    "message": "Agente de IA abierto para navegar, leer páginas y automatizar tareas con tu propia clave. Sin backend, telemetría ni proxy.",
    "description": "Short description shown in the Web Store and chrome://extensions."
  }
}
```

- [ ] **Step 2: Create Japanese Chrome locale messages**

Create `_locales/ja/messages.json`:

```json
{
  "extension_name": {
    "message": "Pie · ブラウザで動くオープンなAIエージェント",
    "description": "Extension name shown in Chrome and the Web Store."
  },
  "extension_description": {
    "message": "自分のAPIキーでページ理解とブラウザ操作を行うオープンなAIエージェント。バックエンド、テレメトリ、プロキシなし。",
    "description": "Short description shown in the Web Store and chrome://extensions."
  }
}
```

- [ ] **Step 3: Create Brazilian Portuguese Chrome locale messages**

Create `_locales/pt_BR/messages.json`:

```json
{
  "extension_name": {
    "message": "Pie · Agente de IA aberto para o navegador",
    "description": "Extension name shown in Chrome and the Web Store."
  },
  "extension_description": {
    "message": "Agente de IA aberto para ler páginas e automatizar tarefas com sua própria chave. Sem backend, telemetria ou proxy.",
    "description": "Short description shown in the Web Store and chrome://extensions."
  }
}
```

- [ ] **Step 4: Build**

Run: `pnpm build`

Expected: PASS and no manifest localization error.

- [ ] **Step 5: Commit**

```bash
git add _locales/es_419/messages.json _locales/ja/messages.json _locales/pt_BR/messages.json
git commit -m "feat(i18n): add Chrome locale metadata"
```

---

## Task 10: Landing Page Locale Bundles And Routes

**Files:**
- Modify: `landing/main.js`
- Modify: `landing/index.html`
- Modify: `landing/README.md`

- [ ] **Step 1: Refactor landing language ids**

In `landing/main.js`, change `normalizedLang` to support launch route ids:

```js
function normalizedLang(lang) {
  if (lang === "zh" || lang === "zh-CN") return "zh";
  if (lang === "es-419") return "es-419";
  if (lang === "ja") return "ja";
  if (lang === "pt-BR") return "pt-BR";
  return "en";
}
```

Update `currentLang()`:

```js
function currentLang() {
  const lang = document.documentElement.lang;
  if (lang === "zh-CN") return "zh";
  if (lang === "es-419" || lang === "ja" || lang === "pt-BR") return lang;
  return "en";
}
```

Set document language:

```js
document.documentElement.lang =
  lang === "zh" ? "zh-CN" :
  lang === "es-419" ? "es-419" :
  lang === "ja" ? "ja" :
  lang === "pt-BR" ? "pt-BR" :
  "en";
```

- [ ] **Step 2: Detect locale from path**

In `initLang()`, before localStorage fallback:

```js
const firstPath = location.pathname.split("/").filter(Boolean)[0];
if (["es-419", "ja", "pt-BR"].includes(firstPath)) {
  applyLang(firstPath);
  return;
}
```

- [ ] **Step 3: Add visible language links**

In `landing/index.html`, add language links in the nav area:

```html
<nav class="lang-links" aria-label="Language">
  <a href="/">English</a>
  <a href="/es-419/">Español</a>
  <a href="/ja/">日本語</a>
  <a href="/pt-BR/">Português</a>
  <button type="button" data-lang-btn="zh">中文</button>
</nav>
```

Use existing CSS classes where possible so the links do not introduce a new visual style.

- [ ] **Step 4: Add locale bundles**

Add `I18N["es-419"]`, `I18N.ja`, and `I18N["pt-BR"]` to `landing/main.js` with every key from `I18N.en`.

Use launch-pack copy from:

- `docs/localization/launch-pack-es-419.md`
- `docs/localization/launch-pack-ja.md`
- `docs/localization/launch-pack-pt-BR.md`

- [ ] **Step 5: Document local preview**

Add to `landing/README.md`:

```md
## Localized Routes

Preview localized pages with the same static server:

- `/` English
- `/es-419/` Latin American Spanish
- `/ja/` Japanese
- `/pt-BR/` Brazilian Portuguese

The root path stays English and does not auto-redirect.
```

- [ ] **Step 6: Verify with static server**

Run: `pnpm build`

Expected: PASS.

Run: `pnpm dev`

Expected: Vite starts. Open `/es-419/`, `/ja/`, and `/pt-BR/` manually and verify page text changes.

- [ ] **Step 7: Commit**

```bash
git add landing/main.js landing/index.html landing/README.md
git commit -m "feat(landing): add localized launch routes"
```

---

## Task 11: Launch Packs, Glossary, And Setup READMEs

**Files:**
- Create: `docs/localization/glossary.md`
- Create: `docs/localization/launch-pack-es-419.md`
- Create: `docs/localization/launch-pack-ja.md`
- Create: `docs/localization/launch-pack-pt-BR.md`
- Create: `docs/localization/qa-checklist.md`
- Create: `README.es-419.md`
- Create: `README.ja.md`
- Create: `README.pt-BR.md`

- [ ] **Step 1: Create glossary**

Create `docs/localization/glossary.md`:

```md
# Localization Glossary

Use this glossary for UI, Chrome Web Store, landing page, screenshots, and setup READMEs.

| Concept | English source | Meaning | Translation rule |
|---|---|---|---|
| Pie | Pie | Product name | Do not translate. |
| Agent | browser agent / AI agent | The assistant that reads and operates pages | Keep "agent" where natural; explain once in local language. |
| BYOK | Bring your own key | User provides their own LLM API key | Keep "BYOK" and explain in plain local language on first use. |
| API key | API key | Provider credential | Do not call it a password. |
| Provider | model provider | Anthropic, OpenAI, Gemini, etc. | Use provider name where local product users understand it. |
| Local-first | local-first | Secrets and app data stay on the user's device by default | Translate as a privacy property, not as offline-only. |
| No telemetry | no telemetry | Pie does not collect product analytics | Keep consistent; do not imply providers collect nothing. |
| No backend | no backend | Pie does not proxy requests through Pie-operated servers | Do not imply the selected model provider is absent. |
| Local encryption | encrypted locally | API key is encrypted before storage on the device | Pair with BYOK and no backend. |
```

- [ ] **Step 2: Create launch pack template for Spanish**

Create `docs/localization/launch-pack-es-419.md` with these sections:

```md
# Launch Pack: es-419

## Positioning

Pie is an open-source browser agent for users who want AI automation without sending prompts through a Pie-operated backend. The copy should be approachable Latin American Spanish and focus on setup clarity.

## Chrome Web Store

### Name

Pie · Agente de IA abierto para tu navegador

### Short Description

Agente de IA abierto para leer páginas y automatizar tareas con tu propia clave. Sin backend, telemetría ni proxy.

### Long Description

Pie vive en el panel lateral de Chrome. Puede leer la página actual, operar sitios web, organizar pestañas y convertir contenido desordenado en datos útiles.

Usas tu propia clave de modelo. Pie no opera un backend, no hace proxy de tus solicitudes y no recopila telemetría del producto. Tu API key se cifra localmente y solo se envía al proveedor que elegiste.

Primeros pasos:
1. Instala Pie.
2. Abre el panel lateral.
3. Configura un proveedor o inicia sesión en una cuenta administrada.
4. Escribe una tarea y deja que Pie trabaje con la página actual.

## Screenshot Captions

1. Pregunta sobre la página actual sin copiar y pegar.
2. Configura tu proveedor o cuenta administrada.
3. Pie ejecuta tareas en varios pasos con herramientas del navegador.
4. BYOK, sin telemetría y sin backend operado por Pie.

## README Source

Use the same privacy wording as the long description.
```

- [ ] **Step 3: Create Japanese and Portuguese launch packs**

Create `docs/localization/launch-pack-ja.md`:

```md
# Launch Pack: ja

## Positioning

Pie is an open-source browser agent for Japanese users who want Chrome-based AI assistance, clear setup, and a privacy model that avoids a Pie-operated backend. The copy should be direct, product-focused Japanese and avoid overly casual assistant language.

## Chrome Web Store

### Name

Pie · ブラウザ用のオープンAIエージェント

### Short Description

自分のAPIキーでページを読み取り、タスクを自動化できるオープンなAIエージェント。バックエンド、テレメトリー、プロキシはありません。

### Long Description

Pie は Chrome のサイドパネルで動作します。現在開いているページを読み取り、Web サイトを操作し、タブを整理し、散らばった情報を使いやすいデータに変換できます。

モデルプロバイダーのAPIキーはユーザー自身が設定します。Pie はバックエンドを運用せず、リクエストをプロキシせず、プロダクト分析用のテレメトリーを収集しません。APIキーはローカルで暗号化され、選択したプロバイダーにのみ送信されます。

はじめ方:
1. Pie をインストールします。
2. サイドパネルを開きます。
3. プロバイダーを設定するか、管理アカウントでサインインします。
4. タスクを入力し、Pie に現在のページで作業させます。

## Screenshot Captions

1. コピー＆ペーストせずに現在のページについて質問できます。
2. プロバイダーまたは管理アカウントを設定できます。
3. Pie はブラウザツールを使って複数ステップのタスクを実行します。
4. BYOK、テレメトリーなし、Pie が運用するバックエンドなし。

## README Source

Use the privacy wording from the long description.
```

Create `docs/localization/launch-pack-pt-BR.md`:

```md
# Launch Pack: pt-BR

## Positioning

Pie is an open-source browser agent for Brazilian users who want AI automation in Chrome with a clear BYOK setup and no Pie-operated backend. The copy should use Brazilian Portuguese, keep the setup path simple, and explain privacy claims without legal-heavy phrasing.

## Chrome Web Store

### Name

Pie · Agente de IA aberto para seu navegador

### Short Description

Agente de IA aberto para ler páginas e automatizar tarefas com sua própria chave. Sem backend, telemetria ou proxy.

### Long Description

Pie funciona no painel lateral do Chrome. Ele pode ler a página atual, operar sites, organizar abas e transformar conteúdo desorganizado em dados úteis.

Você usa sua própria chave de modelo. Pie não opera um backend, não faz proxy das suas solicitações e não coleta telemetria do produto. Sua API key é criptografada localmente e enviada apenas ao provedor escolhido.

Primeiros passos:
1. Instale o Pie.
2. Abra o painel lateral.
3. Configure um provedor ou entre com uma conta gerenciada.
4. Escreva uma tarefa e deixe o Pie trabalhar com a página atual.

## Screenshot Captions

1. Pergunte sobre a página atual sem copiar e colar.
2. Configure seu provedor ou conta gerenciada.
3. Pie executa tarefas em várias etapas com ferramentas do navegador.
4. BYOK, sem telemetria e sem backend operado pelo Pie.

## README Source

Use the privacy wording from the long description.
```

- [ ] **Step 4: Create QA checklist**

Create `docs/localization/qa-checklist.md`:

```md
# Localization QA Checklist

Run this checklist for each locale before launch.

## Locale

- Locale id:
- Reviewer:
- Review date:

## Activation Path

- The user understands how to open Settings.
- The user understands provider/API key setup.
- The user understands managed account setup where shown.
- The user understands how to send the first task.
- Error/CTA copy explains the next action.

## Privacy Claims

- BYOK explanation matches the glossary.
- No telemetry claim matches the glossary.
- No backend/no proxy claim matches the glossary.
- API key local encryption claim matches the glossary.
- Copy does not imply the selected model provider receives no data.

## Visual Review

- Buttons do not overflow.
- Dropdowns do not clip.
- Screenshot captions fit.
- Japanese line breaks look natural.
- Spanish and Portuguese long strings wrap cleanly.

## Store Review

- Name fits Chrome Web Store limits.
- Short description fits Chrome Web Store limits.
- Long description has setup steps.
- Provider list is current.
- Support/feedback link is present.

## Decision

- Launch approved:
- Required changes:
```

- [ ] **Step 5: Create setup READMEs**

Create each README with these exact sections:

```md
# Pie

## What Pie Is

## Install

## First Configuration

## Run Your First Task

## Privacy Model

## Feedback
```

For `README.es-419.md`, write the body in Latin American Spanish and include these exact local-language lines:

```md
Pie es un agente de IA abierto para Chrome. Vive en el panel lateral, puede leer la página actual y ayuda a automatizar tareas del navegador.

Usas tu propia clave de modelo. Pie no opera un backend, no hace proxy de tus solicitudes y no recopila telemetría del producto.
```

For `README.ja.md`, write the body in Japanese and include these exact local-language lines:

```md
Pie は Chrome 用のオープンな AI エージェントです。サイドパネルで動作し、現在のページを読み取ってブラウザ上のタスクを自動化できます。

モデルプロバイダーのAPIキーはユーザー自身が設定します。Pie はバックエンドを運用せず、リクエストをプロキシせず、プロダクト分析用のテレメトリーを収集しません。
```

For `README.pt-BR.md`, write the body in Brazilian Portuguese and include these exact local-language lines:

```md
Pie é um agente de IA aberto para Chrome. Ele funciona no painel lateral, lê a página atual e ajuda a automatizar tarefas do navegador.

Você usa sua própria chave de modelo. Pie não opera um backend, não faz proxy das suas solicitações e não coleta telemetria do produto.
```

For all three README files, preserve the install, Chrome Web Store, privacy, GitHub, and feedback URLs from `README.md` exactly. The localized README commit is blocked if any of these files contain the literal English headings `What Pie Is`, `First Configuration`, `Run Your First Task`, or `Privacy Model`.

- [ ] **Step 6: Commit**

```bash
git add docs/localization README.es-419.md README.ja.md README.pt-BR.md
git commit -m "docs(localization): add launch packs and setup guides"
```

---

## Task 12: Hardcoded Visible Text Scan

**Files:**
- Create: `scripts/check-i18n-hardcoded.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create script**

Create `scripts/check-i18n-hardcoded.mjs`:

```js
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["diff", "--name-only", "--cached"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.startsWith("src/sidepanel/"))
  .filter((f) => /\.(tsx|ts)$/.test(f))
  .filter((f) => !f.endsWith(".test.tsx"))
  .filter((f) => !f.includes("/__tests__/"));

const allow = [
  "className",
  "data-testid",
  "data-",
  "aria-",
  "role",
  "type",
  "viewBox",
  "fill",
  "stroke",
  "M",
  "http",
  "https",
];

let failed = false;

for (const file of files) {
  const content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8" });
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    const hasString = /["'`][A-Za-z][^"'`]{2,}["'`]/.test(line);
    const usesT = line.includes("t(");
    const allowed = allow.some((token) => line.includes(token));
    if (hasString && !usesT && !allowed) {
      failed = true;
      console.error(`${file}:${index + 1}: possible visible hardcoded string`);
      console.error(line);
    }
  });
}

if (failed) {
  process.exit(1);
}
```

- [ ] **Step 2: Add package script**

In `package.json` scripts:

```json
"check:i18n": "node scripts/check-i18n-hardcoded.mjs"
```

- [ ] **Step 3: Run script**

Run: `pnpm check:i18n`

Expected: PASS when no sidepanel files are staged, and PASS after staging this script/package change.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-i18n-hardcoded.mjs package.json
git commit -m "test(i18n): add hardcoded sidepanel text scan"
```

---

## Task 13: Final Verification And Launch Checklist

**Files:**
- Modify: `docs/localization/qa-checklist.md`

- [ ] **Step 1: Run full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected: all PASS.

- [ ] **Step 2: Run localization-specific checks**

Run:

```bash
pnpm test src/lib/i18n src/sidepanel/components/__tests__/LanguageSelect.test.tsx src/sidepanel/components/__tests__/AssistantLanguageSelect.test.tsx src/lib/agent/prompt.test.ts
pnpm check:i18n
```

Expected: all PASS.

- [ ] **Step 3: Record launch QA status**

Append this section to `docs/localization/qa-checklist.md`:

```md
## Verification Commands

- `pnpm typecheck`:
- `pnpm test`:
- `pnpm build`:
- `pnpm check:i18n`:

## Launch Gate

Launch is blocked until each locale has reviewer approval for:

- Extension UI activation path.
- Chrome Web Store copy.
- Landing page route.
- README setup guide.
- Screenshot captions.
```

Replace each blank command result with an observed result line in this exact format:

```md
- `pnpm typecheck`: 2026-06-13 <short-commit-hash> PASS
- `pnpm test`: 2026-06-13 <short-commit-hash> PASS
- `pnpm build`: 2026-06-13 <short-commit-hash> PASS
- `pnpm check:i18n`: 2026-06-13 <short-commit-hash> PASS
```

If a command fails, record `FAIL`, paste the first actionable error line after the result, fix the issue, rerun all four commands, and update the checklist only after the full set passes.

- [ ] **Step 4: Commit verification notes**

```bash
git add docs/localization/qa-checklist.md
git commit -m "docs(localization): record launch verification gates"
```
