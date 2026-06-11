import { useState, useEffect, useMemo } from "react";
import type { ProviderRef, BuiltinProvider, ModelMeta } from "@/lib/model-router";
import { PROVIDER_REGISTRY, getProviderMeta } from "@/lib/model-router/providers/registry";
import {
  getProviderCustomModels,
  addProviderCustomModel,
  removeProviderCustomModel,
} from "@/lib/provider-custom-models";
import {
  getProviderCustomModelMetas,
  setProviderCustomModelMeta,
  removeProviderCustomModelMeta,
  type StoredCustomModelMeta,
} from "@/lib/provider-custom-model-meta";
import {
  listCustomProviders,
  addCustomProviderModel,
  updateCustomProviderModel,
  removeCustomProviderModel,
  saveCustomProvider,
  updateCustomProvider,
  deleteCustomProvider,
  getInstancesUsingCustomProvider,
  providerRefToId,
  type StoredCustomProvider,
  CUSTOM_PREFIX,
} from "@/lib/custom-providers";
import { DEFAULT_CUSTOM_MODEL_MAX_CONTEXT } from "@/lib/provider-custom-model-meta";
import { useT, providerDisplayName } from "@/lib/i18n";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import { fetchOpenAICompatModels } from "@/lib/openai-compat-models-fetch";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import ProviderDropdown from "./ProviderDropdown";
import CustomProviderFields from "./CustomProviderFields";
import ManagedSubscribePanel from "./ManagedSubscribePanel";

interface Props {
  onCreate: (provider: ProviderRef, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: ProviderRef, payload: InstanceFormPayload, options?: ProviderTestOptions) => void;
  existingProviderRefs?: ProviderRef[];
  testing?: boolean;
  testResult?: { ok: boolean; message: string } | null;
  /** Test-only injection for the managed subscribe flow. */
  __managedDeps?: import("./ManagedSubscribePanel").ManagedSubscribeDeps;
}

export interface ProviderTestOptions {
  baseUrl?: string;
  providerName?: string;
  candidateModels?: ModelMeta[];
}

/** Sentinel ref for a not-yet-saved custom provider being authored in the form. */
const DRAFT_CUSTOM_REF = "custom:__draft__";

