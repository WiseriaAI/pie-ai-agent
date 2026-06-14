import { useState, useEffect, useCallback, useRef } from "react";
import type { ProviderRef, BuiltinProvider, ModelMeta } from "@/lib/model-router";
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
import { getProviderMeta, resolveProviderMeta, resolveEndpointVariant } from "@/lib/model-router/providers/registry";
import { fetchOpenRouterModels } from "@/lib/openrouter-models-fetch";
import { isCdpInputEnabled, setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import {
  addCustomProviderModel, updateCustomProviderModel, removeCustomProviderModel,
  CUSTOM_PREFIX, providerRefToId, listCustomProviders,
} from "@/lib/custom-providers";
import { IconButton } from "./ui/IconButton";
import SkillsList from "./SkillsList";
import SearchProviderSection from "./SearchProviderSection";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import InstancesList from "./InstancesList";
import NewConfigWizard from "./NewConfigWizard";
import type { ProviderTestOptions } from "./NewConfigWizard";
import { Collapse } from "./ui/Collapse";
import AssistantLanguageSelect from "./AssistantLanguageSelect";
import LanguageSelect from "./LanguageSelect";
import { useT, getLocale } from "@/lib/i18n";
import { buildGithubNewIssueUrl, buildFeedbackMailto, type FeedbackEnv } from "@/lib/feedback";
import { testProviderConnection } from "@/lib/provider-test";

interface Props {
  onBack: () => void;
  onRunSkill?: (skillId: string, skillName: string) => void;
}

type Tab = "configs" | "skills" | "search" | "general";

export default function Settings({ onBack, onRunSkill }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("configs");
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [cdpInput, setCdpInput] = useState<boolean | undefined>(undefined);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testingIds, setTestingIds] = useState<Record<string, boolean>>({});
  const testingIdsRef = useRef<Set<string>>(new Set());
  // Per-provider custom models pool — sticky across instances of the same provider.
  const [providerPools, setProviderPools] = useState<Record<string, string[]>>({});
  // Per-provider custom model meta (vision, maxContextTokens) keyed by provider then modelId.
  const [providerMetas, setProviderMetas] = useState<Record<string, Record<string, StoredCustomModelMeta>>>({});
  const [customProviderNames, setCustomProviderNames] = useState<Record<string, string>>({});

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
    const customProviders = await listCustomProviders();
    setCustomProviderNames(
      Object.fromEntries(customProviders.map((cp) => [`${CUSTOM_PREFIX}${cp.id}`, cp.name])),
    );
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
    const patch: { apiKey?: string; endpointVariant: string | null } = {
      // undefined = 用户选了默认端点 → null 显式清除存储字段
      endpointVariant: payload.endpointVariant ?? null,
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

  async function handleTest(
    id: string | null,
    provider: ProviderRef,
    payload: InstanceFormPayload,
    options: ProviderTestOptions = {},
  ) {
    const key = id ?? "_new";
    if (testingIdsRef.current.has(key)) return;
    testingIdsRef.current.add(key);
    setTestingIds((p) => ({ ...p, [key]: true }));
    setTestResult((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });

    const meta = await resolveProviderMeta(provider) ?? draftProviderMeta(provider, options);
    if (!meta) {
      setTestResult((p) => ({ ...p, [key]: { ok: false, message: `Unknown provider: ${provider}` } }));
      testingIdsRef.current.delete(key);
      setTestingIds((p) => ({ ...p, [key]: false }));
      return;
    }
    // 端点与模型池跟随表单里未保存的 variant 选择（而非存量 instance 字段）；
    // 兜底也传 variantOverride（null=强制默认池），避免读到存量 variant 的模型与 baseUrl 不同源
    const variant = resolveEndpointVariant(meta, payload.endpointVariant);
    const inst = id ? instances.find((i) => i.id === id) : undefined;
    const model = payload.customModels[0]
      ?? variant?.models?.[0]?.id
      ?? meta.models[0]?.id
      ?? options.candidateModels?.[0]?.id
      ?? inst?.fetchedModels?.[0]?.id
      ?? (await firstModelForProvider(provider, id ?? undefined, payload.endpointVariant ?? null))
      ?? "";
    const cfg = {
      provider,
      model,
      // If apiKey is empty (edit mode, user didn't retype), fall back to instance's stored key
      apiKey: payload.apiKey.trim() || (() => {
        if (!id) return payload.apiKey;
        return inst?.apiKey ?? payload.apiKey;
      })(),
      baseUrl: ((options.baseUrl?.trim() || variant?.baseUrl) ?? meta.defaultBaseUrl).replace(/\/+$/, ""),
      providerName: options.providerName ?? meta.name,
    };
    try {
      if (!cfg.apiKey.trim()) throw new Error("API key cannot be empty");
      if (!cfg.model.trim()) throw new Error("No model available for test");
      await testProviderConnection(cfg);
      setTestResult((p) => ({ ...p, [key]: { ok: true, message: "" } }));
    } catch (e) {
      setTestResult((p) => ({ ...p, [key]: { ok: false, message: e instanceof Error ? e.message : "Failed" } }));
    } finally {
      testingIdsRef.current.delete(key);
      setTestingIds((p) => ({ ...p, [key]: false }));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-shrink-0 items-center gap-2.5 border-b border-line bg-canvas px-3.5 py-3">
        <IconButton
          onClick={onBack}
          size="sm"
          variant="ghost"
          aria-label={t("settings.backToAgent")}
          icon={
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M9 11L5 7L9 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
        <span className="text-[17px] font-semibold tracking-[-0.01em] text-fg-1">{t("settings.title")}</span>
      </header>
      <div className="flex-shrink-0 border-b border-line bg-canvas px-3.5 pb-3.5 pt-3">
        <SegmentedTabs value={tab} onChange={setTab} />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div key={tab} className="view-enter">
        {tab === "configs" ? (
          <div className="flex flex-col gap-7">
            <section className="flex flex-col gap-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">{t("settings.myConfigs.title")}</span>
                {!showWizard && (
                  <button
                    onClick={() => setShowWizard(true)}
                    className="flex h-8 items-center gap-2 rounded-control border border-line bg-transparent px-3 text-[12px] text-accent transition-colors hover:bg-field"
                  >
                    {t("settings.myConfigs.newConfigButton")}
                  </button>
                )}
              </div>

              {/* 新增配置表单：置于列表上方，展开时 height+淡入 把已配置列表推下去 */}
              <Collapse open={showWizard}>
                <NewConfigWizard
                  onCreate={handleCreate}
                  onTest={(p, payload, options) => handleTest(null, p, payload, options)}
                  existingProviderRefs={instances.map((i) => i.provider)}
                  testing={!!testingIds["_new"]}
                  testResult={testResult["_new"] ?? null}
                  onCancel={() => setShowWizard(false)}
                />
              </Collapse>

              {instances.length === 0 && !showWizard && (
                <div className="rounded-control border border-accent-line bg-accent-tint px-3 py-2 text-[12px] leading-5 text-fg-1">
                  {t("settings.myConfigs.emptyBanner")}
                </div>
              )}

              <InstancesList
                instances={instances}
                customProviderNames={customProviderNames}
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
                        initialEndpointVariant={inst.endpointVariant}
                        initialCustomModels={mergedCustomModels}
                        customModelMetas={providerMetas[inst.provider] ?? {}}
                        fetchedModels={inst.fetchedModels}
                        fetchedAt={inst.fetchedAt}
                        maskedKey={maskKey(inst.apiKey)}
                        existingApiKey={inst.apiKey}
                        onSave={(p) => handleSaveEdit(id, p)}
                        onTest={(p) => handleTest(id, inst.provider, p)}
                        testing={!!testingIds[id]}
                        testStatus={result?.ok === true ? "success" : "idle"}
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
                      {result?.ok === false && (
                        <div
                          className="mx-3.5 mb-3 rounded-chip border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[11px] text-warning"
                        >
                          {t("customProvider.testFailed", { error: result.message })}
                        </div>
                      )}
                    </>
                  );
                }}
              />
            </section>

          </div>
        ) : tab === "general" ? (
          <div className="flex flex-col gap-7">
            <section className="flex flex-col gap-3.5">
              <div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.language.sectionTitle")}</div>
              <LanguageSelect />
              <div className="flex flex-col gap-1.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">
                  {t("settings.language.assistantLabel")}
                </div>
                <AssistantLanguageSelect />
              </div>
            </section>
            <CdpInputSection
              state={cdpInput}
              onSet={async (next) => { setCdpInput(next); await setCdpInputEnabled(next); }}
            />
            <FeedbackSection activeInstance={instances[0]} />
            <AboutSection />
          </div>
        ) : tab === "skills" ? (
          <SkillsList onRunSkill={onRunSkill ?? (() => {})} />
        ) : (
          <SearchProviderSection />
        )}
        </div>
      </div>
    </div>
  );
}

