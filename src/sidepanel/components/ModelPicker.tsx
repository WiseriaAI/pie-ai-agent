import { useState, useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import type { DecryptedInstance } from "@/lib/instances";
import type { BuiltinProvider, ModelMeta } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import ProviderIcon from "./ProviderIcon";

interface Props {
  instances: DecryptedInstance[];
  currentInstanceId: string | null;
  currentModel: string | null;
  /** task in flight — picker is locked */
  locked: boolean;
  onSelect: (instanceId: string, model: string) => void;
  onManage: () => void;
  /** lazy provider (openrouter) first-expand fetch of /v1/models */
  onRefreshModels?: (instanceId: string) => void;
}

function shortModel(modelId: string): string {
  if (!modelId) return "";
  if (modelId.includes("/")) return modelId.split("/").pop()!;
  if (modelId.startsWith("claude-")) return modelId.slice("claude-".length);
  return modelId;
}

function providerName(inst: DecryptedInstance): string {
  if (inst.provider.startsWith(CUSTOM_PREFIX)) return inst.nickname || inst.provider;
  return getProviderMeta(inst.provider as BuiltinProvider)?.name ?? inst.nickname ?? inst.provider;
}

interface ModelRow {
  id: string;
  meta?: ModelMeta;
  isCustom: boolean;
}

/** Build the dedup'd model list for an instance: registry → fetched → custom. */
function modelsFor(inst: DecryptedInstance): ModelRow[] {
  const isCustom = inst.provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustom ? undefined : getProviderMeta(inst.provider as BuiltinProvider);
  const registry = meta?.models ?? [];
  const fetched = (inst.fetchedModels ?? []) as ModelMeta[];
  const custom = inst.customModels ?? [];
  const rows: ModelRow[] = [
    ...registry.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...fetched.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...custom.map((id) => ({ id, isCustom: true })),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export default function ModelPicker(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(props.currentInstanceId);
  const [query, setQuery] = useState("");
  // Popover slide-in/out: `mounted` controls render, `shown` drives the
  // transition target. On close we keep it mounted until the exit transition
  // finishes (onTransitionEnd), so the close is animated too.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two RAFs so the element paints in its initial (hidden) state before we
      // flip `shown`, guaranteeing the enter transition actually runs.
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false); // trigger exit transition; unmount on its end
  }, [open]);

  // Reset the in-provider search when switching the expanded provider or closing.
  useEffect(() => {
    setQuery("");
  }, [expandedId, open]);

  const current = props.instances.find((i) => i.id === props.currentInstanceId) ?? null;

  function toggleProvider(inst: DecryptedInstance) {
    const next = expandedId === inst.id ? null : inst.id;
    setExpandedId(next);
    if (next) {
      const meta = inst.provider.startsWith(CUSTOM_PREFIX)
        ? undefined
        : getProviderMeta(inst.provider as BuiltinProvider);
      const lazyEmpty = (meta?.models.length ?? 0) === 0 && (inst.fetchedModels?.length ?? 0) === 0;
      if (lazyEmpty) props.onRefreshModels?.(inst.id);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => !props.locked && setOpen(!open)}
        disabled={props.locked}
        className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] text-fg-2 disabled:opacity-50"
        aria-label={current ? `${providerName(current)} ${props.currentModel ?? ""}` : t("modelPicker.none")}
      >
        {current && <ProviderIcon provider={current.provider} size={16} className="text-accent" />}
        <span className="font-mono">
          {current ? `${providerName(current)} · ${shortModel(props.currentModel ?? "")}` : t("modelPicker.none")}
        </span>
        {props.locked ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className="text-fg-3">
            <path d="M3 5V3.5C3 2.4 3.9 1.5 5 1.5C6.1 1.5 7 2.4 7 3.5V5M2.5 5H7.5V8.5H2.5V5Z" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden className="text-fg-3" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s ease" }}>
            <path d="M3.5 5.5L7 9L10.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {mounted && (
        <div
          role="dialog"
          onTransitionEnd={() => { if (!shown) setMounted(false); }}
          style={{
            opacity: shown ? 1 : 0,
            transform: shown ? "translateY(0)" : "translateY(8px)",
            transition: "opacity 0.18s ease, transform 0.18s ease",
          }}
          className="absolute bottom-full left-0 mb-2 w-[300px] rounded-lg border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.24)]"
        >
          <div className="flex items-baseline justify-between px-3.5 pt-2.5 pb-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-3">{t("modelPicker.title")}</span>
            <span className="font-mono text-[10px] text-fg-3">{props.instances.length} {t("modelPicker.providersSuffix")}</span>
          </div>
          <div className="flex max-h-[360px] flex-col overflow-y-auto">
            {props.instances.map((inst) => {
              const isExpanded = expandedId === inst.id;
              const isCurrentProvider = inst.id === props.currentInstanceId;
              return (
                <div key={inst.id} className={isExpanded ? "bg-field" : ""}>
                  <button
                    onClick={() => toggleProvider(inst)}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-field"
                  >
                    <ProviderIcon provider={inst.provider} size={22} className={isCurrentProvider ? "text-accent" : "text-fg-2"} />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-1">{providerName(inst)}</span>
                    {!isExpanded && isCurrentProvider && props.currentModel && (
                      <span className="font-mono text-[10px] text-accent">{shortModel(props.currentModel)}</span>
                    )}
                    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden style={{ transform: isExpanded ? "rotate(90deg)" : "none", flexShrink: 0, transition: "transform 0.2s ease" }}>
                      <path d="M3 2L5 4L3 6" fill="none" stroke="#8A929E" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateRows: isExpanded ? "1fr" : "0fr",
                      transition: "grid-template-rows 0.22s ease",
                    }}
                  >
                    <div style={{ overflow: "hidden" }}>
                      <ExpandedModels
                        inst={inst}
                        isExpanded={isExpanded}
                        query={query}
                        setQuery={setQuery}
                        currentModel={isCurrentProvider ? props.currentModel : null}
                        onPick={(model) => { props.onSelect(inst.id, model); setOpen(false); }}
                        placeholder={`${providerName(inst)} ${t("modelPicker.searchSuffix")}`}
                        emptyText={t("modelPicker.noModels")}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => { setOpen(false); props.onManage(); }}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2 text-left text-[11px] text-fg-2 hover:bg-field"
          >
            <span>{t("modelPicker.manage")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ExpandedModels(props: {
  inst: DecryptedInstance;
  isExpanded: boolean;
  query: string;
  setQuery: (q: string) => void;
  currentModel: string | null;
  onPick: (model: string) => void;
  placeholder: string;
  emptyText: string;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the search box when this provider becomes the expanded one (the
  // accordion keeps all rows mounted for the open/close height animation, so we
  // can't rely on autoFocus — that would fight across rows).
  useEffect(() => {
    if (props.isExpanded) inputRef.current?.focus();
  }, [props.isExpanded]);
  const rows = modelsFor(props.inst);
  const q = props.query.trim().toLowerCase();
  const list = q
    ? rows.filter((r) => `${r.id} ${r.meta?.displayName ?? ""}`.toLowerCase().includes(q))
    : rows;
  return (
    <div className="flex flex-col pb-1">
      <input
        ref={inputRef}
        aria-label={props.placeholder}
        value={props.query}
        onChange={(e) => props.setQuery(e.target.value)}
        placeholder={props.placeholder}
        className="mx-3.5 mb-1 rounded border border-line bg-field px-2 py-1 text-[11px] text-fg-1 placeholder:text-fg-3"
      />
      <div className="flex max-h-[240px] flex-col overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-3.5 py-1.5 pl-11 text-[11px] text-fg-3">{props.emptyText}</div>
        ) : (
          list.map((r) => (
            <button
              key={r.id}
              onClick={() => props.onPick(r.id)}
              className={`flex items-center gap-2 px-3.5 py-1.5 pl-11 text-left hover:bg-surface ${r.id === props.currentModel ? "bg-surface" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-1">{r.id}</span>
              {r.meta?.vision && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.vision")}</span>}
              {r.meta?.tools && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.tools")}</span>}
              {r.id === props.currentModel && (
                <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden style={{ flexShrink: 0 }}>
                  <path d="M2 5.5L4.5 8L9 3" fill="none" stroke="#B8C8D6" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
