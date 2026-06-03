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
  providerRefToId,
  type StoredCustomProvider,
  CUSTOM_PREFIX,
} from "@/lib/custom-providers";
import { useT, providerDisplayName } from "@/lib/i18n";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import ProviderDropdown from "./ProviderDropdown";

interface Props {
  onCreate: (provider: ProviderRef, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: ProviderRef, payload: InstanceFormPayload) => void;
}

/** Sentinel ref for a not-yet-saved custom provider being authored in the form. */
const DRAFT_CUSTOM_REF = "custom:__draft__";

export default function NewConfigWizard(props: Props) {
  const t = useT();
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
  // Silence unused-var lint until Task 5 wires CustomProviderFields; these are
  // intentionally-declared scaffolding read by the next task.
  void draftModels;
  void draftMetas;
  void testing;
  void customFetched;

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
      ),
    [t],
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

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3.5">
      <ProviderDropdown
        value={provider}
        builtinProviders={sortedProviders}
        customProviders={customProviders}
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
        }}
        onDeleteCustom={(_cp) => {
          // Task 5 implements dependency-checked delete + atomic remove.
        }}
      />

      {/* Task 5 renders <CustomProviderFields .../> here when authoring a custom provider. */}
      {customMode !== "none" && null}

      {provider && (
        <InstanceForm
          hideProviderField
          mode="create"
          provider={provider}
          initialNickname={metaName}
          initialCustomModels={pool}
          customModelMetas={metas}
          fetchedModels={fetchedModels}
          fetchedAt={fetchedAt}
          isFetching={isFetching}
          saveLabel={t("newConfigWizard.create")}
          onSave={(p) => props.onCreate(provider, p)}
          onTest={(p) => props.onTest(provider, p)}
          onAddCustomModel={async (id, meta) => {
            if (cpId) {
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
            if (cpId) {
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
            if (cpId) {
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
          renderActions={({ canSave, triggerSave, triggerTest, saveLabel }) => (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3.5 py-3">
              <div className="flex-1" />
              <button
                type="button"
                onClick={props.onCancel}
                className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={triggerTest}
                disabled={!canSave}
                className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
              >
                {t("common.test")}
              </button>
              <button
                type="button"
                onClick={triggerSave}
                disabled={!canSave}
                className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
              >
                {saveLabel}
              </button>
            </div>
          )}
        />
      )}

      {!provider && (
        <div className="flex flex-col gap-3">
          <div className="px-1 text-[12px] text-fg-3">{t("newConfigWizard.pickProviderHint")}</div>
          <div className="flex">
            <button
              type="button"
              onClick={props.onCancel}
              className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
