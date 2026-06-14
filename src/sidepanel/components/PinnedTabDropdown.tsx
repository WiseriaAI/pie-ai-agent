// v1.5 — PinnedTabDropdown (multi-select)
//
// Opens from the PINNED row's button in the top bar. Lists every tab in the
// current window plus an "Auto" item at the top.
//
// Multi-select mode (v1.5): each tab row TOGGLES its membership in
// pinnedTabs[] without closing the dropdown, so the user can pin multiple
// tabs. The "Auto" row clears all pins and closes. ESC / outside-click
// also close without changing the pin state.
//
// Lifecycle: visibility is owned by Chat.tsx, which wraps this in a portaled
// <Popover> (open → mount + enter animation; close → leave animation, then
// unmount). It self-fetches the tab list on mount via
// chrome.tabs.query({currentWindow: true}) — so each open re-fetches; no event
// subscription needed since the user typically picks immediately.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useT } from "@/lib/i18n";
import type { PinMode } from "@/lib/sessions/pin-state";

interface TabRow {
  id: number;
  title: string;
  /** URL.host (preserves IDN punycode form). */
  host: string;
  /** URL.origin used as the pin origin. */
  origin: string;
  active: boolean;
}

interface PinnedTabDropdownProps {
  /** Currently active session's pin mode. Drives "Auto" item enabled state. */
  pinMode: PinMode | null;
  /** Currently pinned tabs array (v1.5 multi-select). null for auto mode. */
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  /** Streaming flag — disables interactions while a task is in flight. */
  streaming: boolean;
  /** User toggled a tab row → caller toggles its membership in pinnedTabs[].
   *  Dropdown stays OPEN for multi-select. */
  onToggle: (tabId: number, origin: string) => void;
  /** User picked "Auto" → caller writes meta with pinMode='auto'. */
  onClearPin: () => void;
  /** ESC / outside click / Auto row click → caller closes the dropdown. The
   *  parent's <Popover> wrapper then plays the leave animation and unmounts —
   *  this component no longer owns any open/leave animation state. */
  onClose: () => void;
  /** The anchor button that toggles this dropdown. Outside-click ignores
   *  clicks landing on it, so the anchor's own onClick owns the toggle —
   *  otherwise a mousedown-close races a click-open and the panel flickers. */
  anchorRef?: RefObject<HTMLButtonElement | null>;
}

const RESTRICTED_PIN_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "file://",
  "data:",
  "javascript:",
  "blob:",
];

function tabIsPinnable(url: string | undefined): boolean {
  if (!url) return false;
  if (RESTRICTED_PIN_PREFIXES.some((p) => url.startsWith(p))) return false;
  try {
    const o = new URL(url).origin;
    if (!o || o === "null") return false;
    return true;
  } catch {
    return false;
  }
}