function draftProviderMeta(
  provider: ProviderRef,
  options: ProviderTestOptions,
): { id: ProviderRef; name: string; defaultBaseUrl: string; placeholder: string; models: ModelMeta[]; endpointVariants?: undefined } | null {
  const baseUrl = options.baseUrl?.trim();
  if (!provider.startsWith(CUSTOM_PREFIX) || !baseUrl || !/^https?:\/\//.test(baseUrl)) return null;
  return {
    id: provider,
    name: options.providerName || provider,
    defaultBaseUrl: baseUrl,
    placeholder: "Custom",
    models: options.candidateModels ?? [],
    endpointVariants: undefined,
  };
}

function SegmentedTabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const t = useT();
  const tabs: { id: Tab; label: string }[] = [
    { id: "configs", label: t("settings.tabs.configs") },
    { id: "skills", label: t("settings.tabs.skills") },
    { id: "search", label: t("settings.tabs.search") },
    { id: "general", label: t("settings.tabs.general") },
  ];
  return (
    <div data-testid="settings-tabs" className="flex w-full overflow-hidden rounded-control border border-line">
      {tabs.map((tb, i) => {
        const active = value === tb.id;
        return (
          <button
            key={tb.id}
            onClick={() => onChange(tb.id)}
            className={`flex-1 py-1.5 text-[12px] transition-colors ${i > 0 ? "border-l border-line" : ""} ${
              active ? "bg-field font-medium text-fg-1" : "bg-transparent text-fg-2 hover:text-fg-1"
            }`}
          >
            {tb.label}
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
    <section className="flex flex-col gap-2.5">
      <div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.feedback.sectionTitle")}</div>
      <p className="text-[12px] leading-[18px] text-fg-2">{t("settings.feedback.githubHint")}</p>
      <div className="flex items-center gap-4 pt-0.5">
        <a href={buildGithubNewIssueUrl(env)} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-accent hover:underline">{t("settings.feedback.githubButton")} ↗</a>
        <a href={buildFeedbackMailto(env)} className="text-[13px] text-fg-2 hover:text-fg-1">{t("settings.feedback.emailButton")} ↗</a>
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
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.experimental")}</span>
      </div>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
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
          <div className="flex flex-col gap-1.5 rounded-chip border border-warning-line bg-warning-tint px-3 py-2 text-[11px] leading-[16px] text-warning">
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

function AboutSection() {
  const t = useT();
  const v = chrome.runtime.getManifest().version;
  return (
    <section className="flex flex-col gap-3.5">
      <div className="h-px w-full bg-line" />
      <div className="flex items-center gap-2.5">
        <img
          src={chrome.runtime.getURL("icons/icon-128.png")}
          alt="Pie"
          className="h-[26px] w-[26px] flex-shrink-0 rounded-chip"
        />
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-semibold text-fg-1">Pie</span>
            <span className="font-mono text-[11px] text-fg-2">v{v}</span>
          </div>
          <span className="text-[11px] text-fg-3">{t("settings.about.tagline")}</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <a href="https://www.pie.chat/" target="_blank" rel="noopener noreferrer" className="text-[12px] text-fg-2 hover:text-fg-1">{t("settings.about.website")} ↗</a>
          <a href="https://github.com/WiseriaAI/pie-ai-agent/releases" target="_blank" rel="noopener noreferrer" className="text-[12px] text-fg-2 hover:text-fg-1">{t("settings.about.changelog")} ↗</a>
        </div>
      </div>
    </section>
  );
}

function maskKey(k: string): string {
  return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
