import { useState, useEffect, useMemo } from "react";
import type { ProviderRef, BuiltinProvider, ModelMeta } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
import { useProviderMeta } from "@/sidepanel/hooks/useProviderMeta";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import { useT, providerDisplayName } from "@/lib/i18n";
import { type StoredCustomModelMeta } from "@/lib/provider-custom-model-meta";
import ProviderModelList from "./ProviderModelList";

export interface InstanceFormPayload {
  nickname: string;
  apiKey: string;
  customModels: string[];
  /** EndpointVariant.id；undefined = 默认端点。 */
  endpointVariant?: string;
}

/** Render-prop API exposed when the parent wants to compose a custom action footer
 *  (e.g. NewConfigWizard merges Test/Create with ← provider/取消 in one row). */
export interface InstanceFormActionsApi {
  canSave: boolean;
  replacing: boolean;
  triggerSave: () => void;
  triggerTest: () => void;
  triggerDelete?: () => void;
  saveLabel: string;
}

interface Props {
  mode: "create" | "edit";
  provider: ProviderRef;
  initialNickname: string;
  initialCustomModels?: string[];
  initialEndpointVariant?: string;
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  maskedKey?: string;
  existingApiKey?: string;
  onSave: (payload: InstanceFormPayload) => void;
  onTest: (payload: InstanceFormPayload) => void;
  onDelete?: () => void;
  customModelMetas?: Record<string, StoredCustomModelMeta>;
  onAddCustomModel?: (id: string, meta: StoredCustomModelMeta) => void;
  onUpdateCustomModelMeta?: (id: string, meta: StoredCustomModelMeta) => void;
  onRemoveCustomModel?: (id: string) => void;
  /** Receives the form's effective apiKey (just-typed or existing) so the
   *  parent can fetch /v1/models without forcing the user to save first. */
  onRefreshModels?: (apiKey: string) => void | Promise<void>;
  saveLabel?: string;
  /** Optional render-prop replacing the default Test/Save/Forget action row.
   *  When provided, InstanceForm renders ONLY the form fields; the parent
   *  is responsible for rendering action buttons via the supplied api. */
  renderActions?: (api: InstanceFormActionsApi) => React.ReactNode;
  /** When true, hides the built-in read-only provider field.
   *  Used by NewConfigWizard where provider is managed by ProviderDropdown above. */
  hideProviderField?: boolean;
}

