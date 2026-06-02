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
import { listCustomProviders, type StoredCustomProvider, CUSTOM_PREFIX } from "@/lib/custom-providers";
import { useT, providerDisplayName } from "@/lib/i18n";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import CustomProviderForm from "./CustomProviderForm";

interface Props {
  onCreate: (provider: ProviderRef, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: ProviderRef, payload: InstanceFormPayload) => void;
}

export default function NewConfigWizard(props: Props) {
  const t = useT();
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<ProviderRef | null>(null);
  const [customProviders, setCustomProviders] = useState<StoredCustomProvider[]>([]);
  const [showCustomForm, setShowCustomForm] = useState(false);
  // Provider-level custom models pool — pre-populates the form's dropdown
  // so user sees previously-typed custom ids carry across instances.
  const [pool, setPool] = useState<string[]>([]);
  // Per-model meta (vision, maxContextTokens) for custom models in this wizard session.
  const [metas, setMetas] = useState<Record<string, StoredCustomModelMeta>>({});
  // Lazy-fetched OpenRouter model list, scoped to this wizard session.
  // Lives here (not in InstanceForm) so the model list persists even when
  // the user clicks ← provider and navigates back to step 2.
  const [fetchedModels, setFetchedModels] = useState<ModelMeta[] | undefined>(undefined);
  const [fetchedAt, setFetchedAt] = useState<number | undefined>(undefined);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    listCustomProviders().then(setCustomProviders).catch(() => setCustomProviders([]));
  }, []);

  useEffect(() => {
    if (!provider) return;
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

  if (showCustomForm) {
    return (
      <CustomProviderForm
        onSaved={(saved) => {
          setShowCustomForm(false);
          const ref: ProviderRef = `custom:${saved.id}`;
          setProvider(ref);
          setStep(2);
          listCustomProviders().then(setCustomProviders).catch(() => {});
        }}
        onBack={() => setShowCustomForm(false)}
      />
    );
  }

  if (step === 1 || !provider) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3.5">
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">{t("newConfigWizard.step1Title")}</div>
        </div>
        <div className="flex flex-col gap-1.5">
          {sortedProviders.map((p) => (
            <button
              key={p.id}
              onClick={() => { setProvider(p.id); setStep(2); }}
              className="flex items-center gap-2 rounded border border-line px-3 py-2 text-left hover:bg-field"
            >
              <div className="h-1.5 w-1.5 rounded-full bg-fg-3" />
              <span className="text-[13px] text-fg-1">{providerDisplayName(p, t)}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-3">{p.defaultBaseUrl.replace(/^https?:\/\//, "")}</span>
            </button>
          ))}
        </div>

        {customProviders.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="caps px-1 text-fg-3">{t("newConfigWizard.customProviders")}</span>
            {customProviders.map((cp) => (
              <button
                key={cp.id}
                onClick={() => { setProvider(`custom:${cp.id}`); setStep(2); }}
                className="flex items-center gap-2 rounded border border-line px-3 py-2 text-left hover:bg-field"
              >
                <div className="h-1.5 w-1.5 rounded-full bg-fg-3" />
                <span className="text-[13px] text-fg-1">{cp.name}</span>
                <span className="ml-auto font-mono text-[10px] text-fg-3">{cp.baseUrl.replace(/^https?:\/\//, "")}</span>
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => setShowCustomForm(true)}
          className="flex items-center gap-2 self-start rounded border border-dashed border-line bg-transparent px-3 py-2 text-[12px] text-accent hover:bg-field"
        >
          {t("newConfigWizard.newCustomProvider")}
        </button>

        <div className="flex pt-1">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
             {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  }

  // Resolve the display name synchronously from already-loaded state (registry
  // for builtins, customProviders for custom) so switching providers never
  // momentarily shows — or seeds the nickname with — the previously-selected
  // provider's name. (`provider` is non-null here, past the step-1 guard.)
  // pcmm callbacks are gated to builtin providers in InstanceForm, so this cast is safe.
  const builtinProvider = provider as BuiltinProvider;
  const builtinMeta = provider.startsWith(CUSTOM_PREFIX)
    ? undefined
    : getProviderMeta(provider as BuiltinProvider);
  const metaName = builtinMeta
    ? providerDisplayName(builtinMeta, t)
    : customProviders.find((c) => `${CUSTOM_PREFIX}${c.id}` === provider)?.name ?? provider;
  return (
    <div className="rounded-lg border border-line bg-canvas">
      <div className="border-b border-line px-3.5 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">{t("newConfigWizard.step2Title", { name: metaName })}</div>
      </div>
      <InstanceForm
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
          await addProviderCustomModel(provider, id);
          await setProviderCustomModelMeta(builtinProvider, id, meta);
          setPool(await getProviderCustomModels(provider));
          setMetas(await getProviderCustomModelMetas(builtinProvider));
        }}
        onUpdateCustomModelMeta={async (id, meta) => {
          await setProviderCustomModelMeta(builtinProvider, id, meta);
          setMetas(await getProviderCustomModelMetas(builtinProvider));
        }}
        onRemoveCustomModel={async (id) => {
          await removeProviderCustomModel(provider, id);
          await removeProviderCustomModelMeta(builtinProvider, id);
          setPool(await getProviderCustomModels(provider));
          setMetas(await getProviderCustomModelMetas(builtinProvider));
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
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              {t("newConfigWizard.changeProvider")}
            </button>
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
    </div>
  );
}
