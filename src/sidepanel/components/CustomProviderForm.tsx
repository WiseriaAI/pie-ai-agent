import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n";
import type { StoredCustomProvider, CustomModelMeta } from "@/lib/custom-providers";
import {
  saveCustomProvider,
  updateCustomProvider,
  deleteCustomProvider,
  getInstancesUsingCustomProvider,
  type CustomProviderInstanceRef,
} from "@/lib/custom-providers";
import { fetchOpenAICompatModels } from "@/lib/openai-compat-models-fetch";

interface Props {
  existing?: StoredCustomProvider | null;
  onSaved: (saved: StoredCustomProvider) => void;
  onBack?: () => void;
  onDeleted?: () => void;
}

interface EditingModel {
  index?: number;
  id: string;
  displayName: string;
  tools: boolean;
  vision: boolean;
  maxContextTokens: number;
  advancedOpen: boolean;
}

export default function CustomProviderForm({ existing, onSaved, onBack, onDeleted }: Props) {
  const t = useT();
  const isEdit = existing != null;
  const [name, setName] = useState(existing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [models, setModels] = useState<CustomModelMeta[]>(existing?.models ?? []);
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<CustomModelMeta[]>([]);
  const [importChecked, setImportChecked] = useState<Record<string, boolean>>({});
  const [editingModel, setEditingModel] = useState<EditingModel | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dependentInstances, setDependentInstances] = useState<CustomProviderInstanceRef[]>([]);

  useEffect(() => {
    if (isEdit && existing) {
      getInstancesUsingCustomProvider(existing.id).then(setDependentInstances);
    }
  }, [isEdit, existing]);

  function cleanUrl(raw: string): string {
    return raw.trim().replace(/\/+$/, "");
  }

  function handleBaseUrlBlur() {
    setBaseUrl(cleanUrl(baseUrl));
  }

  function resetTest() {
    setTestLoading(false);
    setTestError(null);
    setFetchedModels([]);
    setImportChecked({});
  }

  async function handleTest() {
    const url = cleanUrl(baseUrl);
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;
    setTestLoading(true);
    setTestError(null);
    setFetchedModels([]);
    setImportChecked({});
    try {
      const result = await fetchOpenAICompatModels(url);
      setFetchedModels(result);
      const allChecked: Record<string, boolean> = {};
      result.forEach((m) => { allChecked[m.id] = true; });
      setImportChecked(allChecked);
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTestLoading(false);
    }
  }

  function importSelectedModels() {
    const existingIds = new Set(models.map((m) => m.id));
    const toAdd = fetchedModels.filter((m) => importChecked[m.id] && !existingIds.has(m.id));
    if (toAdd.length === 0) return;
    setModels((prev) => [...prev, ...toAdd]);
  }

  function openAddModel() {
    setEditingModel({
      id: "",
      displayName: "",
      tools: true,
      vision: false,
      maxContextTokens: 128_000,
      advancedOpen: false,
    });
  }

  function openEditModel(index: number) {
    const m = models[index];
    setEditingModel({
      index,
      id: m.id,
      displayName: m.displayName ?? "",
      tools: m.tools,
      vision: m.vision,
      maxContextTokens: m.maxContextTokens,
      advancedOpen: false,
    });
  }

  function saveEditingModel() {
    if (!editingModel) return;
    const { id, displayName, tools, vision, maxContextTokens, index } = editingModel;
    if (!id.trim()) return;

    const duplicate = models.some(
      (m, i) => m.id === id && (index === undefined || i !== index),
    );
    if (duplicate) {
      setSaveError(`Model "${id}" already exists`);
      return;
    }

    const meta: CustomModelMeta = {
      id,
      displayName: displayName || undefined,
      tools,
      vision,
      maxContextTokens,
    };

    if (index !== undefined) {
      setModels((prev) => prev.map((m, i) => (i === index ? meta : m)));
    } else {
      setModels((prev) => [...prev, meta]);
    }
    setEditingModel(null);
  }

  async function handleSave() {
    setSaveError(null);
    const cleanedUrl = cleanUrl(baseUrl);

    if (!name.trim()) { setSaveError("Name is required"); return; }
    if (name.trim().length > 40) { setSaveError("Name must be 40 characters or less"); return; }
    if (!cleanedUrl) { setSaveError("Base URL is required"); return; }
    if (!cleanedUrl.startsWith("http://") && !cleanedUrl.startsWith("https://")) {
      setSaveError("Base URL must start with http:// or https://");
      return;
    }

    setSaving(true);
    try {
      if (isEdit && existing) {
        await updateCustomProvider(existing.id, { name: name.trim(), baseUrl: cleanedUrl, models });
        const updated: StoredCustomProvider = {
          ...existing,
          name: name.trim(),
          baseUrl: cleanedUrl,
          models,
          updatedAt: Date.now(),
        };
        onSaved(updated);
      } else {
        const newId = await saveCustomProvider({ name: name.trim(), baseUrl: cleanedUrl, models });
        const now = Date.now();
        const saved: StoredCustomProvider = {
          id: newId,
          name: name.trim(),
          baseUrl: cleanedUrl,
          models,
          createdAt: now,
          updatedAt: now,
        };
        onSaved(saved);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!existing) return;
    setSaving(true);
    deleteCustomProvider(existing.id)
      .then(() => onDeleted?.())
      .catch((e) => {
        setSaveError(e instanceof Error ? e.message : "Delete failed");
      })
      .finally(() => setSaving(false));
  }

  const showHttpWarning = (() => {
    const url = cleanUrl(baseUrl);
    if (!url.startsWith("http://")) return false;
    try {
      const u = new URL(url);
      const h = u.hostname;
      if (
        h === "localhost" ||
        h === "127.0.0.1" ||
        h.startsWith("10.") ||
        h.startsWith("172.") ||
        h.startsWith("192.")
      )
        return false;
    } catch {
      return false;
    }
    return true;
  })();

  const forgetDisabled = dependentInstances.length > 0;
  const forgetHint =
    dependentInstances.length > 0
      ? `Used by ${dependentInstances.length} instance${dependentInstances.length > 1 ? "s" : ""} — delete those first`
      : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-line bg-canvas px-3.5 py-3">
        {onBack && (
          <button
            onClick={onBack}
            className="flex h-7 w-7 items-center justify-center rounded text-fg-2 hover:bg-field hover:text-fg-1"
            aria-label={t("customProvider.back")}
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
        )}
        <span className="text-[13px] font-semibold tracking-[-0.005em] text-fg-1">
          {isEdit ? existing.name : t("customProvider.newCustomProvider")}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 py-5">
          {saveError && (
            <div className="rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[11px] text-warning">
              {saveError}
            </div>
          )}

          <Field label={t("customProvider.name")} hint={`${name.length}/40`}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder={t("customProvider.namePlaceholder")}
              className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
            />
          </Field>

          <Field label={t("customProvider.baseUrl")}>
            <input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                if (fetchedModels.length > 0 || testError) resetTest();
              }}
              onBlur={handleBaseUrlBlur}
              placeholder={t("customProvider.baseUrlPlaceholder")}
              className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-fg-3">
                ⓘ {t("customProvider.baseUrlWarning")}
              </span>
              {showHttpWarning && (
                <span className="font-mono text-[10px] text-warning">
                  ⚠ {t("customProvider.baseUrlWarningHttp")}
                </span>
              )}
            </div>
          </Field>

          <div className="flex flex-col gap-1.5">
            <button
              onClick={handleTest}
              disabled={testLoading || !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")}
              className="flex items-center gap-1.5 self-start rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
            >
              {testLoading && (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8A6 6 0 1 1 2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {testLoading ? t("customProvider.testing") : t("customProvider.testConnection")}
            </button>
          </div>

          {testError && (
            <div className="font-mono text-[11px] text-warning">
              ✗ Error: {testError}
            </div>
          )}

          {fetchedModels.length > 0 && (
            <div className="flex flex-col gap-2 rounded border border-line bg-surface p-2">
              <span className="caps text-fg-3">{t("customProvider.importModels")}</span>
              <span className="font-mono text-[11px] text-accent">
                {t("customProvider.connectedModels", { count: fetchedModels.length, plural: fetchedModels.length > 1 ? "s" : "" })}
              </span>
              <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
                {fetchedModels.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-1">
                    <input
                      type="checkbox"
                      checked={!!importChecked[m.id]}
                      onChange={(e) =>
                        setImportChecked((prev) => ({ ...prev, [m.id]: e.target.checked }))
                      }
                    />
                    {m.id}
                  </label>
                ))}
              </div>
              <button
                onClick={importSelectedModels}
                className="self-start rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3"
              >
                {t("customProvider.importSelected")}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="caps text-fg-3">{t("customProvider.models")}</div>
            {models.length === 0 && (
              <div className="rounded border border-dashed border-line px-3 py-3 text-center font-mono text-[11px] text-fg-3">
                {t("customProvider.noModels")}
              </div>
            )}
            {models.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded border border-line bg-surface px-3 py-2"
              >
                <div className="flex-1">
                  <span className="text-[12px] text-fg-1">{m.id}</span>
                  {m.displayName && (
                    <span className="ml-2 font-mono text-[10px] text-fg-3">{m.displayName}</span>
                  )}
                </div>
                <button
                  onClick={() => openEditModel(i)}
                  className="rounded p-1 text-fg-3 hover:text-fg-1"
                  aria-label={t("customProvider.editModel")}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M8.5 1.5L10.5 3.5L3.5 10.5L1 11L1.5 8.5L8.5 1.5Z"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => setModels((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded p-1 text-fg-3 hover:text-warning"
                  aria-label={t("customProvider.deleteModel")}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M3 3L9 9M9 3L3 9"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
            <button
              onClick={openAddModel}
              className="flex items-center gap-1 self-start rounded border border-dashed border-line bg-transparent px-3 py-2 text-[12px] text-accent hover:bg-field"
            >
              {t("customProvider.addModel")}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 pt-2">
            <button
              onClick={onBack}
              className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
            >
              {t("common.cancel")}
            </button>
            {isEdit && (
              <button
                onClick={handleDelete}
                disabled={forgetDisabled || saving}
                className="ml-auto rounded border border-warning-line bg-transparent px-3 py-1.5 text-[11px] text-warning hover:bg-warning-tint disabled:opacity-30"
                title={forgetHint}
              >
                {t("customProvider.forget")}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="ml-auto rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
            >
              {saving ? t("customProvider.saving") : t("customProvider.save")}
            </button>
          </div>
          {(isEdit && forgetHint) && (
            <div className="font-mono text-[10px] text-fg-3">{forgetHint}</div>
          )}
        </div>
      </div>

      {editingModel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="flex max-w-sm flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <span className="caps text-fg-1">
              {editingModel.index !== undefined
                ? t("customProvider.editModelCaps")
                : t("customProvider.addModelCaps")}
            </span>

            <Field label={t("customProvider.modelId")}>
              <input
                value={editingModel.id}
                onChange={(e) =>
                  setEditingModel((prev) => (prev ? { ...prev, id: e.target.value } : prev))
                }
                placeholder={t("customProvider.modelIdPlaceholder")}
                className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
              />
            </Field>

            <Field label={t("customProvider.displayName")}>
              <input
                value={editingModel.displayName}
                onChange={(e) =>
                  setEditingModel((prev) =>
                    prev ? { ...prev, displayName: e.target.value } : prev,
                  )
                }
                placeholder={t("customProvider.displayNamePlaceholder")}
                className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
              />
            </Field>

            <button
              onClick={() =>
                setEditingModel((prev) =>
                  prev ? { ...prev, advancedOpen: !prev.advancedOpen } : prev,
                )
              }
              className="flex items-center gap-1 self-start text-[11px] text-fg-3 hover:text-fg-1"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                className={`transition-transform ${editingModel.advancedOpen ? "rotate-90" : ""}`}
              >
                <path d="M3 1L7 5L3 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              </svg>
              {t("customProvider.advanced")}
            </button>

            {editingModel.advancedOpen && (
              <div className="flex flex-col gap-3 pl-2">
                <label className="flex items-center gap-2 text-[12px] text-fg-1">
                  <input
                    type="checkbox"
                    checked={editingModel.tools}
                    onChange={(e) =>
                      setEditingModel((prev) =>
                        prev ? { ...prev, tools: e.target.checked } : prev,
                      )
                    }
                  />
                  {t("customProvider.tools")}
                </label>
                <label className="flex items-center gap-2 text-[12px] text-fg-1">
                  <input
                    type="checkbox"
                    checked={editingModel.vision}
                    onChange={(e) =>
                      setEditingModel((prev) =>
                        prev ? { ...prev, vision: e.target.checked } : prev,
                      )
                    }
                  />
                  {t("customProvider.vision")}
                </label>
                <Field label={t("customProvider.maxContextTokens")}>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={editingModel.maxContextTokens}
                    onChange={(e) =>
                      setEditingModel((prev) =>
                        prev
                          ? { ...prev, maxContextTokens: Number(e.target.value) || 0 }
                          : prev,
                      )
                    }
                    className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 focus:border-accent-line"
                  />
                </Field>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setEditingModel(null)}
                className="rounded border border-line bg-transparent px-3 py-1.5 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={saveEditingModel}
                disabled={!editingModel.id.trim()}
                className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
