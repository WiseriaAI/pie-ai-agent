import { useState, useEffect, useCallback } from "react";
import type { ProviderRef, BuiltinProvider } from "@/lib/model-router";
import { chat } from "@/lib/model-router";
import {
  createInstance, listInstances, deleteInstance,
  updateInstance, firstModelForProvider,
  type DecryptedInstance,
} from "@/lib/instances";
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
import { getProviderMeta, resolveProviderMeta } from "@/lib/model-router/providers/registry";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import { isCdpInputEnabled, setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import {
  addCustomProviderModel, updateCustomProviderModel, removeCustomProviderModel,
  CUSTOM_PREFIX, providerRefToId,
} from "@/lib/custom-providers";
import SkillsList from "./SkillsList";
import SearchProviderSection from "./SearchProviderSection";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import InstancesList from "./InstancesList";
import NewConfigWizard from "./NewConfigWizard";
import { useT, setLocale, getLocale, type LocaleSetting } from "@/lib/i18n";
import { buildGithubNewIssueUrl, buildFeedbackMailto, type FeedbackEnv } from "@/lib/feedback";

interface Props {
  onBack: () => void;
  onRunSkill?: (skillId: string, skillName: string) => void;
}

type Tab = "configs" | "skills" | "search";

export default function Settings({ onBack, onRunSkill }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("configs");
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [cdpInput, setCdpInput] = useState<boolean | undefined>(undefined);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  // Per-provider custom models pool — sticky across instances of the same provider.
  const [providerPools, setProviderPools] = useState<Record<string, string[]>>({});
  // Per-provider custom model meta (vision, maxContextTokens) keyed by provider then modelId.
  const [providerMetas, setProviderMetas] = useState<Record<string, Record<string, StoredCustomModelMeta>>>({});

  const reload = useCallback(async () => {
    const list = await listInstances();
    setInstances(list);
    // Refresh pool for every provider currently represented in the instance list.
    const providers = Array.from(new Set(list.map((i) => i.provider)));
    const pools = await Promise.all(providers.map((p) => getProviderCustomModels(p).then((v) => [p, v] as const)));
    setProviderPools(Object.fromEntries(pools));
    // pcmm metas are builtin-scoped; filter out custom: providers (the cast is then safe).
    const builtinProviders = providers.filter((p) => !p.startsWith(CUSTOM_PREFIX));
    const metas = await Promise.all(
      builtinProviders.map((p) => getProviderCustomModelMetas(p as BuiltinProvider).then((v) => [p, v] as const)),
    );
    setProviderMetas(Object.fromEntries(metas));
  }, []);

  useEffect(() => {
    reload();
    isCdpInputEnabled().then(setCdpInput);
  }, [reload]);

  async function handleCreate(provider: ProviderRef, payload: InstanceFormPayload) {
    await createInstance({ provider, ...payload });
    setShowWizard(false);
    await reload();
  }

  async function handleSaveEdit(id: string, payload: InstanceFormPayload) {
    const patch: { nickname: string; apiKey?: string } = {
      nickname: payload.nickname,
    };
    // Only re-encrypt the key if the user actually typed a new one.
    // An empty apiKey means "keep existing" — do NOT pass it to updateInstance.
    if (payload.apiKey.trim().length > 0) patch.apiKey = payload.apiKey;
    await updateInstance(id, patch);
    setExpandedId(null); // collapse after save
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm(t("settings.forgetConfirm"))) return;
    await deleteInstance(id);
    setExpandedId(null);
    await reload();
  }

  async function handleTest(id: string | null, provider: ProviderRef, payload: InstanceFormPayload) {
    const meta = await resolveProviderMeta(provider);
    if (!meta) {
      const key = id ?? "_new";
      setTestResult((p) => ({ ...p, [key]: { ok: false, message: `Unknown provider: ${provider}` } }));
      return;
    }
    // Model decoupled from instance: connection test uses the provider's first
    // available model (registry[0] / custom[0]).
    const model = (await firstModelForProvider(provider, id ?? undefined)) ?? "";
    const cfg = {
      provider,
      model,
      // If apiKey is empty (edit mode, user didn't retype), fall back to instance's stored key
      apiKey: payload.apiKey.trim() || (() => {
        if (!id) return payload.apiKey;
        const inst = instances.find((i) => i.id === id);
        return inst?.apiKey ?? payload.apiKey;
      })(),
      baseUrl: meta.defaultBaseUrl,
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
          aria-label={t("settings.backToAgent")}
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
        <span className="text-[13px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.title")}</span>
        <div className="flex-1" />
        <SegmentedTabs value={tab} onChange={setTab} />
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        {tab === "configs" ? (
          <div className="flex flex-col gap-7">
            <section className="flex flex-col gap-3.5">
              <div className="flex items-baseline justify-between">
                <span className="caps text-fg-3">{t("settings.myConfigs.title")}</span>
                <span className="font-mono text-[10px] text-fg-3">
                  {instances.length} {t("settings.myConfigs.countSuffix")}
                </span>
              </div>

              <InstancesList
                instances={instances}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
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
                  // Custom-provider models live on the provider entity; builtin
                  // custom models live in the pcm pool + pcmm sidecar. The model
                  // callbacks below route by provider type. `bp`/`cpId` are only
                  // dereferenced on their matching branch, so the casts are safe.
                  const isCustom = inst.provider.startsWith(CUSTOM_PREFIX);
                  const bp = inst.provider as BuiltinProvider;
                  const cpId = providerRefToId(inst.provider);
                  return (
                    <>
                      <InstanceForm
                        mode="edit"
                        provider={inst.provider}
                        initialNickname={inst.nickname}
                        initialCustomModels={mergedCustomModels}
                        customModelMetas={providerMetas[inst.provider] ?? {}}
                        fetchedModels={inst.fetchedModels}
                        fetchedAt={inst.fetchedAt}
                        maskedKey={maskKey(inst.apiKey)}
                        existingApiKey={inst.apiKey}
                        onSave={(p) => handleSaveEdit(id, p)}
                        onTest={(p) => handleTest(id, inst.provider, p)}
                        onDelete={() => handleDelete(id)}
                        onAddCustomModel={async (mid, meta) => {
                          if (isCustom && cpId) {
                            // Custom provider: the new model becomes part of the
                            // provider's own model list (tools always true).
                            await addCustomProviderModel(cpId, {
                              id: mid,
                              displayName: meta.displayName,
                              vision: meta.vision,
                              tools: true,
                              maxContextTokens: meta.maxContextTokens,
                            });
                          } else {
                            // Builtin: persist to BOTH the instance (back-compat) AND the provider pool.
                            const nextInst = [...(inst.customModels ?? []), mid];
                            await updateInstance(id, { customModels: nextInst });
                            await addProviderCustomModel(inst.provider, mid);
                            await setProviderCustomModelMeta(bp, mid, meta);
                          }
                          await reload();
                        }}
                        onUpdateCustomModelMeta={async (mid, meta) => {
                          if (isCustom && cpId) {
                            await updateCustomProviderModel(cpId, mid, {
                              id: mid,
                              displayName: meta.displayName,
                              vision: meta.vision,
                              tools: true,
                              maxContextTokens: meta.maxContextTokens,
                            });
                          } else {
                            await setProviderCustomModelMeta(bp, mid, meta);
                          }
                          await reload();
                        }}
                        onRemoveCustomModel={async (mid) => {
                          if (isCustom && cpId) {
                            await removeCustomProviderModel(cpId, mid);
                          } else {
                            // Remove from BOTH layers so the model truly disappears.
                            const nextInst = (inst.customModels ?? []).filter((x) => x !== mid);
                            await updateInstance(id, { customModels: nextInst });
                            await removeProviderCustomModel(inst.provider, mid);
                            await removeProviderCustomModelMeta(bp, mid); // cascade-clear pcmm
                          }
                          await reload();
                        }}
                        onRefreshModels={async (apiKey) => {
                          // /v1/models is public — apiKey is optional (forwarded for parity).
                          if (inst.provider !== "openrouter") return;
                          const meta = getProviderMeta("openrouter")!;
                          try {
                            const fetched = await fetchOpenRouterModels(meta.defaultBaseUrl, apiKey || undefined);
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
                  {t("settings.myConfigs.newConfigButton")}
                </button>
              )}
            </section>

            <CdpInputSection
              state={cdpInput}
              onSet={async (next) => { setCdpInput(next); await setCdpInputEnabled(next); }}
            />

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

            <FeedbackSection activeInstance={instances[0]} />
          </div>
        ) : tab === "skills" ? (
          <SkillsList onRunSkill={onRunSkill ?? (() => {})} />
        ) : (
          <SearchProviderSection />
        )}
      </div>
    </div>
  );
}

function SegmentedTabs({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
}) {
  const t = useT();
  const tabs: { id: Tab; label: string }[] = [
    { id: "configs", label: t("settings.tabs.configs") },
    { id: "skills", label: t("settings.tabs.skills") },
    { id: "search", label: t("settings.tabs.search") },
  ];
  return (
    <div className="flex">
      {tabs.map((tab, i) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`border border-line px-3 py-1 text-[11px] ${
              i === 0
                ? "rounded-l-md"
                : i === tabs.length - 1
                ? "-ml-px rounded-r-md"
                : "-ml-px"
            } ${
              active
                ? "bg-field font-medium text-fg-1"
                : "bg-transparent text-fg-2 hover:text-fg-1"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function FeedbackSection({ activeInstance }: { activeInstance: DecryptedInstance | undefined }) {
  const t = useT();
  const env: FeedbackEnv = {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    providerModel: activeInstance ? activeInstance.provider : "(no config)",
    locale: getLocale(),
  };
  return (
    <section className="flex flex-col gap-3.5">
      <div className="caps text-fg-3">{t("settings.feedback.sectionTitle")}</div>
      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3.5">
        <p className="text-[11px] leading-[16px] text-fg-3">{t("settings.feedback.githubHint")}</p>
        <div className="flex gap-2">
          {/* Native anchors: target=_blank opens a tab for GitHub; mailto is
              intercepted by the browser and won't navigate the side panel. */}
          <a
            href={buildGithubNewIssueUrl(env)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded border border-line bg-transparent px-3.5 py-2 text-[12px] text-accent hover:bg-field"
          >
            {t("settings.feedback.githubButton")}
          </a>
          <a
            href={buildFeedbackMailto(env)}
            className="flex items-center gap-2 rounded border border-line bg-transparent px-3.5 py-2 text-[12px] text-fg-2 hover:bg-field"
          >
            {t("settings.feedback.emailButton")}
          </a>
        </div>
      </div>
    </section>
  );
}

function CdpInputSection({
  state,
  onSet,
}: {
  state: boolean | undefined;
  onSet: (next: boolean) => void;
}) {
  const t = useT();
  const enabled = state === true;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">{t("settings.experimental")}</span>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <div className="text-[13px] font-medium text-fg-1">{t("settings.cdpInput.title")}</div>
            <p className="text-[12px] leading-[18px] text-fg-2">
              {t("settings.cdpInput.description")}
            </p>
            <p className="text-[11px] text-fg-3 mt-0.5">
              {state === undefined
                ? t("settings.cdpInput.statusNotAsked")
                : enabled
                ? t("settings.cdpInput.statusEnabled")
                : t("settings.cdpInput.statusDisabled")}
            </p>
          </div>
          <Switch checked={enabled} onChange={onSet} />
        </div>
        {enabled && (
          <div className="flex flex-col gap-1.5 rounded border border-warning-line bg-warning-tint px-3 py-2 text-[11px] leading-[16px] text-warning">
            <span className="font-medium">{t("settings.cdpInput.warningTitle")}</span>
            <ul className="flex flex-col gap-1 pl-3 text-warning/90">
              <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning1")}</li>
              <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning2")}</li>
              <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning3")}</li>
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
