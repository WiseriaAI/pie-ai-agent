# Activation-First Localization Design

- Date: 2026-06-13
- Status: Approved for planning
- Owner: wenkang.xie
- Scope: extension UI activation path, assistant response language preference, Chrome Web Store listing, landing page, launch docs, market QA

## Goal

Expand Pie beyond the current English and Simplified Chinese experience with a market-ready localization launch for three new locales:

- `es-419`: Latin American Spanish
- `ja`: Japanese
- `pt-BR`: Brazilian Portuguese

The primary success metric is activation: users who install Pie should understand how to configure an API key or managed account and complete their first useful agent interaction. Pie will keep its no-telemetry product promise; success is evaluated through Chrome Web Store data, localized landing URLs, GitHub/email feedback, launch-channel response, and manual user conversations.

## Strategy

Use an Activation-First approach. The first release should not try to translate every deep developer-facing surface. It should make the user journey from store listing to first configured task feel native and trustworthy.

The release covers:

- Extension UI along the activation path.
- Assistant response language preference.
- Chrome Web Store localized listing and screenshots.
- Localized landing page routes.
- Short localized README pages for first setup.
- Market QA and privacy-claim review.

The release does not cover:

- Translating LLM-visible tool descriptions, tool schemas, system prompt body, or built-in skill instructions.
- Full translation of development docs, ADRs, release notes, or deep technical docs.
- RTL language support.
- Product telemetry or anonymous event tracking.

## Locale Scope

The app uses BCP-47 style locale ids internally:

```ts
type Locale = "en" | "zh-CN" | "es-419" | "ja" | "pt-BR";
type LocaleSetting = "auto" | Locale;
```

Chrome extension locale folders continue to use Chrome-supported locale ids:

- `es_419`
- `ja`
- `pt_BR`
- Existing `en`
- Existing `zh_CN`

Browser locale normalization:

- `es-*` should resolve to `es-419` when the language is Spanish.
- `ja` / `ja-*` should resolve to `ja`.
- `pt-BR` should resolve to `pt-BR`.
- `pt-PT` should fall back to English in this release, rather than showing Brazilian Portuguese to Portugal users.
- `zh-*` keeps the existing behavior and resolves to `zh-CN`.
- Unsupported languages fall back to English.

## Assistant Language

Add an Assistant language setting separate from UI language.

```ts
type AssistantLanguageSetting =
  | "auto-follow-ui"
  | "auto-detect-user-message"
  | Locale;
```

Defaults:

- New and existing users default to `auto-follow-ui`.
- `auto-follow-ui` resolves to the effective UI locale.
- `auto-detect-user-message` preserves the current behavior: the model should infer the response language from the user's latest message, with no fixed locale preference.

The prompt layer should inject a small trusted language preference block into each task or chat request. It must not translate the main system prompt, tool descriptions, tool names, tool arguments, schemas, URLs, selectors, code, or quoted page content.

Example resolved block:

```text
<response_language>
Default assistant response language: Japanese (ja).
If the user's latest message explicitly asks for another language, follow the user's request.
Do not translate tool names, tool arguments, URLs, code, selectors, or quoted page content unless asked.
</response_language>
```

User instructions in the latest message override the default response language for that turn.

## Code Architecture

Introduce a locale registry as the single source of truth for app locale metadata.

### `src/lib/i18n/locales.ts`

Defines each supported locale:

- App locale id.
- Chrome locale id.
- Native label used in language pickers.
- Text direction (`ltr` for this release).
- Whether it is available as an Assistant language.
- Dictionary module reference.
- Browser locale matching rules.

The registry replaces scattered hard-coded language lists in `types.ts`, `use-t.tsx`, `locale-resolver.ts`, and `LanguageSelect.tsx`.

### Runtime i18n

`src/lib/i18n/use-t.tsx` should derive dictionaries from the registry instead of maintaining a manual `Record<Locale, DictNode>`.

`LanguageSelect` should derive options from the registry instead of hard-coding `auto`, `en`, and `zh-CN`.

Add `AssistantLanguageSelect` in Settings near the UI language selector.

Expose the effective locale to UI components through a new `useI18n()` hook returning `{ locale, t }`. Components that only translate text may continue using `useT()`. Components that format numbers or dates should use `useI18n()`.

### Dictionaries

`en.ts` remains the source of truth for keys. New dictionaries must be complete:

- `zh-CN.ts`
- `es-419.ts`
- `ja.ts`
- `pt-BR.ts`

Each translation dictionary must satisfy `Translations<EnDict>`.

The parity test should iterate over every dictionary registered in `locales.ts`, not only `zh-CN`.

Partial dictionaries are not allowed for this release. If a UI surface is in scope, it gets real translated copy. If a surface is out of scope, it can remain in English and should be listed explicitly in the launch checklist.

### Formatting

Replace fixed or browser-default formatting where it affects the activation path:

- `Intl.NumberFormat(locale)` for token counts and similar numbers.
- `Intl.DateTimeFormat(locale, ...)` for visible schedule and history times.
- Relative time labels should continue to use dictionary keys for now.

Do not introduce ICU/messageformat in this release. For awkward plural or grammar cases found in QA, split the key into explicit variants or rewrite the surrounding copy to avoid complex grammar.

## Market Assets

Each new locale gets a launch pack.

### Chrome Web Store

For `es_419`, `ja`, and `pt_BR`, provide:

