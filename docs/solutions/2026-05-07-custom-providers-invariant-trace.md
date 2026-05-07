# Custom Provider Invariant Trace

Date: 2026-05-07
Spec: docs/superpowers/specs/2026-05-07-custom-providers-design.md

## Invariants

### C1: Custom provider `baseUrl` defined at provider level, not instance level

`StoredCustomProvider.baseUrl` is the single source of truth. `resolveInstanceToModelConfig` resolves the baseUrl via `resolveProviderMeta` → `meta.defaultBaseUrl` for both builtin and custom providers. Instance-level baseUrl override is not supported.

Enforced by: `resolveInstanceToModelConfig` in `src/lib/instances.ts`, which uses `await resolveProviderMeta(inst.provider)` and reads `meta.defaultBaseUrl`.

### C2: Custom providers always route through `_shared/openai-compat-core.ts`

`dispatchStreamChat` in `src/lib/model-router/providers/index.ts` routes `custom:*` provider refs directly to `streamChatOpenAICompat` — no hooks (no customHeaders, no authHeader). Only standard `Authorization: Bearer ${apiKey}` + `content-type: application/json`.

Enforced by: `dispatchStreamChat(config)` — `config.provider.startsWith("custom:")` → `return streamChatOpenAICompat`.

### C3: `<all_urls>` host_permission required for custom provider fetch

Custom provider fetch (`fetchOpenAICompatModels` for `/v1/models`, and streaming POST to arbitrary baseUrl) relies on the existing `<all_urls>` host_permission in manifest. No URL allow/deny list — BYOK trust model delegates responsibility to the user.

### C4: Cascade-block on custom provider delete

`deleteCustomProvider` in `src/lib/custom-providers.ts` checks for referencing instances (via `getInstancesUsingCustomProvider`) and throws with a count message if any exist. The caller (UI) shows the block message — user must delete referencing instances first.

Enforced by: `deleteCustomProvider(id)` → `getInstancesUsingCustomProvider(id)` → throws if `instances.length > 0`.

### C5: Zero migration

Type `ProviderRef = BuiltinProvider | `custom:${string}`` is a superset of the old `Provider`. Existing stored `"openai"` etc strings remain valid. `migration-v2.ts` not modified. `schema_version` stays at 2.

### C6: `providerName` resolved once at instance-load time

`resolveInstanceToModelConfig` fills `ModelConfig.providerName` from `meta.name`. Error paths in `openai-compat-core.ts` use sync `displayProviderName(config)` helper that reads `config.providerName ?? config.provider` — no async storage access during streaming.

### C7: Custom provider models NOT written to `fetchedModels`

`StoredInstance.fetchedModels` is OpenRouter-specific lazy-fetch cache. Custom instance model sources are `customProvider.models` (provider-level). The `fetchedModels` field is not written during custom instance create/edit.

## File Map

| Concern | File |
|---------|------|
| Storage entity + CRUD | `src/lib/custom-providers.ts` |
| ProviderRef type + async streamChat | `src/lib/model-router/index.ts` |
| resolveProviderMeta / resolveModelMeta | `src/lib/model-router/providers/registry.ts` |
| dispatchStreamChat | `src/lib/model-router/providers/index.ts` |
| displayProviderName | `src/lib/model-router/providers/_shared/openai-compat-core.ts` |
| Async resolveInstanceToModelConfig | `src/lib/instances.ts` |
| Universal fetch helper | `src/lib/openai-compat-models-fetch.ts` |
| OpenRouter thin shell | `src/lib/openrouter-models-fetch.ts` |
| Async applyTokenBudget | `src/lib/agent/window-token-budget.ts` |
| UI hook | `src/sidepanel/hooks/useProviderMeta.ts` |
| CustomProviderForm | `src/sidepanel/components/CustomProviderForm.tsx` |
| Settings section | `src/sidepanel/components/Settings.tsx` |
| Wizard integration | `src/sidepanel/components/NewConfigWizard.tsx` |