export default function InstanceForm(props: Props) {
  const t = useT();
  const { meta: resolvedMeta, loading: metaLoading } = useProviderMeta(props.provider);
  // For builtin providers, resolve meta synchronously so the field renders
  // immediately without waiting for the async hook to fire.
  const syncMeta = props.provider.startsWith(CUSTOM_PREFIX) ? undefined : getProviderMeta(props.provider as BuiltinProvider);
  const meta = resolvedMeta ?? syncMeta;
  const isCustomProvider = props.provider.startsWith(CUSTOM_PREFIX);
  const effectiveFetchedModels = useMemo(() => {
    if (isCustomProvider && meta?.models) return meta.models;
    return props.fetchedModels;
  }, [isCustomProvider, meta?.models, props.fetchedModels]);
  const [nickname, setNickname] = useState(props.initialNickname);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  // Locally-tracked custom models. Initialised from initialCustomModels but
  // accumulates user's "+ 添加自定义模型" entries during the form session so
  // they appear in the dropdown immediately AND get carried to onSave.
  // Edit-mode parents (Settings.tsx) also persist async via onAddCustomModel
  // for cross-session durability.
  const [customModels, setCustomModels] = useState<string[]>(props.initialCustomModels ?? []);
  // Sync newly-arrived items from initialCustomModels into local state.
  // Wizard fetches the provider pool asynchronously on provider select, so the
  // prop arrives [] first then [X, ...] — without this effect, useState's
  // one-shot init misses the late arrival. We MERGE (never remove) to avoid
  // racing against just-added local items whose pool write hasn't resolved yet.
  useEffect(() => {
    const incoming = props.initialCustomModels ?? [];
    if (incoming.length === 0) return;
    setCustomModels((prev) => {
      let changed = false;
      const merged = [...prev];
      for (const id of incoming) {
        if (!merged.includes(id)) {
          merged.push(id);
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  }, [props.initialCustomModels]);
  // Lazy init normalizes stale variant ids: if a registry update removed the
  // stored variant, the UI falls back to the default endpoint and saving the
  // form clears the stale id — same semantics as the runtime fallback in
  // instances.ts. Safe at init time: builtin meta resolves synchronously via
  // getProviderMeta, and custom providers never have endpointVariants.
  const [endpointVariant, setEndpointVariant] = useState<string | undefined>(() =>
    meta && resolveEndpointVariant(meta, props.initialEndpointVariant) ? props.initialEndpointVariant : undefined,
  );
  const variants = meta?.endpointVariants ?? [];
  const selectedVariant = meta ? resolveEndpointVariant(meta, endpointVariant) : undefined;

  // Edit mode: start in read-only partial-reveal; create mode: always in replacing state
  const [replacing, setReplacing] = useState(props.mode === "create" || !props.existingApiKey);

  const requireApiKey = props.mode === "create" || replacing;
  const canSave = !requireApiKey || apiKey.trim().length > 0;

  const payload: InstanceFormPayload = { nickname, apiKey, customModels, endpointVariant };

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
      <Field label={t("instanceForm.nickname")}>
        <input
          aria-label="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          className="rounded-[10px] bg-field border border-line focus:border-accent-line px-3 py-2.5 text-[13px] text-fg-1"
        />
      </Field>

      {!props.hideProviderField && (
        <Field label={t("instanceForm.provider")} hint={metaLoading && isCustomProvider ? undefined : meta?.defaultBaseUrl}>
          {metaLoading && isCustomProvider ? (
            <div className="h-[38px] animate-pulse rounded border border-line bg-field" />
          ) : (
            <div className="flex items-center gap-2 rounded-[10px] bg-field border border-line px-3 py-2.5 text-[13px] text-fg-2">
              <span className="text-fg-1">{meta ? providerDisplayName(meta, t) : props.provider}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-3">{t("instanceForm.locked")}</span>
            </div>
          )}
        </Field>
      )}

      {variants.length > 0 && (
        <FieldDiv label={t("instanceForm.endpoint")} hint={selectedVariant?.baseUrl ?? meta?.defaultBaseUrl}>
          <div role="group" aria-label={t("instanceForm.endpoint")} className="flex w-full overflow-hidden rounded-[10px] border border-line">
            {(() => {
              const defaultOpt = { id: undefined as string | undefined, label: meta?.defaultEndpointLabel ?? t("instanceForm.endpointDefault") };
              const variantOpts = variants.map((v) => ({ id: v.id as string | undefined, label: v.label }));
              // defaultEndpointLast：默认端点即按量计费的 provider 把 default 排到最右，
              // 让 Pay-as-you-go 跨 provider 对齐（mimo 的 PAYG 是 variant、本就在右）。
              return meta?.defaultEndpointLast ? [...variantOpts, defaultOpt] : [defaultOpt, ...variantOpts];
            })().map((opt, i) => {
              const active = endpointVariant === opt.id;
              return (
                <button
                  key={opt.id ?? "_default"}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setEndpointVariant(opt.id)}
                  className={`flex-1 px-1 py-2 text-[12px] ${i > 0 ? "border-l border-line" : ""} ${
                    active ? "bg-field font-medium text-fg-1" : "bg-transparent text-fg-2 hover:text-fg-1"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </FieldDiv>
      )}

      <Field label={t("instanceForm.apiKey")} hint={t("instanceForm.aesGcmLocal")}>
        {!replacing && props.existingApiKey ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[10px] bg-field border border-line px-3 py-2.5 font-mono text-[13px] text-fg-1 select-all">
                {partialReveal(props.existingApiKey)}
              </div>
              <button
                type="button"
                onClick={() => setReplacing(true)}
                className="shrink-0 rounded-[10px] border border-line bg-transparent px-2.5 py-2 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
              >
                {t("instanceForm.replaceKey")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <input
                aria-label={t("instanceForm.apiKeyLabel")}
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selectedVariant?.placeholder ?? meta?.placeholder ?? ""}
                className="min-w-0 flex-1 rounded-[10px] bg-field border border-line focus:border-accent-line px-3 py-2.5 text-[13px] text-fg-1"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="shrink-0 rounded-[10px] border border-line bg-transparent px-2.5 py-2 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
              >
                {showKey ? t("instanceForm.hideKey") : t("instanceForm.showKey")}
              </button>
            </div>
            {props.mode === "edit" && props.existingApiKey && (
              <button
                type="button"
                onClick={() => { setApiKey(""); setReplacing(false); }}
                className="self-start rounded-[10px] border border-line bg-transparent px-3 py-2 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
              >
                {t("instanceForm.cancelKeepKey")}
              </button>
            )}
          </div>
        )}
      </Field>

      <Field label={t("instanceForm.models")}>
        <ProviderModelList
          provider={props.provider}
          endpointVariant={endpointVariant}
          customModels={customModels}
          customModelMetas={props.customModelMetas}
          fetchedModels={effectiveFetchedModels}
          fetchedAt={props.fetchedAt}
          isFetching={props.isFetching}
          onAddCustom={(id, meta) => {
            // Local state drives immediate display (the just-added id appears
            // before any async refresh). Persistence is the parent's job, routed
            // by provider type: builtin → pcm/pcmm pool, custom → entity models.
            setCustomModels((prev) => (prev.includes(id) ? prev : [...prev, id]));
            props.onAddCustomModel?.(id, meta);
          }}
          onUpdateCustomMeta={(id, meta) => props.onUpdateCustomModelMeta?.(id, meta)}
          onRemoveCustom={(id) => {
            setCustomModels((prev) => prev.filter((x) => x !== id));
            props.onRemoveCustomModel?.(id);
          }}
          onRefresh={() => {
            // Effective apiKey: just-typed (replacing OR creating) takes
            // precedence; otherwise fall back to existing stored key.
            const effective = apiKey.trim().length > 0 ? apiKey : (props.existingApiKey ?? "");
            props.onRefreshModels?.(effective);
          }}
        />
      </Field>

      {!props.renderActions && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button
            onClick={() => props.onTest(payload)}
            disabled={!canSave}
            className="rounded-[10px] border border-line bg-transparent px-3 py-2 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1 disabled:opacity-30"
          >
            {t("instanceForm.test")}
          </button>
          <button
            onClick={() => props.onSave(payload)}
            disabled={!canSave}
            className="rounded-[10px] bg-fg-1 px-4 py-2 text-[12px] font-medium text-canvas disabled:opacity-30"
          >
            {props.saveLabel ?? t("instanceForm.save")}
          </button>
          {props.mode === "edit" && props.onDelete && (
            <button
              onClick={() => props.onDelete!()}
              className="ml-auto rounded-[10px] bg-transparent px-3 py-2 text-[12px] text-warning hover:bg-warning-tint"
            >
              {t("instanceForm.forgetConfig")}
            </button>
          )}
        </div>
      )}
      </div>
      {props.renderActions && props.renderActions({
        canSave,
        replacing,
        saveLabel: props.saveLabel ?? t("instanceForm.save"),
        triggerSave: () => props.onSave(payload),
        triggerTest: () => props.onTest(payload),
        triggerDelete: props.onDelete,
      })}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-fg-2">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

/** Like Field but uses a <div> instead of <label> — use when children contain
 *  interactive controls (buttons) whose accessible names must not inherit the
 *  surrounding label text (e.g. segmented button groups). */
function FieldDiv({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-fg-2">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function partialReveal(key: string): string {
  if (key.length <= 8) return "•".repeat(8);
  return `${key.slice(0, 7)}${"•".repeat(Math.max(8, key.length - 11))}${key.slice(-4)}`;
}
