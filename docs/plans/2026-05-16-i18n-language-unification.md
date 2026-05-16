# Language Unification & UI i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a type-safe in-repo i18n module (en / zh-CN), hide built-in skills from the UI (default all enabled), and translate every Chinese hardcoded UI string in `src/sidepanel/` to go through `t(key)`.

**Architecture:** New `src/lib/i18n/` leaf module exporting `<I18nProvider>` / `useT()` / `t()` / `setLocale()` / `getLocale()`. Locale resolution order: storage override (`ui_locale: 'auto'|'en'|'zh-CN'`) → `chrome.i18n.getUILanguage()` normalized (`zh*` → `'zh-CN'`, else → `'en'`). Manifest `name` / `description` separately go through `chrome.i18n`'s `__MSG__` + `_locales/{en,zh_CN}/messages.json` (single-purpose, unrelated to runtime dict). Built-in skills are forced `enabled: true` in `builtin.ts`; a one-shot migration (`enabled_skills_migrated_v1`) cleans `'!<id>'` entries from `enabled_skills` storage.

**Tech Stack:** React 19 + TypeScript 6 / Vite 8 / TailwindCSS v4 / vitest + happy-dom + @testing-library/react / chrome.i18n + chrome.storage.local.

**Source spec:** `docs/specs/2026-05-16-i18n-language-unification.md` (commit `71fa2a1`).

---

## Reference: Dictionary key inventory (used by tasks below)

The keys below are the complete dot-path set the dictionaries must contain. Tasks introduce keys incrementally — Task 2 seeds `common.*`, then each component-tasking task adds the keys it needs. By the end of Task 17 the union below must be fully present.

```
common.cancel
common.save
common.confirm
common.delete
common.refresh
common.back
common.copy
common.copyFailed
errors.modelLoadFailed
errors.connectBackgroundFailedRetry
settings.language.sectionTitle
settings.language.label
settings.language.optionAuto
settings.language.optionEn
settings.language.optionZhCN
settings.myConfigs.title
settings.myConfigs.countSuffix
settings.myConfigs.newConfigButton
chat.elementPicker.idle
chat.elementPicker.active
chat.elementPicker.activeAriaLabel
chat.recording.createSkillFromRecording
chat.recording.createSkillFromRecordingWithStep
chat.recording.sendHint
chat.recording.composeHint
chat.attachment.imagePlaceholderTitle
chat.attachment.imageReleasedBadge
modelDropdown.selectModelPlaceholder
modelDropdown.notFetched
modelDropdown.fetching
modelDropdown.refresh
modelDropdown.searchPlaceholder
modelDropdown.noMatch
modelDropdown.emptyUseAdd
modelDropdown.addCustomModel
newConfigWizard.step1Title
newConfigWizard.changeProvider
agentStep.callingTool
agentStep.collapse
agentStep.expand
quoteChip.removeQuote
quoteChip.screenshotUnavailable
instanceSelector.newConfigOrManage
skills.empty.cta
skills.section.yours.title
skills.section.yours.subtitleEditable
```

`en.ts` is the source of truth (values in English). `zh-CN.ts` is a 1:1 mirror with Chinese values. `dictionary-parity.test.ts` enforces the keysets stay identical.

---

## Task 1: Extend chrome.i18n + storage.onChanged test mocks

**Why:** The i18n module reads `chrome.i18n.getUILanguage()` and subscribes to `chrome.storage.local.onChanged` (multi-window sync). Current `src/test/setup.ts` mock lacks `chrome.i18n` entirely and `onChanged.addListener` is a bare `vi.fn()` with no emit helper.

**Files:**
- Modify: `src/test/setup.ts`

### Steps

- [ ] **Step 1: Read current setup.ts to confirm insertion points**

Run: `wc -l src/test/setup.ts`
Expected: ~280 lines.

- [ ] **Step 2: Add `chrome.i18n` mock and upgrade `storage.local.onChanged` to support emit**

Edit `src/test/setup.ts`:

Find the `onChanged` stub inside `local`:

```typescript
  // Minimal onChanged stub. Tests that need real storage-change
  // notifications can override; useSession's M1-U5 listener only
  // needs the .addListener / .removeListener API to exist so it
  // doesn't throw on mount.
  onChanged: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
```

Replace with:

```typescript
  // onChanged with real emit support so i18n cross-window sync tests can
  // drive change events. Tests that don't subscribe see no behavior change
  // because previous fake never fired anything.
  __changedListeners: [] as Array<(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void>,
  onChanged: {
    addListener(
      l: (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string,
      ) => void,
    ) {
      local.__changedListeners.push(l);
    },
    removeListener(
      l: (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string,
      ) => void,
    ) {
      local.__changedListeners = local.__changedListeners.filter((x) => x !== l);
    },
  },
  __emitChange(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName = "local",
  ) {
    for (const l of local.__changedListeners) l(changes, areaName);
  },
```

Find the `chromeMock` object near line 208:

```typescript
const chromeMock = {
  storage: { local },
  runtime,
  tabs,
  webNavigation,
};
```

Replace with:

```typescript
const i18n = {
  __uiLanguage: "en" as string,
  getUILanguage: vi.fn(() => i18n.__uiLanguage),
  getMessage: vi.fn((key: string) => key),
};

const chromeMock = {
  storage: { local },
  runtime,
  tabs,
  webNavigation,
  i18n,
};
```

Find the `beforeEach` block near line 233 and add a reset line for `i18n.__uiLanguage`:

```typescript
beforeEach(() => {
  local.__store = {};
  local.__changedListeners = [];
  runtime.__ports = [];
  runtime.connect.mockClear();
  tabs.__activeTab = null;
  tabs.__tabsById.clear();
  tabs.query.mockClear();
  tabs.get.mockClear();
  webNavigation.__committedListeners = [];
  webNavigation.__historyListeners = [];
  i18n.__uiLanguage = "en";
  i18n.getUILanguage.mockClear();
  i18n.getMessage.mockClear();
});
```

- [ ] **Step 3: Run full test suite to verify nothing breaks**

Run: `pnpm test`
Expected: All existing tests pass (the new mocks are additive; existing onChanged tests do not call `__emitChange`).

- [ ] **Step 4: Commit**

```bash
git add src/test/setup.ts
git commit -m "$(cat <<'EOF'
test(setup): add chrome.i18n mock + onChanged emit helper

为 i18n 模块测试预留 chrome.i18n.getUILanguage / storage.local.onChanged 触发
能力；现有测试不受影响（默认 __uiLanguage='en'，__emitChange 无人订阅）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: i18n types + dictionary skeleton + parity test

**Why:** Get the dictionary scaffolding in place with one seeded namespace (`common.*`) so subsequent tasks can add keys incrementally. The parity test catches missing translations at CI time even if TS type assertions are accidentally bypassed.

**Files:**
- Create: `src/lib/i18n/types.ts`
- Create: `src/lib/i18n/dictionaries/en.ts`
- Create: `src/lib/i18n/dictionaries/zh-CN.ts`
- Create: `src/lib/i18n/__tests__/dictionary-parity.test.ts`

### Steps

- [ ] **Step 1: Create `src/lib/i18n/types.ts`**

```typescript
export type Locale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh-CN"] as const;

export type LocaleSetting = "auto" | Locale;

export const STORAGE_KEY_UI_LOCALE = "ui_locale";

// Dictionary tree is plain nested objects of strings. We don't allow arrays or
// other shapes — keeps the parity test and type derivation simple.
export interface DictNode {
  [key: string]: string | DictNode;
}

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
```

- [ ] **Step 2: Create `src/lib/i18n/dictionaries/en.ts`** (source of truth, seeded with `common.*` only — later tasks expand it)

```typescript
import type { DictNode } from "../types";

export const enDict = {
  common: {
    cancel: "Cancel",
    save: "Save",
    confirm: "Confirm",
    delete: "Delete",
    refresh: "Refresh",
    back: "Back",
    copy: "Copy",
    copyFailed: "Copy failed",
  },
} as const satisfies DictNode;

