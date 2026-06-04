import { useState } from "react";
import { useT } from "@/lib/i18n";
import { DEFAULT_CUSTOM_MODEL_MAX_CONTEXT } from "@/lib/provider-custom-model-meta";

export interface ModelMetaDraft {
  id: string;
  displayName?: string;
  vision: boolean;
  tools: boolean;
  maxContextTokens: number;
}

interface Props {
  initial?: Partial<ModelMetaDraft>;
  showTools: boolean;
  modelIdReadonly?: boolean;
  modelIdPlaceholder?: string;
  onSave: (draft: ModelMetaDraft) => void;
  onCancel: () => void;
}

export default function ModelMetaEditor({ initial, showTools, modelIdReadonly, modelIdPlaceholder, onSave, onCancel }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<ModelMetaDraft>({
    id: initial?.id ?? "",
    displayName: initial?.displayName ?? "",
    vision: initial?.vision ?? false,
    tools: initial?.tools ?? true,
    maxContextTokens: initial?.maxContextTokens ?? DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <span className="caps text-fg-1">
          {modelIdReadonly
            ? t("customProvider.editModelCaps")
            : t("customProvider.addModelCaps")}
        </span>

        <Field label={t("customProvider.modelId")}>
          <input
            value={draft.id}
            readOnly={modelIdReadonly}
            onChange={(e) => setDraft((prev) => ({ ...prev, id: e.target.value }))}
            placeholder={modelIdPlaceholder ?? t("modelDropdown.modelIdPlaceholder")}
            className={`w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line${modelIdReadonly ? " opacity-60 cursor-default" : ""}`}
          />
        </Field>

        <Field label={t("customProvider.displayName")}>
          <input
            value={draft.displayName ?? ""}
            onChange={(e) => setDraft((prev) => ({ ...prev, displayName: e.target.value }))}
            placeholder={t("customProvider.displayNamePlaceholder")}
            className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
          />
        </Field>

        <Field label={t("customProvider.maxContextTokens")}>
          <input
            type="number"
            min={0}
            step={1000}
            value={draft.maxContextTokens}
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, maxContextTokens: Number(e.target.value) || 0 }))
            }
            className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 focus:border-accent-line"
          />
        </Field>

        <div className="flex items-center gap-5 pt-0.5">
          <label className="flex items-center gap-2 text-[12px] text-fg-1">
            <input
              type="checkbox"
              checked={draft.vision}
              onChange={(e) => setDraft((prev) => ({ ...prev, vision: e.target.checked }))}
            />
            {t("customProvider.vision")}
          </label>
          {showTools && (
            <label className="flex items-center gap-2 text-[12px] text-fg-1">
              <input
                type="checkbox"
                checked={draft.tools}
                onChange={(e) => setDraft((prev) => ({ ...prev, tools: e.target.checked }))}
              />
              {t("customProvider.tools")}
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="rounded border border-line bg-transparent px-3 py-1.5 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={!draft.id.trim()}
            className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
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
