import { useState, useEffect, useCallback } from "react";
import type { Provider } from "@/lib/model-router";
import { chat } from "@/lib/model-router";
import {
  createInstance, listInstances, deleteInstance,
  setActiveInstance, getActiveInstance, updateInstance,
  type DecryptedInstance,
} from "@/lib/instances";
import {
  getProviderCustomModels,
  addProviderCustomModel,
  removeProviderCustomModel,
} from "@/lib/provider-custom-models";
import { getProviderMeta } from "@/lib/model-router/providers/registry";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import { isKeyboardSimulationEnabled, setKeyboardSimulationEnabled } from "@/lib/keyboard-simulation";
import SkillsList from "./SkillsList";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import InstancesList from "./InstancesList";
import NewConfigWizard from "./NewConfigWizard";

interface Props {
  onBack: () => void;
  onRunSkill?: (skillId: string, skillName: string) => void;
}

type Tab = "configs" | "skills";

export default function Settings({ onBack, onRunSkill }: Props) {
  const [tab, setTab] = useState<Tab>("configs");
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [keyboardSim, setKeyboardSim] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  // Per-provider custom models pool — sticky across instances of the same provider.
  const [providerPools, setProviderPools] = useState<Record<string, string[]>>({});

  const reload = useCallback(async () => {
    const list = await listInstances();
    setInstances(list);
    setActiveId(await getActiveInstance());
    // Refresh pool for every provider currently represented in the instance list.
    const providers = Array.from(new Set(list.map((i) => i.provider)));
    const pools = await Promise.all(providers.map((p) => getProviderCustomModels(p).then((v) => [p, v] as const)));
    setProviderPools(Object.fromEntries(pools));
  }, []);

  useEffect(() => {
    reload();
    isKeyboardSimulationEnabled().then(setKeyboardSim);
  }, [reload]);

  async function handleCreate(provider: Provider, payload: InstanceFormPayload) {
    await createInstance({ provider, ...payload });
    setShowWizard(false);
    await reload();
  }

  async function handleSaveEdit(id: string, payload: InstanceFormPayload) {
    const patch: { nickname: string; model: string; apiKey?: string } = {
      nickname: payload.nickname,
      model: payload.model,
    };
    // Only re-encrypt the key if the user actually typed a new one.
    // An empty apiKey means "keep existing" — do NOT pass it to updateInstance.
    if (payload.apiKey.trim().length > 0) patch.apiKey = payload.apiKey;
    await updateInstance(id, patch);
    setExpandedId(null); // collapse after save
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm("Forget this config?")) return;
    await deleteInstance(id);
    setExpandedId(null);
    await reload();
  }

  async function handleTest(id: string | null, provider: Provider, payload: InstanceFormPayload) {
    const meta = getProviderMeta(provider);
    const cfg = {
      provider,
      model: payload.model,
      // If apiKey is empty (edit mode, user didn't retype), fall back to instance's stored key
      apiKey: payload.apiKey.trim() || (() => {
        if (!id) return payload.apiKey;
        const inst = instances.find((i) => i.id === id);
        return inst?.apiKey ?? payload.apiKey;
      })(),
      baseUrl: meta!.defaultBaseUrl,
      maxTokens: 1,
    };
    const key = id ?? "_new";
    try {
      await chat(cfg, [{ role: "user", content: "Hi" }]);
      setTestResult((p) => ({ ...p, [key]: { ok: true, message: "Connection successful" } }));
    } catch (e) {
      setTestResult((p) => ({ ...p, [key]: { ok: false, message: e instanceof Error ? e.message : "Failed" } }));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-line bg-canvas px-3.5 py-3">
        <button
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded text-fg-2 hover:bg-field hover:text-fg-1"
          aria-label="Back to agent"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M9 11L5 7L9 3"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="text-[13px] font-semibold tracking-[-0.005em] text-fg-1">Settings</span>
        <div className="flex-1" />
        <SegmentedTabs value={tab} onChange={setTab} />
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        {tab === "configs" ? (
          <div className="flex flex-col gap-7">
            <ActiveSection instances={instances} activeId={activeId} />

            <section className="flex flex-col gap-3.5">
              <div className="flex items-baseline justify-between">
                <span className="caps text-fg-3">MY CONFIGS</span>
                <span className="font-mono text-[10px] text-fg-3">{instances.length} configs</span>
              </div>

              <InstancesList
                instances={instances}
                activeId={activeId}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
                onSetActive={async (id) => { await setActiveInstance(id); await reload(); }}
                renderForm={(id) => {
                  const inst = instances.find((i) => i.id === id)!;
                  const result = testResult[id];
                  // Merge per-instance customModels (back-compat) with the
                  // per-provider sticky pool so newly-typed ids show up across
                  // instances of the same provider.
                  const pool = providerPools[inst.provider] ?? [];
                  const mergedCustomModels = Array.from(
                    new Set([...(inst.customModels ?? []), ...pool]),
                  );
                  return (
                    <>
                      <InstanceForm
                        mode="edit"
                        provider={inst.provider}
                        initialNickname={inst.nickname}
                        initialModel={inst.model}
                        initialCustomModels={mergedCustomModels}
                        fetchedModels={inst.fetchedModels}
                        fetchedAt={inst.fetchedAt}
                        maskedKey={maskKey(inst.apiKey)}
                        existingApiKey={inst.apiKey}
                        onSave={(p) => handleSaveEdit(id, p)}
                        onTest={(p) => handleTest(id, inst.provider, p)}
                        onDelete={() => handleDelete(id)}
                        onAddCustomModel={async (mid) => {
                          // Persist to BOTH the instance (for back-compat) AND the provider pool.
                          const nextInst = [...(inst.customModels ?? []), mid];
                          await updateInstance(id, { customModels: nextInst });
                          await addProviderCustomModel(inst.provider, mid);
                          await reload();
                        }}
                        onRemoveCustomModel={async (mid) => {
                          // Remove from BOTH layers so the model truly disappears.
                          const nextInst = (inst.customModels ?? []).filter((x) => x !== mid);
                          await updateInstance(id, { customModels: nextInst });
                          await removeProviderCustomModel(inst.provider, mid);
                          await reload();
                        }}
                        onRefreshModels={async (apiKey) => {
                          if (inst.provider !== "openrouter") return;
                          if (!apiKey.trim()) return;
                          const meta = getProviderMeta("openrouter")!;
                          try {
                            const fetched = await fetchOpenRouterModels(meta.defaultBaseUrl, apiKey);
                            await updateInstance(id, { fetchedModels: fetched, fetchedAt: Date.now() });
                            await reload();
                          } catch {
                            // silent for v1; user can retry
                          }
                        }}
                      />
                      {result && (
                        <div
                          className={`mx-3.5 mb-3 rounded border px-2.5 py-1.5 text-[11px] ${
                            result.ok
                              ? "border-line bg-field text-fg-2"
                              : "border-warning-line bg-warning-tint text-warning"
                          }`}
                        >
                          {result.message}
                        </div>
                      )}
                    </>
                  );
                }}
              />

              {showWizard ? (
                <NewConfigWizard
                  onCreate={handleCreate}
                  onTest={(p, payload) => handleTest(null, p, payload)}
                  onCancel={() => setShowWizard(false)}
                />
              ) : (
                <button
                  onClick={() => setShowWizard(true)}
                  className="flex items-center gap-2 self-start rounded border border-line bg-transparent px-3.5 py-2 text-[12px] text-accent hover:bg-field"
                >
                  + 新建配置
                </button>
              )}
            </section>

            <KeyboardSimSection
              enabled={keyboardSim}
              onToggle={async (n) => { setKeyboardSim(n); await setKeyboardSimulationEnabled(n); }}
            />
          </div>
        ) : (
          <SkillsList onRunSkill={onRunSkill ?? (() => {})} />
        )}
      </div>
    </div>
  );
}