export type EnDict = typeof enDict;
```

- [ ] **Step 3: Create `src/lib/i18n/dictionaries/zh-CN.ts`**

```typescript
import type { EnDict } from "./en";

// `satisfies EnDict` enforces that the shape matches en exactly: missing keys
// or wrong-typed values = compile error. Cannot use direct `: EnDict` because
// that loses literal types for the resolver.
export const zhCNDict = {
  common: {
    cancel: "取消",
    save: "保存",
    confirm: "确认",
    delete: "删除",
    refresh: "刷新",
    back: "返回",
    copy: "复制",
    copyFailed: "复制失败",
  },
} as const satisfies EnDict;
```

- [ ] **Step 4: Write failing parity test `src/lib/i18n/__tests__/dictionary-parity.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { enDict } from "../dictionaries/en";
import { zhCNDict } from "../dictionaries/zh-CN";

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

describe("dictionary parity", () => {
  it("en and zh-CN have identical key sets", () => {
    const enKeys = collectKeys(enDict);
    const zhKeys = collectKeys(zhCNDict);
    expect(zhKeys).toEqual(enKeys);
  });

  it("every value in both dictionaries is a non-empty string", () => {
    for (const [dictName, dict] of [
      ["en", enDict],
      ["zh-CN", zhCNDict],
    ] as const) {
      const keys = collectKeys(dict);
      for (const path of keys) {
        const v = path
          .split(".")
          .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], dict);
        expect(typeof v, `${dictName}: ${path}`).toBe("string");
        expect((v as string).length, `${dictName}: ${path}`).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Step 5: Run the test — expect PASS (dictionaries are intentionally created in sync)**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/types.ts src/lib/i18n/dictionaries/ src/lib/i18n/__tests__/dictionary-parity.test.ts
git commit -m "$(cat <<'EOF'
feat(i18n): add dictionary skeleton + parity test (common.*)

en.ts 是 source of truth；zh-CN.ts satisfies EnDict 保证 keyset 一致。
parity test 作为 runtime 兜底（防 type assertion 绕过 TS 检查）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: locale-resolver (TDD)

**Why:** Centralizes the "storage override → chrome.i18n → fallback en" resolution. Pure function, easy to test exhaustively without React.

**Files:**
- Test: `src/lib/i18n/__tests__/locale-resolver.test.ts`
- Create: `src/lib/i18n/locale-resolver.ts`

### Steps

- [ ] **Step 1: Write the failing test first**

Create `src/lib/i18n/__tests__/locale-resolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { resolveLocale, normalizeBrowserLocale } from "../locale-resolver";

describe("normalizeBrowserLocale", () => {
  it("zh-CN → zh-CN", () => {
    expect(normalizeBrowserLocale("zh-CN")).toBe("zh-CN");
  });
  it("zh-TW → zh-CN (any zh* maps to zh-CN — v1 only ships Simplified)", () => {
    expect(normalizeBrowserLocale("zh-TW")).toBe("zh-CN");
  });
  it("zh-Hans → zh-CN", () => {
    expect(normalizeBrowserLocale("zh-Hans")).toBe("zh-CN");
  });
  it("en-US → en", () => {
    expect(normalizeBrowserLocale("en-US")).toBe("en");
  });
  it("fr-FR → en (unsupported falls back)", () => {
    expect(normalizeBrowserLocale("fr-FR")).toBe("en");
  });
  it("empty string → en", () => {
    expect(normalizeBrowserLocale("")).toBe("en");
  });
});

describe("resolveLocale", () => {
  beforeEach(() => {
    chromeMock.i18n.__uiLanguage = "en";
  });

  it("returns 'en' when storage override is 'en'", async () => {
    await chromeMock.storage.local.set({ ui_locale: "en" });
    expect(await resolveLocale()).toBe("en");
  });

  it("returns 'zh-CN' when storage override is 'zh-CN'", async () => {
    await chromeMock.storage.local.set({ ui_locale: "zh-CN" });
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to chrome.i18n when override is 'auto'", async () => {
    await chromeMock.storage.local.set({ ui_locale: "auto" });
    chromeMock.i18n.__uiLanguage = "zh-CN";
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to chrome.i18n when storage is empty", async () => {
    chromeMock.i18n.__uiLanguage = "zh-TW";
    expect(await resolveLocale()).toBe("zh-CN");
  });

  it("falls back to 'en' when chrome.i18n returns unsupported locale", async () => {
    chromeMock.i18n.__uiLanguage = "fr-FR";
    expect(await resolveLocale()).toBe("en");
  });

  it("ignores garbage values in storage override and falls through to chrome.i18n", async () => {
    await chromeMock.storage.local.set({ ui_locale: "klingon" });
    chromeMock.i18n.__uiLanguage = "zh-CN";
    expect(await resolveLocale()).toBe("zh-CN");
  });
});
```

- [ ] **Step 2: Run test — verify it FAILS with import error**

Run: `pnpm test src/lib/i18n/__tests__/locale-resolver.test.ts`
Expected: All tests fail with `Cannot find module '../locale-resolver'` or similar.

- [ ] **Step 3: Create `src/lib/i18n/locale-resolver.ts`**

```typescript
import {
  SUPPORTED_LOCALES,
  STORAGE_KEY_UI_LOCALE,
  type Locale,
  type LocaleSetting,
} from "./types";

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
  const got = await chrome.storage.local.get(STORAGE_KEY_UI_LOCALE);
  const raw = got[STORAGE_KEY_UI_LOCALE];
  return isLocaleSetting(raw) ? raw : "auto";
}

export async function resolveLocale(): Promise<Locale> {
  const setting = await readLocaleSetting();
  if (setting !== "auto") return setting;
  const browser = chrome.i18n.getUILanguage();
  return normalizeBrowserLocale(browser);
}
```

- [ ] **Step 4: Run test — verify PASS**

Run: `pnpm test src/lib/i18n/__tests__/locale-resolver.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/locale-resolver.ts src/lib/i18n/__tests__/locale-resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(i18n): add locale-resolver with override → chrome.i18n → 'en' fallback

normalizeBrowserLocale 把 zh* 归一到 zh-CN，其它一律 fallback en（v1 只 ship
英文 + 简中）。storage 中的 garbage 值被忽略，等同 'auto'。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: t function + I18nProvider + useT hook (TDD)

**Why:** The React-side surface that components actually consume. Includes fallback chain (current dict → en dict → key string + warn), `{param}` substitution, and `chrome.storage.onChanged` subscription for cross-window sync.

**Files:**
- Test: `src/lib/i18n/__tests__/use-t.test.tsx`
- Create: `src/lib/i18n/use-t.tsx`

### Steps

- [ ] **Step 1: Write the failing test**

Create `src/lib/i18n/__tests__/use-t.test.tsx`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { chromeMock } from "@/test/setup";
import { I18nProvider, useT, setLocale, getLocale } from "../use-t";

function Probe({ k, params }: { k: Parameters<ReturnType<typeof useT>>[0]; params?: Record<string, string | number> }) {
  const t = useT();
  return <span data-testid="probe">{t(k as never, params)}</span>;
}

describe("t / useT / I18nProvider", () => {
  beforeEach(() => {
    chromeMock.i18n.__uiLanguage = "en";
  });

  it("renders English by default", async () => {
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Cancel"));
  });

  it("renders Chinese when ui_locale=zh-CN in storage", async () => {
    await chromeMock.storage.local.set({ ui_locale: "zh-CN" });
    render(
      <I18nProvider>
        <Probe k="common.cancel" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("取消"));
  });

  it("setLocale writes storage and re-renders the tree", async () => {
    render(
      <I18nProvider>
        <Probe k="common.save" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Save"));

    await act(async () => {
      await setLocale("zh-CN");
    });

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("保存"));
    const stored = await chromeMock.storage.local.get("ui_locale");
    expect(stored.ui_locale).toBe("zh-CN");
  });

  it("cross-window sync: storage.onChanged update flips the tree", async () => {
    render(
      <I18nProvider>
        <Probe k="common.delete" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Delete"));

    await act(async () => {
      chromeMock.storage.local.__store["ui_locale"] = "zh-CN";
      chromeMock.storage.local.__emitChange({
        ui_locale: { oldValue: undefined, newValue: "zh-CN" },
      });
    });

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("删除"));
  });

  it("getLocale exposes the current effective locale", async () => {
    await chromeMock.storage.local.set({ ui_locale: "zh-CN" });
    render(
      <I18nProvider>
        <span />
      </I18nProvider>,
    );
    await waitFor(() => expect(getLocale()).toBe("zh-CN"));
  });
});

describe("t — fallback behavior", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("unknown key returns the key itself and warns", async () => {
    render(
      <I18nProvider>
        <Probe k={"nonexistent.key" as never} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("nonexistent.key"));
    expect(warnSpy).toHaveBeenCalled();
  });

  it("substitutes {name} params", async () => {
    // Seed a temp key by mutating an existing one would be too invasive; reuse
    // common.copyFailed by passing extra params (no placeholder → params silently
    // ignored). For substitution coverage we rely on the params replacement test
    // in component-level tasks (Chat will introduce keys with placeholders).
    render(
      <I18nProvider>
        <Probe k="common.copy" params={{ name: "X" }} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Copy"));
  });
});
```

- [ ] **Step 2: Run test — verify it FAILS with import error**

Run: `pnpm test src/lib/i18n/__tests__/use-t.test.tsx`
Expected: All tests fail (module not found).

- [ ] **Step 3: Create `src/lib/i18n/use-t.tsx`**

```typescript
import {
  createContext,
  useCallback,
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
  await chrome.storage.local.set({ [STORAGE_KEY_UI_LOCALE]: next });
  // We don't directly setState here — the storage.onChanged subscription in
  // I18nProvider picks up the change. In tests that mutate __store directly
  // they call __emitChange manually.
}

// Re-exports for callers that want resolver utilities without poking the
// resolver module directly.
export { normalizeBrowserLocale, resolveLocale };
```

- [ ] **Step 4: Run test — verify PASS**

Run: `pnpm test src/lib/i18n/__tests__/use-t.test.tsx`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/use-t.tsx src/lib/i18n/__tests__/use-t.test.tsx
git commit -m "$(cat <<'EOF'
feat(i18n): add I18nProvider + useT + t with fallback + storage sync

t 失败回退链：current dict → en dict → key string + console.warn。
I18nProvider 订阅 chrome.storage.onChanged，跨窗口切换自动同步。
setLocale 仅写 storage（含 'auto'），让 onChanged 驱动 setState。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: i18n public entry `index.ts`

**Why:** Single import path for consumers (`import { useT, I18nProvider } from "@/lib/i18n"`).

**Files:**
- Create: `src/lib/i18n/index.ts`

### Steps

- [ ] **Step 1: Create `src/lib/i18n/index.ts`**

```typescript
export {
  I18nProvider,
  useT,
  setLocale,
  getLocale,
  resolveLocale,
  normalizeBrowserLocale,
  type DictKey,
} from "./use-t";
export {
  SUPPORTED_LOCALES,
  STORAGE_KEY_UI_LOCALE,
  type Locale,
  type LocaleSetting,
  type TParams,
} from "./types";
```

- [ ] **Step 2: Run typecheck via build**

Run: `pnpm build`
Expected: build completes without TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/i18n/index.ts
git commit -m "$(cat <<'EOF'
feat(i18n): add public entry barrel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: One-shot migration `enabled_skills_migrated_v1` (TDD)

**Why:** Old users' `chrome.storage.local.enabled_skills` may contain `'!close_duplicate_tabs'` / `'!close_inactive_tabs'` entries. After Section 4 change those skills become default-on; we want existing users to also experience the new default, so clean `!`-prefixed entries once.

**Files:**
- Test: `src/lib/skills/__tests__/migration-enabled-v1.test.ts`
- Create: `src/lib/skills/migration-enabled-v1.ts`

### Steps

- [ ] **Step 1: Verify the existing `__tests__` directory layout**

Run: `ls src/lib/skills/`
Expected: at least `builtin.ts`, `storage.ts`, `index.ts`, `types.ts` present. The `__tests__/` directory may or may not exist; create it as needed.

- [ ] **Step 2: Write the failing test**

Create `src/lib/skills/__tests__/migration-enabled-v1.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateSkillsEnabledAllOn } from "../migration-enabled-v1";

describe("migrateSkillsEnabledAllOn", () => {
  it("strips '!<id>' entries from enabled_skills and writes flag", async () => {
    await chromeMock.storage.local.set({
      enabled_skills: [
        "!close_duplicate_tabs",
        "!close_inactive_tabs",
        "skill_user_a",
      ],
    });
    await migrateSkillsEnabledAllOn();
    const got = await chromeMock.storage.local.get([
      "enabled_skills",
      "enabled_skills_migrated_v1",
    ]);
    expect(got.enabled_skills).toEqual(["skill_user_a"]);
    expect(got.enabled_skills_migrated_v1).toBe(true);
  });

  it("is idempotent — second run is a no-op", async () => {
    await chromeMock.storage.local.set({
      enabled_skills: ["!close_duplicate_tabs"],
    });
    await migrateSkillsEnabledAllOn();
    const afterFirst = await chromeMock.storage.local.get("enabled_skills");
    expect(afterFirst.enabled_skills).toEqual([]);

    // Manually re-introduce a '!<id>' entry to prove migration doesn't run again.
    await chromeMock.storage.local.set({
      enabled_skills: ["!close_duplicate_tabs"],
    });
    await migrateSkillsEnabledAllOn();
    const afterSecond = await chromeMock.storage.local.get("enabled_skills");
    expect(afterSecond.enabled_skills).toEqual(["!close_duplicate_tabs"]);
  });

  it("handles missing enabled_skills (fresh install) gracefully", async () => {
    await migrateSkillsEnabledAllOn();
    const got = await chromeMock.storage.local.get([
      "enabled_skills",
      "enabled_skills_migrated_v1",
    ]);
    expect(got.enabled_skills).toEqual([]);
    expect(got.enabled_skills_migrated_v1).toBe(true);
  });

  it("does not throw if storage.get throws (best-effort)", async () => {
    const origGet = chromeMock.storage.local.get;
    chromeMock.storage.local.get = (() =>
      Promise.reject(new Error("storage borked"))) as typeof origGet;
    await expect(migrateSkillsEnabledAllOn()).resolves.toBeUndefined();
    chromeMock.storage.local.get = origGet;
  });
});
```

- [ ] **Step 3: Run test — verify FAIL with module-not-found**

Run: `pnpm test src/lib/skills/__tests__/migration-enabled-v1.test.ts`
Expected: tests fail with import error.

- [ ] **Step 4: Create `src/lib/skills/migration-enabled-v1.ts`**

```typescript
const FLAG_KEY = "enabled_skills_migrated_v1";
const ENABLED_KEY = "enabled_skills";

export async function migrateSkillsEnabledAllOn(): Promise<void> {
  try {
    const got = await chrome.storage.local.get([FLAG_KEY, ENABLED_KEY]);
    if (got[FLAG_KEY]) return;
    const raw = Array.isArray(got[ENABLED_KEY]) ? (got[ENABLED_KEY] as unknown[]) : [];
    const next = raw.filter(
      (id): id is string => typeof id === "string" && !id.startsWith("!"),
    );
    await chrome.storage.local.set({
      [ENABLED_KEY]: next,
      [FLAG_KEY]: true,
    });
  } catch (err) {
    console.warn("[migration-enabled-v1] failed (will retry on next boot)", err);
  }
}
```

- [ ] **Step 5: Run test — verify PASS**

Run: `pnpm test src/lib/skills/__tests__/migration-enabled-v1.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skills/migration-enabled-v1.ts src/lib/skills/__tests__/migration-enabled-v1.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): add one-shot enabled_skills_migrated_v1 migration

清理老用户 storage 中遗留的 '!<id>' 显式禁用条目，让其与新装用户一致：
所有 builtin skill 默认启用。失败仅 warn 不阻塞 sidepanel 启动。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: builtin.ts — force `enabled: true` + translate `create_skill_from_recording`

**Why:** Built-in skills become hidden from UI and default-on. The remaining Chinese in `create_skill_from_recording` (description + 2 parameter descriptions + JSDoc-style comment) must become English per the "LLM-visible strings unified to English" rule.

**Files:**
- Modify: `src/lib/skills/builtin.ts`

### Steps

- [ ] **Step 1: Read current `builtin.ts` around the two default-false skills**

Run: `grep -n "enabled:" src/lib/skills/builtin.ts`
Expected: see 5 `enabled: ...` lines; 3 are `true`, 2 are `false`.

- [ ] **Step 2: Flip the two `enabled: false` lines to `enabled: true`**

Edit `src/lib/skills/builtin.ts`:

In the `close_duplicate_tabs` skill definition, find:

```typescript
  enabled: false,
```

(scope: inside the object that has `id: "close_duplicate_tabs"`)

Replace with:

```typescript
  enabled: true,
```

In the `close_inactive_tabs` skill definition, do the same change.

(If `replace_all` ambiguity arises, use larger context: include 1-2 surrounding lines unique to each skill, such as the `id: "close_duplicate_tabs",` line directly above.)

- [ ] **Step 3: Translate `create_skill_from_recording` Chinese strings to English**

Find the skill block (around lines 159-221). Replace these specific strings:

```typescript
  description: "根据用户演示过的录制 trace + 自然语言提示，自动创建一个新的可复用 skill。由 RecordingMode \"Finish\" 流程触发。",
```

with:

```typescript
  description: "Create a new reusable skill from a recorded user demonstration trace plus a natural-language prompt. Triggered by the RecordingMode \"Finish\" flow.",
```

Replace:

```typescript
          description: "由 sidepanel 录制层序列化好的步骤文本（中文步骤序列）。直接喂给 LLM 当上下文。"
```

with:

```typescript
          description: "Step text serialized by the sidepanel recorder. Fed to the LLM directly as context."
```

Replace:

```typescript
          description: "用户的自由文本提示（如\"参数化 username 和 password\" / \"跳过最后那个验证码步骤\"）。可以为空。"
```

with:

```typescript
          description: "Free-form prompt from the user (e.g. \"parameterize username and password\" / \"skip the last captcha step\"). May be empty."
```

- [ ] **Step 4: Re-grep for any remaining Chinese in builtin.ts**

Run: `grep -n '[一-鿿]' src/lib/skills/builtin.ts`
Expected: 0 matches.

- [ ] **Step 5: Run tests**

Run: `pnpm test src/lib/skills/`
Expected: existing skills tests (if any) pass; nothing else regresses.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skills/builtin.ts
git commit -m "$(cat <<'EOF'
refactor(skills/builtin): force all built-ins enabled=true + translate to English

5 个 builtin skill 全部 default enabled（close_duplicate_tabs / close_inactive_tabs
不再 default-off）。create_skill_from_recording 残留中文 description / parameter
description 翻译为英文，确保 LLM 看到的描述全英文。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: SkillsList.tsx — hide BUILT-IN section

**Why:** Skills list now only exposes user-defined skills. Built-in stays in `getEnabledSkills()` runtime list but invisible in UI.

**Files:**
- Modify: `src/sidepanel/components/SkillsList.tsx`

### Steps

- [ ] **Step 1: Read the BUILT-IN section block**

Run: `sed -n '280,330p' src/sidepanel/components/SkillsList.tsx`
Expected: see the JSX block with `builtIn.length > 0 && (...)` containing `SkillsSection title="BUILT-IN"`.

- [ ] **Step 2: Remove the BUILT-IN JSX block**

Edit `src/sidepanel/components/SkillsList.tsx`:

Find the BUILT-IN block (rough lines 287-300, exact bounds depend on file):

```typescript
{builtIn.length > 0 && (
  <SkillsSection title="BUILT-IN" subtitle={`${builtIn.length} · read-only`}>
    {builtIn.map((skill) => (
      ...
    ))}
  </SkillsSection>
)}
```

Replace with an empty line. (If the engineer cannot make the `old_string` unique, expand context to include the preceding `</section>` or the following `{custom.length > 0 && (` line.)

- [ ] **Step 3: Remove the `builtIn` derivation if it's now unused**

Find the line that computes `builtIn` (typically `const builtIn = skills.filter((s) => s.builtIn);` or similar). Use grep to confirm no other usage exists:

Run: `grep -n 'builtIn' src/sidepanel/components/SkillsList.tsx`
Expected: only the derivation line remains (everything else removed by Step 2).

Remove the derivation line.

- [ ] **Step 4: Run unit tests**

Run: `pnpm test src/sidepanel/components/SkillsList`
Expected: passes (if a snapshot test of SkillsList exists, update it; if no test currently exists, none is required).

- [ ] **Step 5: Run build**

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/SkillsList.tsx
git commit -m "$(cat <<'EOF'
refactor(skills-list): drop BUILT-IN section, render only user skills

Built-in skills 现在永远默认启用，列表里不再暴露 toggle / 描述。getEnabledSkills()
逻辑不变，但用户无法通过 UI 写入 '!<id>' 显式禁用条目。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: main.tsx — run migration + wrap I18nProvider

**Why:** Mount point change: await the migration before React renders (avoids racing with `loadSkills()` in SkillsList), then wrap `<App />` in `<I18nProvider>`.

**Files:**
- Modify: `src/sidepanel/main.tsx`

### Steps

- [ ] **Step 1: Read current main.tsx**

Run: `cat src/sidepanel/main.tsx`
Expected:

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 2: Replace `src/sidepanel/main.tsx`**

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { I18nProvider } from "@/lib/i18n";
import { migrateSkillsEnabledAllOn } from "@/lib/skills/migration-enabled-v1";

async function boot() {
  await migrateSkillsEnabledAllOn();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
}

void boot();
```

- [ ] **Step 3: Run build to confirm imports resolve**

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/main.tsx
git commit -m "$(cat <<'EOF'
feat(sidepanel): wire I18nProvider + run enabled_skills migration on boot

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Settings.tsx — Language select + "+ 新建配置" t-ify

**Why:** Surfacing the Language control + cleaning the one Chinese button in Settings.

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/Settings.tsx`

### Steps

- [ ] **Step 1: Add new keys to `en.ts`**

Edit `src/lib/i18n/dictionaries/en.ts`. Replace:

```typescript
export const enDict = {
  common: {
    cancel: "Cancel",
    save: "Save",
    confirm: "Confirm",
    delete: "Delete",
    refresh: "Refresh",
    back: "Back",
    copy: "Copy",
    copyFailed: "Copy failed",
  },
} as const satisfies DictNode;
```

with:

```typescript
export const enDict = {
  common: {
    cancel: "Cancel",
    save: "Save",
    confirm: "Confirm",
    delete: "Delete",
    refresh: "Refresh",
    back: "Back",
    copy: "Copy",
    copyFailed: "Copy failed",
  },
  settings: {
    language: {
      sectionTitle: "LANGUAGE",
      label: "UI language",
      optionAuto: "Auto (follow browser)",
      optionEn: "English",
      optionZhCN: "中文 (Simplified Chinese)",
    },
    myConfigs: {
      title: "MY CONFIGS",
      countSuffix: "configs",
      newConfigButton: "+ New config",
    },
  },
} as const satisfies DictNode;
```

- [ ] **Step 2: Mirror the changes to `zh-CN.ts`**

Edit `src/lib/i18n/dictionaries/zh-CN.ts`. Replace:

```typescript
export const zhCNDict = {
  common: {
    cancel: "取消",
    save: "保存",
    confirm: "确认",
    delete: "删除",
    refresh: "刷新",
    back: "返回",
    copy: "复制",
    copyFailed: "复制失败",
  },
} as const satisfies EnDict;
```

with:

```typescript
export const zhCNDict = {
  common: {
    cancel: "取消",
    save: "保存",
    confirm: "确认",
    delete: "删除",
    refresh: "刷新",
    back: "返回",
    copy: "复制",
    copyFailed: "复制失败",
  },
  settings: {
    language: {
      sectionTitle: "语言",
      label: "界面语言",
      optionAuto: "自动（跟随浏览器）",
      optionEn: "English",
      optionZhCN: "中文（简体）",
    },
    myConfigs: {
      title: "我的配置",
      countSuffix: "条配置",
      newConfigButton: "+ 新建配置",
    },
  },
} as const satisfies EnDict;
```

- [ ] **Step 3: Run parity test**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: passes.

- [ ] **Step 4: Add Language section + t-ify "+ 新建配置" in `Settings.tsx`**

Edit `src/sidepanel/components/Settings.tsx`:

(4a) Add import near the top with the other imports:

```typescript
import { useT, setLocale, getLocale, type Locale, type LocaleSetting } from "@/lib/i18n";
```

(4b) Inside `Settings` component body, add (after other `useState` calls):

```typescript
  const t = useT();
```

(4c) Find the MY CONFIGS section (around line 180):

```typescript
<section className="flex flex-col gap-3.5">
  <div className="flex items-baseline justify-between">
    <span className="caps text-fg-3">MY CONFIGS</span>
    <span className="font-mono text-[10px] text-fg-3">{instances.length} configs</span>
  </div>
```

Replace with:

```typescript
<section className="flex flex-col gap-3.5">
  <div className="flex items-baseline justify-between">
    <span className="caps text-fg-3">{t("settings.myConfigs.title")}</span>
    <span className="font-mono text-[10px] text-fg-3">
      {instances.length} {t("settings.myConfigs.countSuffix")}
    </span>
  </div>
```

(4d) Find line 271:

```typescript
                  + 新建配置
```

Replace with:

```typescript
                  {t("settings.myConfigs.newConfigButton")}
```

(4e) Add the Language section before the closing tag of the component. Find the very last `</section>` of Settings and insert a new section **before** the component's outermost closing tag (or in the same flex container as other sections — match nearby pattern):

```typescript
<section className="flex flex-col gap-3.5">
  <div className="caps text-fg-3">{t("settings.language.sectionTitle")}</div>
  <label className="flex items-center gap-2 text-[12px]">
    <span className="text-fg-2 min-w-[120px]">{t("settings.language.label")}</span>
    <select
      className="font-mono text-[12px] bg-field rounded px-2 py-1"
      defaultValue="auto"
      onChange={(e) => {
        void setLocale(e.target.value as LocaleSetting);
      }}
      ref={(el) => {
        if (!el) return;
        // Sync the select to the stored setting on mount. Reading from
        // chrome.storage is async; the resolver effect in I18nProvider
        // already handled the effective locale, but the <select> needs
        // to reflect 'auto' vs explicit choice.
        chrome.storage.local.get("ui_locale").then((g) => {
          const v = g["ui_locale"];
          if (v === "auto" || v === "en" || v === "zh-CN") el.value = v;
        });
      }}
    >
      <option value="auto">{t("settings.language.optionAuto")}</option>
      <option value="en">{t("settings.language.optionEn")}</option>
      <option value="zh-CN">{t("settings.language.optionZhCN")}</option>
    </select>
  </label>
</section>
```

- [ ] **Step 5: Manual sanity check — load extension and switch language**

Run: `pnpm build`
Expected: succeeds.

(Manual: `chrome://extensions` → reload → open side panel → Settings → switch Language to 中文 → MY CONFIGS / cancel / save labels flip to Chinese.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/Settings.tsx
git commit -m "$(cat <<'EOF'
feat(settings): add Language select + i18n MY CONFIGS labels

Auto / English / 中文 三选项；切换即时生效（不 reload）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: useSession — t-ify the user-visible error message

**Why:** `src/sidepanel/hooks/useSession/index.ts:627` writes a Chinese error string into session state that's rendered in the UI. Translation must live in dict and pull through `getLocale()` since this hook runs outside React render (it's an async callback path, so we can't use `useT()` there).

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/hooks/useSession/index.ts`
- Modify: `src/sidepanel/hooks/useSession/index.test.ts`

### Steps

- [ ] **Step 1: Add the error key to `en.ts`**

Edit `src/lib/i18n/dictionaries/en.ts`. Inside the top-level object, add the `errors` namespace (or extend if it already exists in a later task):

Find:

```typescript
  common: {
    ...
  },
  settings: {
    ...
  },
```

Add (place between `common` and `settings`, alphabetic order within the file):

```typescript
  errors: {
    connectBackgroundFailedRetry: "Unable to reach the background service. Please retry.",
  },
```

- [ ] **Step 2: Mirror to `zh-CN.ts`**

Add:

```typescript
  errors: {
    connectBackgroundFailedRetry: "无法连接到后台服务，请重试",
  },
```

- [ ] **Step 3: Run parity test**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: passes.

- [ ] **Step 4: Replace the hardcoded string in `useSession/index.ts`**

Edit `src/sidepanel/hooks/useSession/index.ts`. Find:

```typescript
          error: "无法连接到后台服务，请重试",
```

(Use ~3 lines of surrounding context to make unique — the line is in a state-update block near line 627.)

Replace with:

```typescript
          error: t("errors.connectBackgroundFailedRetry"),
```

Add the import at the top of `useSession/index.ts` (near other lib imports):

```typescript
import { useT } from "@/lib/i18n";
```

Inside the `useSession` hook body (top), add:

```typescript
  const t = useT();
```

Note: `t` is captured by closure in subsequent callbacks; that's fine because `useT()` returns a fresh closure each render and the callbacks read from refs / current state.

If the failing-path callback that contains this line is wrapped in `useCallback` with a dependency array, add `t` to the deps. Otherwise no change.

- [ ] **Step 5: Update the failing test expectation**

Edit `src/sidepanel/hooks/useSession/index.test.ts` line ~1001. Find:

```typescript
      expect(result.current.error).toBe("无法连接到后台服务，请重试");
```

Replace with:

```typescript
      expect(result.current.error).toBe("Unable to reach the background service. Please retry.");
```

(The default test locale is `en`, set by the setup.ts beforeEach.)

- [ ] **Step 6: Run useSession tests**

Run: `pnpm test src/sidepanel/hooks/useSession`
Expected: passes (including the previously-Chinese expect now matching English).

- [ ] **Step 7: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/hooks/useSession/
git commit -m "$(cat <<'EOF'
refactor(useSession): t-ify panel-visible 'connect failed' error

错误消息走 useT()；测试 expect 同步更新为英文（en 是默认 test locale）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Chat.tsx — t-ify recording prompts + image placeholder badge

**Why:** Largest concentration of UI Chinese: recording mode hints (lines 643, 644, 1156, 1170) + image-released placeholder (lines 1364, 1367).

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/Chat.tsx`
- Modify: `src/sidepanel/components/Chat.test.tsx`

### Steps

- [ ] **Step 1: Add Chat keys to `en.ts`**

Add inside the top-level object (alongside other namespaces):

```typescript
  chat: {
    recording: {
      createSkillFromRecording: "📼 Create skill from recording: {input}",
      createSkillFromRecordingWithStep: "📼 Create skill from recording ({stepCount} steps)",
      sendHint: "Send → the LLM will call create_skill_from_recording.\n\nPreview (first 200 chars)...",
      composeHint: "Write a prompt → Send to let the LLM create the skill",
    },
    attachment: {
      imagePlaceholderTitle: "Images are not persisted — released after switching sessions or SW restart",
      imageReleasedBadge: "[Image released] {width}×{height}",
    },
  },
```

- [ ] **Step 2: Mirror to `zh-CN.ts`**

```typescript
  chat: {
    recording: {
      createSkillFromRecording: "📼 从录制创建 skill：{input}",
      createSkillFromRecordingWithStep: "📼 从录制创建 skill（{stepCount} 步）",
      sendHint: "Send → 由 LLM 调 create_skill_from_recording 创建 skill\n\n预览（前 200 字）...",
      composeHint: "写提示 → Send 让 LLM 创建 skill",
    },
    attachment: {
      imagePlaceholderTitle: "图片不持久化存储 — 切换会话或重启 SW 后释放",
      imageReleasedBadge: "[图已释放] {width}×{height}",
    },
  },
```

- [ ] **Step 3: Apply substitutions in `Chat.tsx`**

Edit `src/sidepanel/components/Chat.tsx`. Add import at top:

```typescript
import { useT } from "@/lib/i18n";
```

Add `const t = useT();` near the top of the `Chat` component body.

(3a) Find line 643:

```typescript
              `📼 从录制创建 skill：${userInput}`
```

Replace with:

```typescript
              t("chat.recording.createSkillFromRecording", { input: userInput })
```

(3b) Find line 644:

```typescript
              `📼 从录制创建 skill（${pendingRecording.stepCount} 步）`
```

Replace with:

```typescript
              t("chat.recording.createSkillFromRecordingWithStep", { stepCount: pendingRecording.stepCount })
```

(3c) Find line 1156 (use surrounding context to make unique):

```typescript
                "Send → 由 LLM 调 create_skill_from_recording 创建 skill\n\n预览（前 200 字）..."
```

Replace with:

```typescript
                t("chat.recording.sendHint")
```

(3d) Find line 1170:

```typescript
                "写提示 → Send 让 LLM 创建 skill"
```

Replace with:

```typescript
                t("chat.recording.composeHint")
```

(3e) Find line 1364:

```typescript
                title="图片不持久化存储 — 切换会话或重启 SW 后释放"
```

Replace with:

```typescript
                title={t("chat.attachment.imagePlaceholderTitle")}
```

(3f) Find line 1367:

```typescript
                {`[图已释放] ${a.width}×${a.height}`}
```

Replace with:

```typescript
                {t("chat.attachment.imageReleasedBadge", { width: a.width, height: a.height })}
```

- [ ] **Step 4: Update Chat.test.tsx expects**

Edit `src/sidepanel/components/Chat.test.tsx`. Find line ~341 (test description) and ~373 (expect):

```typescript
  it("user message with image_placeholder attachment shows '[图已释放]' badge", async () => {
```

Replace with:

```typescript
  it("user message with image_placeholder attachment shows '[Image released]' badge", async () => {
```

Find:

```typescript
    const badge = screen.getByText(/图已释放/);
```

Replace with:

```typescript
    const badge = screen.getByText(/Image released/);
```

- [ ] **Step 5: Run Chat tests**

Run: `pnpm test src/sidepanel/components/Chat`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "$(cat <<'EOF'
feat(chat): i18n recording hints + image-placeholder badge

录制流程的 6 处中文字符串改走 t()；image_placeholder badge 测试 expect 同步
更新为英文（默认 test locale）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: ModelDropdown.tsx — t-ify all Chinese

**Why:** 11 Chinese strings concentrated in one dropdown component.

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/ModelDropdown.tsx`
- Modify: `src/sidepanel/components/ModelDropdown.test.tsx`

### Steps

- [ ] **Step 1: Add `modelDropdown.*` keys to both dicts**

`en.ts`:

```typescript
  modelDropdown: {
    selectModelPlaceholder: "(select model)",
    notFetched: "not fetched",
    fetching: "fetching...",
    refresh: "↻ refresh",
    searchPlaceholder: "Search {count} models...",
    noMatch: "no match ({count} total)",
    emptyUseAdd: "(empty — use + to add custom)",
    addCustomModel: "+ add custom model",
  },
```

`zh-CN.ts`:

```typescript
  modelDropdown: {
    selectModelPlaceholder: "(选择模型)",
    notFetched: "未拉取",
    fetching: "拉取中…",
    refresh: "↻ 刷新",
    searchPlaceholder: "搜索 {count} 个模型…",
    noMatch: "无匹配 ({count} total)",
    emptyUseAdd: "(空 — 用 + 添加自定义)",
    addCustomModel: "+ 添加自定义模型",
  },
```

- [ ] **Step 2: Edit `ModelDropdown.tsx`**

Add import:

```typescript
import { useT } from "@/lib/i18n";
```

Add `const t = useT();` near component top.

Replace these lines (use surrounding context to make each `old_string` unique):

| Line | From | To |
|------|------|-----|
| 64 | `aria-label={props.value \|\| "(选择模型)"}` | `aria-label={props.value \|\| t("modelDropdown.selectModelPlaceholder")}` |
| 68 | `<span className="font-mono">{props.value \|\| "(选择模型)"}</span>` | `<span className="font-mono">{props.value \|\| t("modelDropdown.selectModelPlaceholder")}</span>` |
| 79 | `: "未拉取"}` | `: t("modelDropdown.notFetched")}` |
| 81 | `{props.isFetching ? "拉取中…" : "↻ 刷新"}` | `{props.isFetching ? t("modelDropdown.fetching") : t("modelDropdown.refresh")}` |
| 91 | `placeholder={`搜索 ${fullList.length} 个模型…`}` | `placeholder={t("modelDropdown.searchPlaceholder", { count: fullList.length })}` |
| 103 | `? "拉取中…"` | `? t("modelDropdown.fetching")` |
| 105 | `? `无匹配 (${fullList.length} total)`` | `? t("modelDropdown.noMatch", { count: fullList.length })` |
| 106 | `: "(空 — 用 + 添加自定义)"}` | `: t("modelDropdown.emptyUseAdd")}` |
| 144 | `+ 添加自定义模型` (button text, inside JSX) | `{t("modelDropdown.addCustomModel")}` |
| 160 | `保存` | `{t("common.save")}` |
| 166 | `取消` | `{t("common.cancel")}` |

- [ ] **Step 3: Update ModelDropdown.test.tsx**

Find line 55:

```typescript
    fireEvent.click(screen.getByRole("button", { name: /选择模型/ }));
```

Replace with:

```typescript
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/sidepanel/components/ModelDropdown`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/ModelDropdown.tsx src/sidepanel/components/ModelDropdown.test.tsx
git commit -m "$(cat <<'EOF'
feat(model-dropdown): i18n all labels (select / fetch / search / add custom)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: NewConfigWizard.tsx — t-ify

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`

### Steps

- [ ] **Step 1: Add keys**

`en.ts`:

```typescript
  newConfigWizard: {
    step1Title: "STEP 1 — SELECT PROVIDER",
    changeProvider: "← change provider",
  },
```

`zh-CN.ts`:

```typescript
  newConfigWizard: {
    step1Title: "STEP 1 — 选 PROVIDER",
    changeProvider: "← 改 provider",
  },
```

- [ ] **Step 2: Edit `NewConfigWizard.tsx`**

Add import + `const t = useT();` at top of component.

Replacements:

| Line | From | To |
|------|------|-----|
| 86 | `STEP 1 — 选 PROVIDER` | `{t("newConfigWizard.step1Title")}` |
| 132 | `取消` | `{t("common.cancel")}` |
| 186 | `← 改 provider` | `{t("newConfigWizard.changeProvider")}` |
| 194 | `取消` | `{t("common.cancel")}` |

- [ ] **Step 3: Run tests & build**

Run: `pnpm test src/sidepanel/components/`
Run: `pnpm build`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/NewConfigWizard.tsx
git commit -m "$(cat <<'EOF'
feat(new-config-wizard): i18n step labels + cancel/back buttons

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: AgentStepLine.tsx — t-ify

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/AgentStepLine.tsx`
- Modify: `src/sidepanel/components/AgentStepLine.test.tsx`

### Steps

- [ ] **Step 1: Add keys**

Because the component renders `<code>{tool}</code>` as JSX (not HTML in string), put only the translatable prefix into the dict and keep the JSX wrapper in the component. This avoids `dangerouslySetInnerHTML` and keeps the `{tool}` value type-safe.

`en.ts`:

```typescript
  agentStep: {
    callingToolPrefix: "Calling",
    collapse: "Collapse",
    expand: "Details",
  },
```

`zh-CN.ts`:

```typescript
  agentStep: {
    callingToolPrefix: "正在调用",
    collapse: "收起",
    expand: "详情",
  },
```

- [ ] **Step 2: Edit `AgentStepLine.tsx`**

Add import + `const t = useT();` near component top.

Find around line 53:

```typescript
              正在调用 <code className="font-mono text-fg-1">{tool}</code>
```

Replace with:

```typescript
              {t("agentStep.callingToolPrefix")} <code className="font-mono text-fg-1">{tool}</code>
```

Find around line 71:

```typescript
          {expanded ? "收起" : "详情"}
```

Replace with:

```typescript
          {expanded ? t("agentStep.collapse") : t("agentStep.expand")}
```

- [ ] **Step 3: Update test expects**

Edit `src/sidepanel/components/AgentStepLine.test.tsx`. Find:

```typescript
    // user clicking the "详情" toggle. The image rendering happens inside
```

(comment — optional update, may stay as-is). And the actual expect at line 67:

```typescript
    const toggle = screen.getByRole("button", { name: /详情/ });
```

Replace with:

```typescript
    const toggle = screen.getByRole("button", { name: /details/i });
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/sidepanel/components/AgentStepLine`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/AgentStepLine.tsx src/sidepanel/components/AgentStepLine.test.tsx
git commit -m "$(cat <<'EOF'
feat(agent-step-line): i18n calling/collapse/expand labels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: QuoteChip.tsx — t-ify

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/QuoteChip.tsx`
- Modify: `src/sidepanel/components/QuoteChip.test.tsx`

### Steps

- [ ] **Step 1: Add keys**

`en.ts`:

```typescript
  quoteChip: {
    removeQuote: "Remove quote",
    screenshotUnavailable: "[Screenshot unavailable]",
  },
```

`zh-CN.ts`:

```typescript
  quoteChip: {
    removeQuote: "移除引用",
    screenshotUnavailable: "[截图不可用]",
  },
```

- [ ] **Step 2: Edit `QuoteChip.tsx`**

Add import + `const t = useT();` near component top.

Find line 63:

```typescript
        aria-label="移除引用"
```

Replace with:

```typescript
        aria-label={t("quoteChip.removeQuote")}
```

Find line 94:

```typescript
                <div className="italic text-fg-3">[截图不可用]</div>
```

Replace with:

```typescript
                <div className="italic text-fg-3">{t("quoteChip.screenshotUnavailable")}</div>
```

- [ ] **Step 3: Update `QuoteChip.test.tsx`**

Find lines 20, 41, 56, 63 (4 expects):

```typescript
    expect(screen.getByRole("button", { name: /移除引用/ })).toBeTruthy();
```

→

```typescript
    expect(screen.getByRole("button", { name: /remove quote/i })).toBeTruthy();
```

```typescript
  it("element chip with null imageDataUrl shows [截图不可用]", () => {
```

→

```typescript
  it("element chip with null imageDataUrl shows [Screenshot unavailable]", () => {
```

```typescript
    expect(screen.getByText(/截图不可用/)).toBeTruthy();
```

→

```typescript
    expect(screen.getByText(/screenshot unavailable/i)).toBeTruthy();
```

```typescript
    fireEvent.click(screen.getByRole("button", { name: /移除引用/ }));
```

→

```typescript
    fireEvent.click(screen.getByRole("button", { name: /remove quote/i }));
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/sidepanel/components/QuoteChip`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/QuoteChip.tsx src/sidepanel/components/QuoteChip.test.tsx
git commit -m "$(cat <<'EOF'
feat(quote-chip): i18n remove + screenshot-unavailable labels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: InstanceSelector.tsx — t-ify

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/InstanceSelector.tsx`

### Steps

- [ ] **Step 1: Add key**

`en.ts`:

```typescript
  instanceSelector: {
    newConfigOrManage: "+ New config / Manage configs",
  },
```

`zh-CN.ts`:

```typescript
  instanceSelector: {
    newConfigOrManage: "+ 新建配置 / 管理配置",
  },
```

- [ ] **Step 2: Edit `InstanceSelector.tsx`**

Add import + `const t = useT();`.

Find line 92:

```typescript
            <span>+ 新建配置 / Manage configs</span>
```

Replace with:

```typescript
            <span>{t("instanceSelector.newConfigOrManage")}</span>
```

- [ ] **Step 3: Run tests**

Run: `pnpm test src/sidepanel/components/InstanceSelector`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/InstanceSelector.tsx
git commit -m "$(cat <<'EOF'
feat(instance-selector): i18n new-config CTA

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: SkillsList residual i18n + cleanup remaining non-comment Chinese

**Why:** `SkillsList.tsx:273-274` has a Chinese subtitle/description string for the section header. Also covers any final stragglers found by grep.

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`
- Modify: `src/sidepanel/components/SkillsList.tsx`

### Steps

- [ ] **Step 1: Identify remaining Chinese in `src/sidepanel/`**

Run: `grep -rn '[一-鿿]' src/sidepanel/ --include='*.tsx' --include='*.ts' | grep -v __tests__ | grep -v '\.test\.' | grep -v hooks/useSession/`
Expected: at this point you should see just SkillsList.tsx:273-274 plus comment-only lines (AgentStepLine.tsx top JSDoc, AgentStepGroup.tsx:3, InstanceForm.tsx:16,68, useSession/index.ts:545 etc — these are comments, out of scope).

- [ ] **Step 2: Read SkillsList.tsx:270-280**

Run: `sed -n '265,285p' src/sidepanel/components/SkillsList.tsx`
Expected: see the user-facing description string near the YOURS section header or empty-state CTA.

- [ ] **Step 3: Add dict keys** (capture actual strings from Step 2 — placeholders below illustrate the pattern)

`en.ts`:

```typescript
  skills: {
    empty: {
      cta: "Create a reusable workflow (skill). Underlying tools auto-resolve from the prompt.",
    },
    section: {
      yours: {
        title: "YOURS",
        subtitleEditable: "{count} · editable",
      },
    },
  },
```

`zh-CN.ts`:

```typescript
  skills: {
    empty: {
      cta: "显示可复用工作流（skill）。底层工具按 prompt 自动 resolve。",
    },
    section: {
      yours: {
        title: "YOURS",
        subtitleEditable: "{count} · editable",
      },
    },
  },
```

(Adjust English values to whatever the engineer found in Step 2; this template is a best-guess.)

- [ ] **Step 4: Substitute in SkillsList.tsx**

Replace the Chinese block on lines 273-274 with `t("skills.empty.cta")`. Use sufficient surrounding context to make the replacement unique.

Also t-ify the YOURS section header subtitle if it currently uses a hardcoded string:

Find:

```typescript
  <SkillsSection title="YOURS" subtitle={`${custom.length} · editable`}>
```

Replace with:

```typescript
  <SkillsSection title={t("skills.section.yours.title")} subtitle={t("skills.section.yours.subtitleEditable", { count: custom.length })}>
```

Add `const t = useT();` near top of component if not already present. Add the import.

- [ ] **Step 5: Re-grep to confirm no remaining non-comment Chinese in src/sidepanel/**

Run:

```bash
grep -rn '[一-鿿]' src/sidepanel/ --include='*.tsx' --include='*.ts' \
  | grep -v __tests__ \
  | grep -v '\.test\.' \
  | grep -vE '//.*[一-鿿]' \
  | grep -vE '\*.*[一-鿿]'
```

Expected: 0 matches (or only matches that are clearly comments).

- [ ] **Step 6: Run tests & build**

Run: `pnpm test`
Run: `pnpm build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/sidepanel/components/SkillsList.tsx
git commit -m "$(cat <<'EOF'
feat(skills-list): i18n empty-state CTA + YOURS section header

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Manifest `default_locale` + `_locales/` for store listing

**Why:** Chrome Web Store displays `name` / `description` from the user's Chrome UI language. This is the only place that genuinely requires `chrome.i18n`'s `__MSG__` mechanism (the extension isn't running yet at listing-render time).

**Files:**
- Modify: `manifest.json`
- Create: `_locales/en/messages.json`
- Create: `_locales/zh_CN/messages.json`

### Steps

- [ ] **Step 1: Create `_locales/en/messages.json`**

```json
{
  "extension_name": {
    "message": "Pie",
    "description": "Extension name shown in Chrome and the Web Store."
  },
  "extension_description": {
    "message": "BYOK Chrome Extension Agent — bring your own API key for AI-powered browser actions.",
    "description": "Short description shown in the Web Store and chrome://extensions."
  }
}
```

- [ ] **Step 2: Create `_locales/zh_CN/messages.json`**

```json
{
  "extension_name": {
    "message": "Pie",
    "description": "Extension name shown in Chrome and the Web Store."
  },
  "extension_description": {
    "message": "BYOK Chrome 浏览器扩展 Agent — 自带 API key 获得 AI 浏览器自动化能力。",
    "description": "Short description shown in the Web Store and chrome://extensions."
  }
}
```

- [ ] **Step 3: Edit `manifest.json`**

Find:

```json
  "manifest_version": 3,
  "name": "Pie",
  "version": "0.10.0",
  "description": "BYOK Chrome Extension Agent...",
```

(The `"description"` value is approximated — copy verbatim from current manifest.)

Replace with:

```json
  "manifest_version": 3,
  "default_locale": "en",
  "name": "__MSG_extension_name__",
  "version": "0.10.0",
  "description": "__MSG_extension_description__",
```

- [ ] **Step 4: Build and verify dist includes `_locales/`**

Run: `pnpm build`
Run: `ls dist/_locales/`
Expected: `en/` and `zh_CN/` directories present, each containing `messages.json`.

- [ ] **Step 5: Manual smoke — load unpacked dist, switch Chrome UI language**

Load `dist/` in `chrome://extensions`. Set Chrome to English → extension name displays as "Pie" and description in English. Switch Chrome to Chinese (Simplified) → reload extension → description shows the Chinese value.

- [ ] **Step 6: Commit**

```bash
git add manifest.json _locales/
git commit -m "$(cat <<'EOF'
feat(manifest): use chrome.i18n __MSG__ for name + description

_locales/{en,zh_CN}/messages.json 提供 extension_name / extension_description；
Chrome Web Store 按用户 Chrome UI 语言展示。runtime UI 字符串走 src/lib/i18n/，
不进 _locales/。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Final acceptance — grep verification, full test, manual smoke

**Why:** Spec Section 11 verification gate.

### Steps

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: all green (no Chinese-related regressions).

- [ ] **Step 2: Run full build**

Run: `pnpm build`
Expected: succeeds; `dist/_locales/` present.

- [ ] **Step 3: Verify no Chinese in production UI source (excluding zh-CN dict + comments)**

Run:

```bash
grep -rn '[一-鿿]' src/sidepanel/ --include='*.tsx' --include='*.ts' \
  | grep -v __tests__ \
  | grep -v '\.test\.' \
  | grep -vE '//.*[一-鿿]' \
  | grep -vE '\*.*[一-鿿]'
```

Expected: 0 matches.

Run:

```bash
grep -rn '[一-鿿]' src/lib/i18n/dictionaries/zh-CN.ts | wc -l
```

Expected: positive number (every translated value is Chinese — sanity check).

- [ ] **Step 4: Verify no Chinese in LLM-visible surfaces**

Run:

```bash
grep -rn '[一-鿿]' src/lib/agent/ src/lib/skills/ \
  | grep -v __tests__ \
  | grep -v '\.test\.' \
  | grep -vE '//.*[一-鿿]' \
  | grep -vE '\*.*[一-鿿]'
```

Expected: 0 matches.

- [ ] **Step 5: Manual smoke matrix**

Load the latest `dist/` in Chrome (`chrome://extensions` → reload). For each row, perform the steps and confirm expected outcome:

| Setup | Action | Expected |
|---|---|---|
| Chrome UI = English, fresh profile | Open side panel | All UI in English, Skills list shows only YOURS section (empty) |
| Chrome UI = Chinese, fresh profile | Open side panel | All UI in Chinese, Skills list shows only YOURS section (empty) |
| Chrome UI = English, settings Language = 中文 | Open side panel | UI in Chinese (override wins) |
| Chrome UI = English, settings Language = Auto | Open side panel | UI in English (auto → chrome.i18n → en) |
| Existing profile with old `enabled_skills: ["!close_duplicate_tabs"]` (seed via DevTools) | Reload extension | After first sidepanel open: `enabled_skills` cleared of `!`-entries, `enabled_skills_migrated_v1: true` |
| Side panel running, change Settings Language | Switch en → 中文 → en | UI flips instantly, no reload needed |
| Two side panels open in two windows | Change Language in one | The other window flips after onChanged event |

- [ ] **Step 6: Verify `dist/manifest.json` uses `__MSG__`**

Run: `grep -A1 'name' dist/manifest.json | head -5`
Expected: see `"name": "__MSG_extension_name__"` (Chrome resolves it at load-time using `_locales/`).

- [ ] **Step 7: No commit needed — this is a verification task**

If any step in this task fails, return to the relevant earlier task to fix.

---

## Self-Review (post-write)

**Spec coverage check** (each spec section → which task implements it):

| Spec section | Implementing task(s) |
|---|---|
| §2 Architecture / module boundaries | Tasks 2–5 (i18n module) |
| §3 UI migration scope (sidepanel only) | Tasks 10–18 |
| §3 Tool/skill description English | Task 7 |
| §4 Built-in skill default-on + UI hide | Tasks 7, 8 |
| §4.3 Migration `enabled_skills_migrated_v1` | Task 6 |
| §5 Runtime data flow (resolver + Provider + storage.onChanged) | Tasks 3, 4 |
| §5.4 Type safety (`DictKey` from `EnDict`) | Task 2 (types) + Task 4 (use-t) |
| §6 Settings Language select | Task 10 |
| §7 Manifest + `_locales/` | Task 19 |
| §8 Testing strategy | Built into each TDD task (3, 4, 6) + parity (2) + Settings/Chat/ModelDropdown/AgentStepLine/QuoteChip test updates (10–16) |
| §11 Acceptance criteria | Task 20 |

**Placeholder scan:** No `TBD` / `TODO` / "implement later" markers; every code block is concrete. Two soft spots:
- Task 18 dict values for `skills.empty.cta` are best-guess templates — the executor is told to capture actual strings from Step 2 first. This is acceptable because the source string isn't visible from this writing context.
- Task 13 row 91 `{count}` substitution uses a leftover space-character before "models" — kept as-is to match the previous English-mixed pattern visible in the original code.

**Type consistency:** `DictKey` derived from `EnDict` in Task 2 is consumed by Task 4's `makeT<K extends DictKey>(key: K, ...)`. `Locale` / `LocaleSetting` types defined in Task 2 are used in Tasks 3, 4, 5, 10 consistently. `useT()` returns the closure that callers in Tasks 10–18 invoke with no narrowing surprises.

**Frequent commits:** 19 distinct commits across the plan. Each task is independently revertable.

**DRY / YAGNI:** No premature plural / ICU / multi-locale-dynamic-fetch infrastructure. Just enough for `en` + `zh-CN`.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-16-i18n-language-unification.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
