import { useState } from "react";
import type { Provider } from "@/lib/model-router";
import { PROVIDER_REGISTRY, getProviderMeta } from "@/lib/model-router/providers/registry";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";

interface Props {
  onCreate: (provider: Provider, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: Provider, payload: InstanceFormPayload) => void;
}

export default function NewConfigWizard(props: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<Provider | null>(null);

  if (step === 1 || !provider) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">STEP 1 — 选 PROVIDER</div>
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
        <button onClick={props.onCancel} className="self-start text-[11px] text-fg-3 hover:text-fg-1">
          取消
        </button>
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
        saveLabel="Create"
        onSave={(p) => props.onCreate(provider, p)}
        onTest={(p) => props.onTest(provider, p)}
      />
      <div className="border-t border-line px-3.5 py-2">
        <button onClick={() => setStep(1)} className="text-[11px] text-fg-3 hover:text-fg-1">
          ← 改 provider
        </button>
        <button onClick={props.onCancel} className="ml-3 text-[11px] text-fg-3 hover:text-fg-1">
          取消
        </button>
      </div>
    </div>
  );
}