function ActiveSection({
  instances,
  activeId,
}: {
  instances: DecryptedInstance[];
  activeId: string | null;
}) {
  const active = instances.find((i) => i.id === activeId);
  if (!active) {
    return (
      <section className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] text-warning">
        No active config — pick one below.
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <div className="caps text-fg-3">ACTIVE</div>
      <div className="flex items-baseline justify-between">
        <div className="text-[14px] font-semibold text-fg-1">{active.nickname}</div>
        <div className="font-mono text-[11px] text-accent">{active.model}</div>
      </div>
    </section>
  );
}

function SegmentedTabs({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "configs", label: "Configs" },
    { id: "skills", label: "Skills" },
  ];
  return (
    <div className="flex">
      {tabs.map((t, i) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`border border-line px-3 py-1 text-[11px] ${
              i === 0 ? "rounded-l-md" : "-ml-px rounded-r-md"
            } ${
              active
                ? "bg-field font-medium text-fg-1"
                : "bg-transparent text-fg-2 hover:text-fg-1"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function KeyboardSimSection({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">EXPERIMENTAL</span>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <div className="text-[13px] font-medium text-fg-1">CDP keyboard input</div>
            <p className="text-[12px] leading-[18px] text-fg-2">
              Lets the agent type into canvas-rendered editors (Feishu Docs, Google Docs, Notion) via Chrome DevTools Protocol. Required only for those — regular sites work without this.
            </p>
          </div>
          <Switch checked={enabled} onChange={onToggle} />
        </div>
        {enabled && (
          <div className="flex flex-col gap-1.5 rounded border border-warning-line bg-warning-tint px-3 py-2 text-[11px] leading-[16px] text-warning">
            <span className="font-medium">Heads up — debugger access is active</span>
            <ul className="flex flex-col gap-1 pl-3 text-warning/90">
              <li className="list-['—__'] pl-0">
                Chrome shows a yellow debug bar on the target tab while the agent uses keyboard tools. Each call requires your approval.
              </li>
              <li className="list-['—__'] pl-0">
                If the window is minimized or the tab is off-screen, the bar may not be visible — the extension is still controlling it.
              </li>
              <li className="list-['—__'] pl-0">
                Click the yellow bar's "Cancel" anytime to revoke access.
              </li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-accent-line bg-accent-tint" : "border-line bg-field"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
          checked ? "translate-x-6 bg-accent" : "translate-x-1 bg-fg-3"
        }`}
      />
    </button>
  );
}

function maskKey(k: string): string {
  return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
