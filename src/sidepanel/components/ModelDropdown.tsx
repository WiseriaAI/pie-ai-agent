import { useState, useEffect } from "react";
import type { ProviderRef, ModelMeta, BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";

interface Props {
  provider: ProviderRef;
  value: string;
  customModels: string[];
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  onChange: (modelId: string) => void;
  onAddCustom?: (modelId: string) => void;
  onRemoveCustom?: (modelId: string) => void;
  onRefresh: () => void;
}

export default function ModelDropdown(props: Props) {
  const meta = props.provider.startsWith(CUSTOM_PREFIX) ? undefined : getProviderMeta(props.provider as BuiltinProvider);
  const registryModels = meta?.models ?? [];
  const fetched = props.fetchedModels ?? [];
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  // Lazy fetch on first open if registry empty and no fetched cache
  useEffect(() => {
    if (open && registryModels.length === 0 && fetched.length === 0 && !props.isFetching) {
      props.onRefresh();
    }
  }, [open, registryModels.length, fetched.length, props.isFetching]);

  // Reset search when dropdown closes so reopening doesn't show stale filter
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Combined dedup'd full list (registry → fetched → customModels; first wins on id collision)
  const baseList: { id: string; meta?: ModelMeta; isCustom: boolean }[] = [
    ...registryModels.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...fetched.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...props.customModels.map((id) => ({ id, isCustom: true })),
  ];
  const seen = new Set<string>();
  const fullList = baseList.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));

  // Search filter — case-insensitive substring on id (and displayName when present)
  const q = query.trim().toLowerCase();
  const list = q.length === 0
    ? fullList
    : fullList.filter((x) => {
        const hay = `${x.id} ${x.meta?.displayName ?? ""}`.toLowerCase();
        return hay.includes(q);
      });

  const isLazy = registryModels.length === 0;
  const showSearch = fullList.length > 8 || isLazy;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        aria-label={props.value || "(选择模型)"}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded border border-line bg-field px-3 py-2 text-left text-[12px] text-fg-1 hover:border-fg-3"
      >
        <span className="font-mono">{props.value || "(选择模型)"}</span>
        <span className="ml-auto text-fg-3">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="flex flex-col rounded border border-line bg-surface">
          {/* Fixed header — refresh row (lazy only) + search input */}
          {(isLazy || showSearch) && (
            <div className="flex flex-col gap-1.5 border-b border-line p-2">
              {isLazy && (
                <div className="flex items-center justify-between text-[10px] text-fg-3">
                  <span className="font-mono">{props.fetchedAt ? new Date(props.fetchedAt).toLocaleString() : "未拉取"}</span>
                  <button onClick={() => props.onRefresh()} className="hover:text-fg-1">
                    {props.isFetching ? "拉取中…" : "↻ 刷新"}
                  </button>
                </div>
              )}
              {showSearch && (
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`搜索 ${fullList.length} 个模型…`}
                  className="rounded border border-line bg-field px-2 py-1 text-[11px] text-fg-1 placeholder:text-fg-3"
                />
              )}
            </div>
          )}

          {/* Scrollable model list */}
          <div className="flex max-h-[280px] flex-col overflow-y-auto">
            {list.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-fg-3">
                {props.isFetching
                  ? "拉取中…"
                  : q.length > 0
                    ? `无匹配 (${fullList.length} total)`
                    : "(空 — 用 + 添加自定义)"}
              </div>
            ) : (
              list.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { props.onChange(m.id); setOpen(false); }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-field ${m.id === props.value ? "bg-field" : ""}`}
                >
                  <span className="font-mono text-fg-1">{m.id}</span>
                  {m.meta?.vision && <span className="rounded bg-line px-1 text-[9px] text-fg-3">vision</span>}
                  {m.meta?.tools && <span className="rounded bg-line px-1 text-[9px] text-fg-3">tools</span>}
                  {m.isCustom && (
                    <>
                      <span className="rounded bg-line px-1 text-[9px] text-fg-3">custom</span>
                      {props.onRemoveCustom && (
                        <span
                          onClick={(e) => { e.stopPropagation(); props.onRemoveCustom!(m.id); }}
                          className="ml-auto text-fg-3 hover:text-warning"
                        >
                          ×
                        </span>
                      )}
                    </>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Fixed footer — + 添加自定义模型 (hidden for custom providers since models are defined there) */}
          {!props.provider.startsWith(CUSTOM_PREFIX) && (
          <div className="border-t border-line">
            {!adding ? (
              <button
                onClick={() => setAdding(true)}
                className="w-full px-3 py-2 text-left text-[11px] text-accent hover:bg-field"
              >
                + 添加自定义模型
              </button>
            ) : (
              <div className="flex gap-1.5 p-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="model id"
                  className="flex-1 rounded border border-line bg-field px-2 py-1 font-mono text-[11px] text-fg-1"
                />
                <button
                  disabled={!draft.trim()}
                  onClick={() => { props.onAddCustom?.(draft.trim()); setDraft(""); setAdding(false); }}
                  className="rounded bg-fg-1 px-2 py-1 text-[10px] text-canvas disabled:opacity-30"
                >
                  保存
                </button>
                <button
                  onClick={() => { setDraft(""); setAdding(false); }}
                  className="rounded border border-line px-2 py-1 text-[10px] text-fg-3"
                >
                  取消
                </button>
              </div>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