export default function PinnedTabDropdown({
  pinMode,
  pinnedTabs,
  streaming,
  onToggle,
  onClearPin,
  onClose,
  anchorRef,
}: PinnedTabDropdownProps) {
  const [tabs, setTabs] = useState<TabRow[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useT();

  // v1.5 — set of currently pinned tabIds for O(1) membership check in render.
  const pinnedSet = useMemo(
    () => new Set((pinnedTabs ?? []).map((p) => p.tabId)),
    [pinnedTabs],
  );

  // Fetch tab list on mount.
  // TODO(v1.5.1): tab list is mount-only — doesn't refresh while dropdown is
  // open. Consider subscribing to chrome.tabs.onCreated/onRemoved/onUpdated
  // for the dropdown's lifetime so the list stays current under multi-select
  // usage. Pre-existing pre-multi-select but more visible now since the
  // dropdown stays open across multiple toggles.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await chrome.tabs.query({ currentWindow: true });
        if (cancelled) return;
        const rows: TabRow[] = [];
        for (const t of all) {
          if (typeof t.id !== "number" || t.id < 0) continue;
          if (!t.url) continue;
          if (!tabIsPinnable(t.url)) continue;
          let host = "";
          let origin = "";
          try {
            const u = new URL(t.url);
            host = u.host;
            origin = u.origin;
          } catch {
            continue;
          }
          rows.push({
            id: t.id,
            title: t.title ?? host,
            host,
            origin,
            active: !!t.active,
          });
        }
        setTabs(rows);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ESC + outside click closes dropdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // Clicks on the anchor button are handled by its own onClick toggle —
      // closing here too would relaunch the open→close→open flicker.
      if (anchorRef?.current?.contains(target)) return;
      if (containerRef.current && !containerRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Defer mousedown so the open-click doesn't immediately close.
    const t = setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose, anchorRef]);

  const isUserMode = pinMode === "user";
  const isTaskMode = pinMode === "task";

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t("pinnedTab.selector")}
      className="max-h-[60vh] overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
    >
      <div className="border-b border-line bg-canvas px-3.5 py-2">
        <div className="text-[11px] uppercase tracking-[0.08em] text-fg-3">
          {t("pinnedTab.header")}
        </div>
        {isTaskMode && (
          <div className="mt-1 text-[11px] text-fg-3">
            {t("pinnedTab.taskLockedHint")}
          </div>
        )}
        {/* v1.5 — multi-select hint */}
        {isUserMode && pinnedTabs && pinnedTabs.length > 0 && (
          <div className="mt-1 text-[11px] text-fg-3">
            {pinnedTabs.length} tab{pinnedTabs.length > 1 ? "s" : ""}{" "}
            {t("pinnedTab.pinnedHint")}
          </div>
        )}
      </div>

      <ul
        role="listbox"
        className="max-h-[50vh] divide-y divide-line overflow-auto"
      >
        {/* Auto item */}
        <li
          role="option"
          aria-selected={pinMode === "auto"}
          aria-disabled={isTaskMode || streaming}
          onMouseDown={(e) => {
            e.preventDefault();
            if (isTaskMode || streaming) return;
            onClearPin();
            onClose();
          }}
          className={`flex cursor-pointer items-center gap-2 px-3.5 py-2.5 ${
            isTaskMode || streaming
              ? "cursor-not-allowed opacity-50"
              : "hover:bg-field"
          } ${pinMode === "auto" ? "bg-accent-tint" : ""}`}
        >
          <div className="w-4 text-center text-[12px] text-accent">
            {pinMode === "auto" ? "✓" : ""}
          </div>
          <div className="flex-1">
            <div className="text-[13px] text-fg-1">{t("pinnedTab.autoTitle")}</div>
            <div className="text-[11px] text-fg-3">
              {t("pinnedTab.autoDesc")}
            </div>
          </div>
        </li>

        {/* Tab items */}
        {loading ? (
          <li className="px-3.5 py-2 text-[12px] text-fg-3">{t("pinnedTab.loadingTabs")}</li>
        ) : tabs.length === 0 ? (
          <li className="px-3.5 py-2 text-[12px] text-fg-3">
            {t("pinnedTab.noPinnableTabs")}
          </li>
        ) : (
          tabs.map((t) => {
            // v1.5 — selected = in pinnedSet AND user mode (task mode pins are
            // shown read-only checkmarks; auto mode shows none).
            const selected = pinnedSet.has(t.id) && isUserMode;
            const disabled = isTaskMode || streaming;
            return (
              <li
                key={t.id}
                role="option"
                aria-selected={selected}
                aria-disabled={disabled}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (disabled) return;
                  // v1.5 — toggle membership; do NOT close the dropdown so the
                  // user can continue adding/removing pins. onClose fires only
                  // for the "Auto" row, ESC, and outside-click.
                  onToggle(t.id, t.origin);
                }}
                className={`flex cursor-pointer items-center gap-2 px-3.5 py-2 ${
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "hover:bg-field"
                } ${selected ? "bg-accent-tint" : ""}`}
              >
                <div className="w-4 text-center text-[12px] text-accent">
                  {selected ? "✓" : ""}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-fg-1">
                    {t.title || t.host}
                  </div>
                  <div className="truncate font-mono text-[10px] text-fg-3">
                    {t.host}
                    {t.active ? <span className="ml-2 text-accent">(active)</span> : null}
                  </div>
                </div>
              </li>
            );
          })
        )}
      </ul>

      <div className="flex items-center gap-3 border-t border-line bg-canvas px-3.5 py-1.5 font-mono text-[10px] tracking-[0.08em] text-fg-3">
        <span>{t("pinnedTab.escToClose")}</span>
        {pinMode !== null && <span>{t("pinnedTab.mode")} {pinMode}</span>}
      </div>
    </div>
  );
}
