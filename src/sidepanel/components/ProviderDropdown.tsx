import { useState, useEffect } from "react";
import type { ProviderRef } from "@/lib/model-router";
import type { ProviderMeta } from "@/lib/model-router/providers/registry";
import type { StoredCustomProvider } from "@/lib/custom-providers";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import { useT, providerDisplayName } from "@/lib/i18n";
import ProviderIcon from "./ProviderIcon";

interface Props {
  value: ProviderRef | null;
  builtinProviders: ProviderMeta[];
  customProviders: StoredCustomProvider[];
  onSelect: (ref: ProviderRef) => void;
  onCreateCustom: () => void;
  onEditCustom: (cp: StoredCustomProvider) => void;
  onDeleteCustom: (cp: StoredCustomProvider) => void;
}

export default function ProviderDropdown(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Reset search when dropdown closes so reopening doesn't show stale filter
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Resolve the display name for the current value
  const selectedName = (() => {
    if (!props.value) return null;
    if (props.value.startsWith(CUSTOM_PREFIX)) {
      const found = props.customProviders.find(
        (c) => `${CUSTOM_PREFIX}${c.id}` === props.value,
      );
      return found?.name ?? null;
    }
    const found = props.builtinProviders.find((p) => p.id === props.value);
    return found ? providerDisplayName(found, t) : null;
  })();

  // Search filter — case-insensitive substring on name + baseUrl
  const q = query.trim().toLowerCase();

  const filteredBuiltins =
    q.length === 0
      ? props.builtinProviders
      : props.builtinProviders.filter((p) => {
          const hay = `${providerDisplayName(p, t)} ${p.defaultBaseUrl}`.toLowerCase();
          return hay.includes(q);
        });

  const filteredCustoms =
    q.length === 0
      ? props.customProviders
      : props.customProviders.filter((c) => {
          const hay = `${c.name} ${c.baseUrl}`.toLowerCase();
          return hay.includes(q);
        });

  return (
    <div className="flex flex-col gap-1.5">
      <button
        aria-label={selectedName ?? t("providerDropdown.selectProvider")}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-[10px] border border-transparent bg-field px-3 py-2.5 text-left text-[13px] text-fg-1 hover:border-line"
      >
        {props.value && <ProviderIcon provider={props.value} size={16} className="text-fg-1" />}
        <span>{selectedName ?? t("providerDropdown.selectProvider")}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="ml-auto text-fg-3" style={{ transform: open ? "rotate(180deg)" : "none" }}>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="scale-in origin-top flex flex-col rounded-[10px] border border-line bg-surface">
          {/* Search input */}
          <div className="border-b border-line p-2">
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("providerDropdown.searchPlaceholder")}
              className="w-full rounded-[8px] border border-transparent bg-field px-2.5 py-1.5 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
            />
          </div>

          {/* Scrollable list */}
          <div className="flex max-h-[280px] flex-col overflow-y-auto">
            {/* Built-in group (only when non-empty after filter) */}
            {filteredBuiltins.length > 0 && (
              <>
                <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                  {t("providerDropdown.builtinGroup")}
                </div>
                {filteredBuiltins.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      props.onSelect(p.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-field ${p.id === props.value ? "bg-accent-tint" : ""}`}
                  >
                    <ProviderIcon provider={p.id} size={18} className="text-fg-2" />
                    <span className="text-fg-1">{providerDisplayName(p, t)}</span>
                    <span className="ml-auto font-mono text-[10px] text-fg-3">
                      {p.defaultBaseUrl.replace(/^https?:\/\//, "")}
                    </span>
                  </button>
                ))}
              </>
            )}

            {/* Custom group (only when non-empty after filter) */}
            {filteredCustoms.length > 0 && (
              <>
                <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                  {t("providerDropdown.customGroup")}
                </div>
                {filteredCustoms.map((cp) => {
                  const ref: ProviderRef = `${CUSTOM_PREFIX}${cp.id}`;
                  return (
                    <div
                      key={cp.id}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-[13px] hover:bg-field ${ref === props.value ? "bg-accent-tint" : ""}`}
                    >
                      <button
                        className="flex flex-1 items-center gap-2 text-left"
                        onClick={() => {
                          props.onSelect(ref);
                          setOpen(false);
                        }}
                      >
                        <ProviderIcon provider={ref} size={18} className="text-fg-2" />
                        <span className="text-fg-1">{cp.name}</span>
                        <span className="ml-auto font-mono text-[10px] text-fg-3">
                          {cp.baseUrl.replace(/^https?:\/\//, "")}
                        </span>
                      </button>
                      <button
                        aria-label={t("providerDropdown.editProvider")}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onEditCustom(cp);
                          setOpen(false);
                        }}
                        className="flex items-center shrink-0 text-fg-3 hover:text-fg-1"
                      >
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M9.5 2.5L11.5 4.5L5 11L2.5 11.5L3 9L9.5 2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>
                      </button>
                      <button
                        aria-label={t("providerDropdown.deleteProvider")}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDeleteCustom(cp);
                          setOpen(false);
                        }}
                        className="flex items-center shrink-0 text-fg-3 hover:text-warning"
                      >
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 4H11.5M5 4V2.8C5 2.4 5.3 2 5.8 2H8.2C8.7 2 9 2.4 9 2.8V4M10 4V11C10 11.5 9.7 12 9.2 12H4.8C4.3 12 4 11.5 4 11V4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Fixed footer */}
          <div className="border-t border-line">
            <button
              onClick={() => {
                props.onCreateCustom();
                setOpen(false);
              }}
              className="w-full px-3 py-2.5 text-left text-[12px] text-accent hover:bg-field"
            >
              {t("providerDropdown.newCustomProvider")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
