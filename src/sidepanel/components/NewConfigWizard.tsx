import { useState, useEffect } from "react";
import type { ProviderRef, BuiltinProvider, ModelMeta } from "@/lib/model-router";
import { PROVIDER_REGISTRY, getProviderMeta, resolveProviderMeta } from "@/lib/model-router/providers/registry";
import {
  getProviderCustomModels,
  addProviderCustomModel,
  removeProviderCustomModel,
} from "@/lib/provider-custom-models";
import { listCustomProviders, type StoredCustomProvider, CUSTOM_PREFIX } from "@/lib/custom-providers";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import CustomProviderForm from "./CustomProviderForm";

interface Props {
  onCreate: (provider: ProviderRef, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: ProviderRef, payload: InstanceFormPayload) => void;
}

export default function NewConfigWizard(props: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<ProviderRef | null>(null);
  const [customProviders, setCustomProviders] = useState<StoredCustomProvider[]>([]);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [step2Meta, setStep2Meta] = useState<{ name: string; defaultBaseUrl: string } | null>(null);
  // Provider-level custom models pool — pre-populates the form's dropdown
  // so user sees previously-typed custom ids carry across instances.
  const [pool, setPool] = useState<string[]>([]);
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
    // Reset fetched cache when provider changes — different provider, different model list.
    setFetchedModels(undefined);
    setFetchedAt(undefined);
    // Resolve meta for step 2 header
    resolveProviderMeta(provider).then((m) => {
      if (m) setStep2Meta({ name: m.name, defaultBaseUrl: m.defaultBaseUrl });
    });
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
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">STEP 1 — 选 PROVIDER</div>
        </div>
        <div className="flex flex-col gap-1.5">
          {PROVIDER_REGISTRY.map((p) => (
            <button
              key={p.id}
              onClick={() => { setProvider(p.id); setStep(2); }}
              className="flex items-center gap-2 rounded border border-line px-3 py-2 text-left hover:bg-field"
            >
              <div className="h-1.5 w-1.5 rounded-full bg-fg-3" />
              <span className="text-[13px] text-fg-1">{p.name}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-3">{p.defaultBaseUrl.replace(/^https?:\/\//, "")}</span>
            </button>
          ))}
        </div>

        {customProviders.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="caps px-1 text-fg-3">CUSTOM PROVIDERS</span>
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
          + New custom provider
        </button>

        <div className="flex pt-1">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  const metaName = step2Meta?.name ?? provider;
  return (
    <div className="rounded-lg border border-line bg-canvas">
      <div className="border-b border-line px-3.5 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">STEP 2 — {metaName}</div>
      </div>
      <InstanceForm
        mode="create"
        provider={provider}
        initialNickname={metaName}
        initialCustomModels={pool}
        fetchedModels={fetchedModels}
        fetchedAt={fetchedAt}
        isFetching={isFetching}
        saveLabel="Create"
        onSave={(p) => props.onCreate(provider, p)}
        onTest={(p) => props.onTest(provider, p)}
        onAddCustomModel={async (id) => {
          const next = await addProviderCustomModel(provider, id);
          setPool(next);
        }}
        onRemoveCustomModel={async (id) => {
          const next = await removeProviderCustomModel(provider, id);
          setPool(next);
        }}
        onRefreshModels={async (apiKey) => {
          // Only OpenRouter has /v1/models lazy fetch; other providers stay hardcoded.
          // /v1/models is public, so apiKey is optional (passed for parity with edit flow).
          if (provider !== "openrouter") return;
          setIsFetching(true);
          try {
            const fetched = await fetchOpenRouterModels(step2Meta?.defaultBaseUrl ?? getProviderMeta("openrouter")!.defaultBaseUrl, apiKey || undefined);
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
              ← 改 provider
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={props.onCancel}
              className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
            >
              取消
            </button>
            <button
              type="button"
              onClick={triggerTest}
              disabled={!canSave}
              className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
            >
              Test
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
