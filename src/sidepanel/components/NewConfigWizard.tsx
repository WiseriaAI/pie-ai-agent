import { useState, useEffect } from "react";
import type { Provider, ModelMeta } from "@/lib/model-router";
import { PROVIDER_REGISTRY, getProviderMeta } from "@/lib/model-router/providers/registry";
import {
  getProviderCustomModels,
  addProviderCustomModel,
  removeProviderCustomModel,
} from "@/lib/provider-custom-models";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";

interface Props {
  onCreate: (provider: Provider, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: Provider, payload: InstanceFormPayload) => void;
}

export default function NewConfigWizard(props: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<Provider | null>(null);
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
    if (!provider) return;
    getProviderCustomModels(provider).then(setPool).catch(() => setPool([]));
    // Reset fetched cache when provider changes — different provider, different model list.
    setFetchedModels(undefined);
    setFetchedAt(undefined);
  }, [provider]);

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

  const meta = getProviderMeta(provider)!;
  return (
    <div className="rounded-lg border border-line bg-canvas">
      <div className="border-b border-line px-3.5 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">STEP 2 — {meta.name}</div>
      </div>
      <InstanceForm
        mode="create"
        provider={provider}
        initialNickname={meta.name}
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
          if (provider !== "openrouter" || !apiKey.trim()) return;
          setIsFetching(true);
          try {
            const fetched = await fetchOpenRouterModels(meta.defaultBaseUrl, apiKey);
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
