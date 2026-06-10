import { useState } from "react";
import type { ProviderRef, ModelMeta, BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import { useT } from "@/lib/i18n";
import { type StoredCustomModelMeta, DEFAULT_CUSTOM_MODEL_MAX_CONTEXT } from "@/lib/provider-custom-model-meta";
import ModelMetaEditor, { type ModelMetaDraft } from "./ModelMetaEditor";

interface Props {
  provider: ProviderRef;
  /** When set, the registry model list is replaced by the variant's models override (if any). */
  endpointVariant?: string;
  /** Editable custom model ids (builtin: pcm pool; custom provider: entity models). */
  customModels: string[];
  customModelMetas?: Record<string, StoredCustomModelMeta>;
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  onAddCustom?: (id: string, meta: StoredCustomModelMeta) => void;
  onUpdateCustomMeta?: (id: string, meta: StoredCustomModelMeta) => void;
  onRemoveCustom?: (id: string) => void;
  onRefresh?: () => void;
}

/**
 * 设置页「模型列表」区：内置模型（registry → fetched）只读展示；自定义模型可
 * 编辑 / 删除；底部「添加自定义模型」。不含「选当前 model」语义 —— 模型选择
 * 在 Composer 的 ModelPicker 里做。
 */
export default function ProviderModelList(props: Props) {
  const t = useT();
  const isCustomProvider = props.provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustomProvider ? undefined : getProviderMeta(props.provider as BuiltinProvider);
  const variant = meta ? resolveEndpointVariant(meta, props.endpointVariant) : undefined;
  // When the selected variant has a models override, use it exclusively (same
  // semantics as ModelPicker's modelsFor). fetchedModels are also skipped in
  // this case because the variant's pool is fixed and can't be fetched.
  const registry = variant?.models ?? meta?.models ?? [];
  const fetched = variant?.models ? [] : (props.fetchedModels ?? []);
  const [editing, setEditing] = useState<Partial<ModelMetaDraft> | null>(null);

  // Built-in (read-only): registry → fetched, dedup.
  const seen = new Set<string>();
  const builtin: ModelMeta[] = [...registry, ...fetched].filter((m) =>
    seen.has(m.id) ? false : (seen.add(m.id), true),
  );
  // Custom (editable): customModels not already shown as built-in.
  const custom = props.customModels.filter((id) => !seen.has(id));
  const isLazy = registry.length === 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] bg-field">
      {isLazy && props.onRefresh && (
        <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[10px] text-fg-3">
          <span className="font-mono">
            {props.fetchedAt ? new Date(props.fetchedAt).toLocaleString() : t("modelDropdown.notFetched")}
          </span>
          <button onClick={props.onRefresh} className="hover:text-fg-1">
            {props.isFetching ? t("modelDropdown.fetching") : t("modelDropdown.refresh")}
          </button>
        </div>
      )}

      {builtin.map((m) => (
        <div key={m.id} className="flex items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2">{m.id}</span>
          {m.vision && <Chip>{t("modelDropdown.vision")}</Chip>}
          {m.tools && <Chip>{t("modelDropdown.tools")}</Chip>}
        </div>
      ))}

      {custom.length > 0 && (
        <div className="border-y border-line bg-canvas px-3 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-fg-3">
          {t("modelDropdown.custom")}
        </div>
      )}
      {custom.map((id) => {
        const cm = props.customModelMetas?.[id];
        return (
          <div key={id} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-1">{id}</span>
            {cm?.vision && <Chip>{t("modelDropdown.vision")}</Chip>}
            <span
              role="button"
              aria-label="edit"
              onClick={() =>
                setEditing({
                  id,
                  vision: cm?.vision ?? false,
                  maxContextTokens: cm?.maxContextTokens ?? DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
                  displayName: cm?.displayName,
                })
              }
              className="flex items-center cursor-pointer text-fg-3 hover:text-fg-1"
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M9.5 2.5L11.5 4.5L5 11L2.5 11.5L3 9L9.5 2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>
            </span>
            {props.onRemoveCustom && (
              <span
                role="button"
                aria-label="remove"
                onClick={() => props.onRemoveCustom!(id)}
                className="flex items-center cursor-pointer text-fg-3 hover:text-warning"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              </span>
            )}
          </div>
        );
      })}

      {props.onAddCustom && (
        <button
          onClick={() => setEditing({})}
          className="border-t border-line px-3 py-2 text-left text-[11px] text-accent hover:bg-surface"
        >
          {t("modelDropdown.addCustomModel")}
        </button>
      )}

      {editing && (
        <ModelMetaEditor
          key={editing.id ? `edit:${editing.id}` : "add"}
          showTools={false}
          modelIdReadonly={!!editing.id}
          initial={editing}
          onSave={(d) => {
            const storedMeta: StoredCustomModelMeta = {
              displayName: d.displayName || undefined,
              vision: d.vision,
              maxContextTokens: d.maxContextTokens,
            };
            if (editing.id) props.onUpdateCustomMeta?.(editing.id, storedMeta);
            else props.onAddCustom?.(d.id, storedMeta);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-accent-tint px-2 py-0.5 font-mono text-[10px] text-fg-2">{children}</span>;
}
