import { useState, useEffect, useRef } from "react";
import { Popover } from "./ui/Popover";
import { useAnchorRect } from "./ui/useAnchorRect";
import { useT } from "@/lib/i18n";
import type { DecryptedInstance } from "@/lib/instances";
import type { BuiltinProvider, ModelMeta } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import ProviderIcon from "./ProviderIcon";
import { getCachedEntitlement, cachedManagedModel } from "@/lib/managed-account";
import { consumptionDots } from "@/lib/managed-format";
import type { ModelInfo } from "@/lib/managed-auth";

interface Props {
  instances: DecryptedInstance[];
  currentInstanceId: string | null;
  currentModel: string | null;
  /** task in flight — picker is locked */
  locked: boolean;
  onSelect: (instanceId: string, model: string) => void;
  onManage?: () => void;
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

function displayModel(inst: DecryptedInstance | null, modelId: string | null): string {
  if (!inst || !modelId) return shortModel(modelId ?? "");
  if (inst.provider === "managed") return cachedManagedModel(inst.apiKey, modelId)?.name ?? modelId;
  return shortModel(modelId);
}

interface ModelRow {
  id: string;
  meta?: ModelMeta;
  isCustom: boolean;
  /** 仅 managed provider：承载 entitlement 模型元数据（名/描述/vision/costLevel）。 */
  managed?: ModelInfo;
}

/** Build the dedup'd model list for an instance: registry → fetched → custom.
 *  带 models override 的 endpoint variant 整体替换 registry 段（fetched 仅
 *  openrouter 使用、与 variant 不相交，但同样跳过以保持「替换」语义）。
 *  Exported for unit tests. */
export function modelsFor(inst: DecryptedInstance): ModelRow[] {
  if (inst.provider === "managed") {
    const cached = getCachedEntitlement(inst.apiKey)?.models ?? [];
    if (cached.length > 0) return cached.map((m) => ({ id: m.id, isCustom: false, managed: m }));
    // 缓存未就绪：回退 registry 单条兜底（保证不空）——落到下方原有逻辑。
  }
  const isCustom = inst.provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustom ? undefined : getProviderMeta(inst.provider as BuiltinProvider);
  const variant = meta ? resolveEndpointVariant(meta, inst.endpointVariant) : undefined;
  const registry = variant?.models ?? meta?.models ?? [];
  const fetched = variant?.models ? [] : ((inst.fetchedModels ?? []) as ModelMeta[]);
  const custom = inst.customModels ?? [];
  const rows: ModelRow[] = [
    ...registry.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...fetched.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...custom.map((id) => ({ id, isCustom: true })),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Pure positioning math for the portaled (position:fixed) popover, derived
 *  from the trigger's rect. Left-aligns to the trigger then clamps inside the
 *  viewport so a narrow side panel never pushes it off either edge; flips up
 *  when there's room above the trigger, else opens downward. Viewport dims are
 *  passed in (not read from window) so it stays a unit-testable pure function.
 *  Exported for unit tests. */
export function computePopoverCoords(
  rect: DOMRect,
  viewportW: number,
  viewportH: number,
): { left: number; top?: number; bottom?: number } {
  const POPOVER_MAX_H = 380; // panel content max-h-[360px] + paddings/header budget
  const GAP = 8; // ≈ the old mb-2 gap
  const MARGIN = 8; // min gap from the viewport edges
  const POPOVER_W = Math.min(300, viewportW - 24); // matches w-[300px] / max-w-[calc(100vw-1.5rem)]
  const left = Math.max(MARGIN, Math.min(rect.left, viewportW - POPOVER_W - MARGIN));
  if (rect.top >= POPOVER_MAX_H + GAP) {
    return { left, bottom: viewportH - rect.top + GAP };
  }
  return { left, top: rect.bottom + GAP };
}

export default function ModelPicker(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(props.currentInstanceId);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Fixed-position coords for the portaled popover. useAnchorRect owns the
  // measurement + resize/scroll-capture lifecycle (re-measures while open);
  // computePopoverCoords is the pure flip/clamp math. The popover is portaled to
  // document.body (so no ancestor overflow/stacking clips it) and positioned
  // with position:fixed: left-aligned to the trigger then clamped on-screen,
  // opening upward when there's room above, else downward.
  const triggerRect = useAnchorRect(triggerRef, open);
  const coords = triggerRect
    ? computePopoverCoords(triggerRect, window.innerWidth, window.innerHeight)
    : null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = wrapRef.current?.contains(target);
      const inPopover = popoverRef.current?.contains(target);
      // Popover is portaled out of wrapRef, so check both before closing.
      if (!inTrigger && !inPopover) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
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
      // 前提：唯一 lazy provider（openrouter）没有 endpointVariants，而所有带
      // variant 的 provider 默认 models 非空，所以这里暂不感知 variant。若未来
      // 某个 lazy provider 挂上带 models override 的 variant，需改为按 modelsFor 判断。
      const lazyEmpty = (meta?.models.length ?? 0) === 0 && (inst.fetchedModels?.length ?? 0) === 0;
      if (lazyEmpty) props.onRefreshModels?.(inst.id);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        onClick={() => !props.locked && setOpen(!open)}
        disabled={props.locked}
        className="flex items-center gap-1.5 px-1.5 py-1 text-[12px] text-fg-2 disabled:opacity-50"
        aria-label={current ? `${providerName(current)} ${props.currentModel ?? ""}` : t("modelPicker.none")}
      >
        {current && <ProviderIcon provider={current.provider} size={16} className="text-accent" />}
        <span className="font-mono">
          {current ? `${providerName(current)} · ${displayModel(current, props.currentModel)}` : t("modelPicker.none")}
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

      <Popover
        open={open && !!coords}
        popoverRef={popoverRef}
        role="dialog"
        placement={coords?.bottom != null ? "above" : "below"}
        style={{ left: coords?.left, top: coords?.top, bottom: coords?.bottom }}
        className="fixed z-[100] w-[300px] max-w-[calc(100vw-1.5rem)] rounded-card border border-line bg-surface shadow-pop"
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
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-field"
                  >
                    <ProviderIcon provider={inst.provider} size={22} className={isCurrentProvider ? "text-accent" : "text-fg-2"} />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-1">{providerName(inst)}</span>
                    {!isExpanded && isCurrentProvider && props.currentModel && (
                      <span className="font-mono text-[10px] text-accent">{displayModel(inst, props.currentModel)}</span>
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
          {props.onManage && (
            <button
              onClick={() => { setOpen(false); props.onManage?.(); }}
              className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2 text-left text-[11px] text-fg-2 transition-colors hover:bg-field"
            >
              <span>{t("modelPicker.manage")}</span>
            </button>
          )}
      </Popover>
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
  const isManaged = props.inst.provider === "managed";
  const rows = modelsFor(props.inst);
  const q = props.query.trim().toLowerCase();
  const list = isManaged
    ? rows
    : q
      ? rows.filter((r) => `${r.id} ${r.meta?.displayName ?? ""}`.toLowerCase().includes(q))
      : rows;
  return (
    <div className="flex flex-col pb-1">
      {!isManaged && (
        <input
          ref={inputRef}
          aria-label={props.placeholder}
          value={props.query}
          onChange={(e) => props.setQuery(e.target.value)}
          placeholder={props.placeholder}
          className="mx-3.5 mb-1 rounded-chip border border-line bg-field px-2 py-1 text-[11px] text-fg-1 placeholder:text-fg-3 transition-colors focus:border-accent"
        />
      )}
      <div className="flex max-h-[240px] flex-col overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-3.5 py-1.5 pl-11 text-[11px] text-fg-3">{props.emptyText}</div>
        ) : (
          list.map((r) =>
            r.managed ? (
              <button
                key={r.id}
                onClick={() => props.onPick(r.id)}
                className={`flex items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-surface ${r.id === props.currentModel ? "bg-surface" : ""}`}
              >
                <span className="flex shrink-0 items-center justify-center" style={{ width: 22 }} aria-hidden>
                  {r.id === props.currentModel && (
                    <svg width="11" height="11" viewBox="0 0 11 11">
                      <path d="M2 5.5L4.5 8L9 3" fill="none" stroke="#B8C8D6" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="truncate text-[13px] font-medium text-fg-1">{r.managed.name}</span>
                  {r.managed.description && <span className="truncate text-[11px] text-fg-3">{r.managed.description}</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-[3px]">
                  <span className="flex h-4 items-center">
                    {r.managed.vision && <span className="rounded-full bg-line px-1.5 text-[9px] text-fg-3">{t("modelDropdown.vision")}</span>}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-[9px] text-fg-3">{t("managed.models.consumption")}</span>
                    <span className="flex items-center gap-[3px]">
                      {consumptionDots(r.managed.costLevel).map((on, i) => (
                        <span key={i} className={`h-1 w-1 rounded-full ${on ? "bg-fg-3" : "bg-line"}`} />
                      ))}
                    </span>
                  </span>
                </span>
              </button>
            ) : (
              <button
                key={r.id}
                onClick={() => props.onPick(r.id)}
                className={`flex items-center gap-2 px-3.5 py-1.5 pl-7 text-left transition-colors hover:bg-surface ${r.id === props.currentModel ? "bg-surface" : ""}`}
              >
                <span className="flex shrink-0 items-center justify-center" style={{ width: 13 }} aria-hidden>
                  {r.id === props.currentModel && (
                    <svg width="11" height="11" viewBox="0 0 11 11">
                      <path d="M2 5.5L4.5 8L9 3" fill="none" stroke="#B8C8D6" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-1">{r.id}</span>
                {r.meta?.vision && <span className="rounded-full bg-line px-1.5 text-[9px] text-fg-3">{t("modelDropdown.vision")}</span>}
                {r.meta?.tools && <span className="rounded-full bg-line px-1.5 text-[9px] text-fg-3">{t("modelDropdown.tools")}</span>}
              </button>
            ),
          )

        )}
      </div>
    </div>
  );
}