- Extension name.
- Short description within Chrome Web Store limits.
- Long description.
- Localized feature bullets.
- Privacy and BYOK explanation.
- Supported provider list.
- First setup steps.
- Search keywords and positioning notes.

Copy is rewritten for local market expectations, not translated word-for-word.

Tone guidance:

- `es-419`: approachable Latin American Spanish, clear setup steps, avoid Spain-specific phrasing.
- `ja`: concise, careful, trust-forward; explain BYOK as using the user's own API key.
- `pt-BR`: Brazilian Portuguese; emphasize no intermediary server, no telemetry, and local encryption.

### Store Screenshots

Each locale needs at least four localized screenshots:

1. Side panel chat with current-page Q&A.
2. Provider/API key or managed account setup.
3. Multi-step agent execution.
4. Trust point: BYOK, local-first, no telemetry.

Screenshots must be reviewed for text overflow, line wrapping, and visual consistency.

### Landing Page

Extend the current landing page copy structure into locale bundles.

Routes:

- `/`: English default with visible language links. Do not auto-redirect, so campaign links and user expectations stay stable.
- `/es-419/`
- `/ja/`
- `/pt-BR/`

Each route should have localized:

- Page title.
- Meta description.
- Hero.
- Core capabilities.
- BYOK/privacy section.
- Install CTA.
- Getting-started section.
- FAQ or setup notes.

### README

Add short setup-focused docs:

- `README.es-419.md`
- `README.ja.md`
- `README.pt-BR.md`

These documents cover:

- What Pie is.
- Installation.
- First configuration.
- Privacy model.
- Common setup questions.
- Feedback channels.

They do not need to translate the full technical README.

## QA

### Engineering QA

Required checks:

- Typecheck.
- i18n dictionary parity across all registered dictionaries.
- Locale resolver tests for `es-*`, `ja-*`, `pt-BR`, `pt-PT`, `zh-*`, unsupported fallback.
- `LanguageSelect` tests.
- `AssistantLanguageSelect` tests.
- Prompt language block tests for `auto-follow-ui`, `auto-detect-user-message`, and explicit locales.
- A hardcoded visible-text scan for new `src/sidepanel` strings that bypass `t()`.

### Visual QA

Capture activation-path screenshots for:

- `en`
- `zh-CN`
- `es-419`
- `ja`
- `pt-BR`

Screens to review:

- Settings language controls.
- Provider/API key setup.
- Managed account and subscribe CTA.
- Model selection.
- Chat empty state.
- First-message error/CTA surfaces.

Review focus:

- Button width.
- Long Portuguese and Spanish strings.
- Japanese line breaks.
- Dialog and dropdown clipping.
- Screenshot copy overflow.

### Market QA

Each locale needs a native or near-native review checklist:

- Is the activation path understandable?
- Are Pie, agent, BYOK, API key, provider, and local-first translated consistently?
- Are privacy promises accurate and consistent across UI, store, landing, and README?
- Does the copy avoid over-claiming?
- Does the first setup doc let a new user configure Pie without help?

## No-Telemetry Validation

Do not add product analytics or anonymous activation events.

Use these signals:

- Chrome Web Store locale listing visits and install trends.
- Localized landing URLs and external campaign links.
- GitHub issues and email feedback, initiated by users.
- Chrome Web Store reviews and support comments.
- Manual interviews or conversations with early users.

Feedback helpers may include environment details such as app version, browser, active provider/model, and locale in user-initiated issue/email templates. They must not include page content, prompts, URLs, model output, or browsing data unless the user explicitly adds it.

## Milestones

### Milestone 1: Code Capability

- Locale registry.
- New locale ids and browser normalization.
- New complete dictionaries.
- UI language selector from registry.
- Assistant language setting.
- Response language prompt block.
- Locale-aware number/date formatting on activation-path surfaces.
- Tests for registry, resolver, dictionaries, settings, and prompt block.

### Milestone 2: Activation Path Localization

- Localized Settings/config/managed/chat empty/error CTA copy.
- Visual QA for all supported locales.
- Copy review for activation clarity.

### Milestone 3: Market Assets

- Chrome Web Store localized listings.
- Store screenshots.
- Landing routes and meta tags.
- Localized setup README files.
- Privacy/BYOK glossary and review checklist.

### Milestone 4: Small Launch

- Publish localized store and landing assets.
- Promote `es-419` and `pt-BR` together for Latin America/Brazil.
- Promote `ja` separately after final copy review.
- Watch install trends, reviews, issues, and feedback before adding more languages.

## Risks

### LLM behavior drift

Risk: translating tool-visible prompts or schemas could alter tool use.

Mitigation: keep tool descriptions, schemas, system prompt body, and built-in skill instructions in English. Inject only a small response-language preference block.

### Maintenance cost

Risk: new locales increase future UI-copy work.

Mitigation: locale registry, parity tests, hardcoded-string scan, and launch checklist.

### Weak measurement

Risk: no telemetry makes activation harder to measure precisely.

Mitigation: accept coarse signals and use localized launch URLs, store data, feedback, and interviews.

### Privacy copy inconsistency

Risk: localized marketing copy may overstate privacy guarantees.

Mitigation: maintain a glossary for BYOK/no telemetry/local encryption claims and require per-locale market QA before launch.

### Locale mismatch

Risk: regional variants feel wrong, especially `pt-PT` vs `pt-BR` and Spain Spanish vs Latin American Spanish.

Mitigation: explicitly target `pt-BR` and `es-419`; fall back to English for `pt-PT` in this release.