export default function NewConfigWizard(props: Props) {
  const t = useT();
  const [entryMode, setEntryMode] = useState<"byok" | "managed">("byok");
  const [provider, setProvider] = useState<ProviderRef | null>(null);
  const [customProviders, setCustomProviders] = useState<StoredCustomProvider[]>([]);
  // Provider-level custom models pool — pre-populates the form's dropdown
  // so user sees previously-typed custom ids carry across instances.
  const [pool, setPool] = useState<string[]>([]);
  // Per-model meta (vision, maxContextTokens) for custom models in this wizard session.
  const [metas, setMetas] = useState<Record<string, StoredCustomModelMeta>>({});
  // Lazy-fetched OpenRouter model list, scoped to this wizard session.
  // Lives here (not in InstanceForm) so the model list persists across
  // dropdown re-selects.
  const [fetchedModels, setFetchedModels] = useState<ModelMeta[] | undefined>(undefined);
  const [fetchedAt, setFetchedAt] = useState<number | undefined>(undefined);
  const [isFetching, setIsFetching] = useState(false);

  // --- Custom-provider authoring scaffold (logic lands in Task 5) ---
  const [customMode, setCustomMode] = useState<"none" | "new" | "edit">("none");
  const [draftName, setDraftName] = useState("");
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftModels, setDraftModels] = useState<string[]>([]);
  const [draftMetas, setDraftMetas] = useState<Record<string, StoredCustomModelMeta>>({});
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [customFetched, setCustomFetched] = useState<ModelMeta[]>([]);
  // Edit mode: how many instances reference the provider being edited.
  // Drives the "shared by N" notice + delete-disabled gating.
  const [dependentCount, setDependentCount] = useState(0);

  useEffect(() => {
    listCustomProviders().then(setCustomProviders).catch(() => setCustomProviders([]));
  }, []);

  useEffect(() => {
    if (!provider) return;
    // The draft custom ref has no persisted models/metas yet.
    if (provider === DRAFT_CUSTOM_REF) {
      setPool([]);
      setMetas({});
      setFetchedModels(undefined);
      setFetchedAt(undefined);
      return;
    }
    getProviderCustomModels(provider).then(setPool).catch(() => setPool([]));
    // pcmm metas are builtin-scoped; custom providers have none — clear stale builtin metas.
    if (provider.startsWith(CUSTOM_PREFIX)) {
      setMetas({});
    } else {
      getProviderCustomModelMetas(provider as BuiltinProvider).then(setMetas).catch(() => setMetas({}));
    }
    // Reset fetched cache when provider changes — different provider, different model list.
    setFetchedModels(undefined);
    setFetchedAt(undefined);
    // OpenRouter /v1/models is public — pre-fetch immediately on provider select
    // so the dropdown is populated before the user even opens it.
    if (provider === "openrouter") {
      const meta = getProviderMeta("openrouter")!;
      setIsFetching(true);
      fetchOpenRouterModels(meta.defaultBaseUrl)
        .then((list) => {
          setFetchedModels(list);
          setFetchedAt(Date.now());
        })
        .catch(() => {
          // silent — user can retry via ↻ refresh
        })
        .finally(() => setIsFetching(false));
    }
  }, [provider]);

  // Builtin providers listed alphabetically by their (localized) display name.
  const sortedProviders = useMemo(
    () =>
      [...PROVIDER_REGISTRY].sort((a, b) =>
        providerDisplayName(a, t).localeCompare(providerDisplayName(b, t)),
      )
        .filter((p) => !(props.existingProviderRefs ?? []).includes(p.id))
        // 排除 managed —— 它只通过顶部「官方订阅」切换进入，不进 BYOK 下拉。
        .filter((p) => p.id !== "managed"),
    [props.existingProviderRefs, t],
  );

  const selectableCustomProviders = useMemo(
    () =>
      customProviders.filter(
        (cp) => !(props.existingProviderRefs ?? []).includes(`${CUSTOM_PREFIX}${cp.id}`),
      ),
    [customProviders, props.existingProviderRefs],
  );

  // Selecting a builtin (or existing custom) provider via the dropdown.
  const handleSelect = (ref: ProviderRef) => {
    setCustomMode("none");
    setProvider(ref);
  };

  // Resolve the display name synchronously from already-loaded state (registry
  // for builtins, customProviders for custom) so switching providers never
  // momentarily shows — or seeds the nickname with — the previously-selected
  // provider's name.
  const builtinProvider = provider as BuiltinProvider;
  // Non-null only for custom providers; routes model persistence to the entity.
  const cpId = provider && provider !== DRAFT_CUSTOM_REF ? providerRefToId(provider) : null;
  // True while authoring a not-yet-saved custom provider: model edits stay local.
  const isDraft = provider === DRAFT_CUSTOM_REF;
  const builtinMeta =
    provider && !provider.startsWith(CUSTOM_PREFIX)
      ? getProviderMeta(provider as BuiltinProvider)
      : undefined;
  const metaName =
    provider === DRAFT_CUSTOM_REF
      ? draftName || t("newConfigWizard.newCustomProvider")
      : builtinMeta
        ? providerDisplayName(builtinMeta, t)
        : customProviders.find((c) => `${CUSTOM_PREFIX}${c.id}` === provider)?.name ?? provider ?? "";

  // Test connection → fetch /v1/models for the draft/edited custom provider.
  async function handleCustomTest() {
    const url = draftBaseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) return;
    setTesting(true);
    setTestError(null);
    try {
      const list = await fetchOpenAICompatModels(url);
      setCustomFetched(
        list.map((m) => ({
          id: m.id,
          vision: m.vision,
          tools: m.tools,
          maxContextTokens: m.maxContextTokens,
          displayName: m.displayName,
        })),
      );
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  }

  // Atomic create / persist-on-save. For new custom: materialise the draft
  // provider entity first, then call onCreate with its real ref. For edit:
  // persist name/baseUrl edits before onCreate (model edits already persist
  // immediately via the InstanceForm callbacks).
  async function handleSubmit(payload: InstanceFormPayload) {
    if (customMode === "new") {
      const models = draftModels.map((id) => {
        const m = draftMetas[id];
        return {
          id,
          displayName: m?.displayName,
          vision: m?.vision ?? false,
          tools: true,
          maxContextTokens: m?.maxContextTokens ?? DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
        };
      });
      // Model selection moved to the Composer; custom-provider models come
      // solely from what the user added in the model list (draftModels).
      const newId = await saveCustomProvider({
        name: draftName.trim(),
        baseUrl: draftBaseUrl.trim(),
        models,
      });
      props.onCreate(`${CUSTOM_PREFIX}${newId}`, payload);
    } else if (customMode === "edit") {
      const id = providerRefToId(provider!);
      if (id) await updateCustomProvider(id, { name: draftName.trim(), baseUrl: draftBaseUrl.trim() });
      props.onCreate(provider!, payload);
    } else {
      props.onCreate(provider!, payload);
    }
  }

  // Dependency-checked delete. Blocks (alert) when instances reference the
  // provider; otherwise removes it, refreshes the list, and resets selection
  // when the deleted provider was the active one.
  async function handleDeleteCustom(cp: StoredCustomProvider) {
    const deps = await getInstancesUsingCustomProvider(cp.id);
    if (deps.length > 0) {
      window.alert(t("customProvider.inUseCannotDelete", { count: deps.length }));
      return;
    }
    await deleteCustomProvider(cp.id);
    setCustomProviders(await listCustomProviders());
    if (provider === `${CUSTOM_PREFIX}${cp.id}`) {
      setProvider(null);
      setCustomMode("none");
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-3.5">
      <div role="group" aria-label="Config type" className="flex w-full overflow-hidden rounded-[10px] border border-line">
        {([["byok", "Bring your own key"], ["managed", "Official subscription"]] as const).map(([m, label], i) => (
          <button key={m} type="button" aria-pressed={entryMode === m}
            onClick={() => setEntryMode(m)}
            className={`flex flex-1 items-center justify-center px-1.5 py-2 text-[12px] ${i > 0 ? "border-l border-line" : ""} ${
              entryMode === m ? "bg-accent-tint font-semibold text-accent" : "bg-transparent text-fg-3 hover:bg-field hover:text-fg-1"}`}>
            {label}
          </button>
        ))}
      </div>

      {entryMode === "managed" ? (
        <ManagedSubscribePanel
          deps={props.__managedDeps}
          onCreated={(apiKey, email) => props.onCreate("managed", { nickname: email, apiKey, customModels: [] })}
        />
      ) : (
        <>
      <ProviderDropdown
        value={provider}
        builtinProviders={sortedProviders}
        customProviders={selectableCustomProviders}
        onSelect={handleSelect}
        onCreateCustom={() => {
          setCustomMode("new");
          setProvider(DRAFT_CUSTOM_REF);
          setDraftName("");
          setDraftBaseUrl("");
          setDraftModels([]);
          setDraftMetas({});
          setCustomFetched([]);
          setTestError(null);
        }}
        onEditCustom={(cp) => {
          setCustomMode("edit");
          setProvider(`${CUSTOM_PREFIX}${cp.id}`);
          setDraftName(cp.name);
          setDraftBaseUrl(cp.baseUrl);
          // Reset new-draft model state so stale draft entries from a prior
          // "+ New custom provider" attempt never leak into the edited provider.
          setDraftModels([]);
          setDraftMetas({});
          setCustomFetched([]);
          setTestError(null);
          setDependentCount(0);
          getInstancesUsingCustomProvider(cp.id)
            .then((d) => setDependentCount(d.length))
            .catch(() => setDependentCount(0));
        }}
        onDeleteCustom={handleDeleteCustom}
      />

      {customMode === "new" && (
        <CustomProviderFields
          name={draftName}
          baseUrl={draftBaseUrl}
          onNameChange={setDraftName}
          onBaseUrlChange={setDraftBaseUrl}
          onTest={handleCustomTest}
          testing={testing}
          testError={testError}
          showTestButton={false}
        />
      )}
      {customMode === "edit" && (
        <CustomProviderFields
          name={draftName}
          baseUrl={draftBaseUrl}
          onNameChange={setDraftName}
          onBaseUrlChange={setDraftBaseUrl}
          onTest={handleCustomTest}
          testing={testing}
          testError={testError}
          showTestButton={false}
          dependentCount={dependentCount}
          onDelete={() => {
            const id = providerRefToId(provider!);
            const cp = customProviders.find((c) => c.id === id);
            if (cp) handleDeleteCustom(cp);
          }}
          deleteDisabled={dependentCount > 0}
        />
      )}

      {provider && (
        <InstanceForm
          key={provider}
          hideProviderField
          mode="create"
          provider={provider}
          initialNickname={metaName}
          initialCustomModels={isDraft ? draftModels : pool}
          customModelMetas={isDraft ? draftMetas : metas}
          fetchedModels={
            isDraft
              ? customFetched
              : customMode === "edit"
                ? customFetched.length > 0
                  ? customFetched
                  : undefined
                : fetchedModels
          }
          fetchedAt={fetchedAt}
          isFetching={isFetching}
          saveLabel={t("newConfigWizard.create")}
          testing={props.testing}
          testStatus={props.testResult?.ok === true ? "success" : "idle"}
          onSave={handleSubmit}
          onTest={(p) => {
            const editingCustom = customMode === "new" || customMode === "edit";
            const candidateModels = isDraft
              ? draftModels.map((id) => ({
                  id,
                  displayName: draftMetas[id]?.displayName,
                  vision: draftMetas[id]?.vision ?? false,
                  tools: true,
                  maxContextTokens: draftMetas[id]?.maxContextTokens ?? DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
                }))
              : customMode === "edit"
                ? (customFetched.length > 0
                    ? customFetched
                    : customProviders.find((c) => `${CUSTOM_PREFIX}${c.id}` === provider)?.models ?? [])
                : (fetchedModels ?? []);
            props.onTest(provider, p, {
              ...(editingCustom && { baseUrl: draftBaseUrl.trim(), providerName: draftName.trim() || undefined }),
              ...(candidateModels.length > 0 && { candidateModels }),
            });
          }}
          onAddCustomModel={async (id, meta) => {
            if (isDraft) {
              // Draft provider doesn't exist yet — accumulate locally; the
              // entity is materialised atomically in handleSubmit.
              setDraftModels((prev) => (prev.includes(id) ? prev : [...prev, id]));
              setDraftMetas((prev) => ({ ...prev, [id]: meta }));
            } else if (cpId) {
              await addCustomProviderModel(cpId, {
                id,
                displayName: meta.displayName,
                vision: meta.vision,
                tools: true,
                maxContextTokens: meta.maxContextTokens,
              });
              setCustomProviders(await listCustomProviders());
            } else {
              await addProviderCustomModel(provider, id);
              await setProviderCustomModelMeta(builtinProvider, id, meta);
              setPool(await getProviderCustomModels(provider));
              setMetas(await getProviderCustomModelMetas(builtinProvider));
            }
          }}
          onUpdateCustomModelMeta={async (id, meta) => {
            if (isDraft) {
              setDraftMetas((prev) => ({ ...prev, [id]: meta }));
            } else if (cpId) {
              await updateCustomProviderModel(cpId, id, {
                id,
                displayName: meta.displayName,
                vision: meta.vision,
                tools: true,
                maxContextTokens: meta.maxContextTokens,
              });
              setCustomProviders(await listCustomProviders());
            } else {
              await setProviderCustomModelMeta(builtinProvider, id, meta);
              setMetas(await getProviderCustomModelMetas(builtinProvider));
            }
          }}
          onRemoveCustomModel={async (id) => {
            if (isDraft) {
              setDraftModels((prev) => prev.filter((x) => x !== id));
              setDraftMetas((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
            } else if (cpId) {
              await removeCustomProviderModel(cpId, id);
              setCustomProviders(await listCustomProviders());
            } else {
              await removeProviderCustomModel(provider, id);
              await removeProviderCustomModelMeta(builtinProvider, id);
              setPool(await getProviderCustomModels(provider));
              setMetas(await getProviderCustomModelMetas(builtinProvider));
            }
          }}
          onRefreshModels={async (apiKey) => {
            // Only OpenRouter has /v1/models lazy fetch; other providers stay hardcoded.
            // /v1/models is public, so apiKey is optional (passed for parity with edit flow).
            if (provider !== "openrouter") return;
            setIsFetching(true);
            try {
              const fetched = await fetchOpenRouterModels(getProviderMeta("openrouter")!.defaultBaseUrl, apiKey || undefined);
              setFetchedModels(fetched);
              setFetchedAt(Date.now());
            } catch {
              // silent for v1; user can retry via ↻ refresh button
            } finally {
              setIsFetching(false);
            }
          }}
          renderActions={({ canSave, testing, testStatus, triggerSave, triggerTest, saveLabel }) => {
            // In "new" custom mode, also require valid draft name + baseUrl
            // before the create button is enabled (InstanceForm only gates
            // on key+model).
            const effectiveCanSave =
              canSave &&
              (customMode !== "new" ||
                (!!draftName.trim() && /^https?:\/\//.test(draftBaseUrl)));
            return (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3.5 py-3">
                {props.testResult?.ok === false && (
                  <div
                    className="min-w-full rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[11px] text-warning"
                  >
                    {t("customProvider.testFailed", { error: props.testResult.message })}
                  </div>
                )}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={props.onCancel}
                  className="h-8 rounded-[10px] border border-line bg-transparent px-3 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={triggerTest}
                  disabled={!effectiveCanSave || testing}
                  className="flex h-8 items-center gap-1.5 rounded-[10px] border border-line bg-transparent px-3 text-[12px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
                >
                  {testing && <Spinner />}
                  {testing
                    ? t("customProvider.testing")
                    : testStatus === "success"
                      ? t("instanceForm.testOk")
                      : t("common.test")}
                </button>
                <button
                  type="button"
                  onClick={triggerSave}
                  disabled={!effectiveCanSave}
                  className="h-8 rounded-[10px] bg-fg-1 px-4 text-[12px] font-medium text-canvas disabled:opacity-30"
                >
                  {saveLabel}
                </button>
              </div>
            );
          }}
        />
      )}

      {!provider && (
        <div className="flex flex-col gap-3">
          <div className="px-1 text-[12px] text-fg-3">{t("newConfigWizard.pickProviderHint")}</div>
          <div className="flex">
            <button
              type="button"
              onClick={props.onCancel}
              className="rounded-[10px] border border-line bg-transparent px-3 py-2 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      <path d="M14 8A6 6 0 1 1 2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
