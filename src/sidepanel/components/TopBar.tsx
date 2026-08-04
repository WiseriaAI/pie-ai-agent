import { useRef, useState } from "react";
import { Menu, Plus, AlarmClock, Zap, ArrowLeft, Pin, Star, ChevronDown } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { Popover } from "./ui/Popover";
import { useAnchorRect } from "./ui/useAnchorRect";
import PinnedTabDropdown from "./PinnedTabDropdown";
import { usePinDisplay } from "@/sidepanel/hooks/usePinDisplay";
import { useT } from "@/lib/i18n";

export type AppView = "agent" | "schedules" | "skills" | "settings";
export type SettingsPage =
  | "root"
  | "models"
  | "bridge"
  | "search"
  | "uiLanguage"
  | "assistantLanguage"
  | "customRules"
  | "feedback"
  | "about";

// Sub-page → top-bar title key. The language pages reuse their feature keys
// instead of minting settings.nav.* duplicates.
const SETTINGS_PAGE_TITLE_KEY = {
  models: "settings.nav.models",
  bridge: "settings.nav.bridge",
  search: "settings.nav.search",
  uiLanguage: "settings.language.uiLabel",
  assistantLanguage: "settings.language.assistantLabel",
  customRules: "settings.nav.customRules",
  feedback: "settings.nav.feedback",
  about: "settings.nav.about",
} as const;

export interface TopBarProps {
  view: AppView;
  settingsPage: SettingsPage;
  sessionTitle: string;
  pendingCount: number;
  onToggleDrawer: () => void;
  onNewSession: () => void;
  onNavigate: (v: "schedules" | "skills") => void;
  onBack: () => void;
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  pinMode: "auto" | "task" | "user" | null;
  streaming: boolean;
  onTogglePinTab: (tabId: number, origin: string) => void;
  onClearUserPin: () => void;
}

const ICON = { size: 17, strokeWidth: 1.75 } as const;

export default function TopBar({
  view,
  settingsPage,
  sessionTitle,
  pendingCount,
  onToggleDrawer,
  onNewSession,
  onNavigate,
  onBack,
  pinnedTabs,
  pinMode,
  streaming,
  onTogglePinTab,
  onClearUserPin,
}: TopBarProps) {
  const t = useT();
  const isChat = view === "agent";
  const { displayPinnedOrigin, isLocked } = usePinDisplay({ pinnedTabs, pinMode, streaming });
  const showPinRow = isChat && displayPinnedOrigin !== null;

  const [pinOpen, setPinOpen] = useState(false);
  const pinRowRef = useRef<HTMLButtonElement>(null);
  const pinRect = useAnchorRect(pinRowRef, pinOpen);
  const pinStyle = pinRect
    ? { left: pinRect.left, top: pinRect.bottom + 4, width: pinRect.width }
    : undefined;

  const title = isChat
    ? sessionTitle
    : view === "schedules"
      ? t("schedules.title")
      : view === "skills"
        ? t("topbar.skills")
        : settingsPage === "root"
          ? t("settings.title")
          : t(SETTINGS_PAGE_TITLE_KEY[settingsPage]);

  const showFnButtons = view !== "settings";

  return (
    <div className="z-10 flex flex-shrink-0 flex-col border-b border-line bg-canvas px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        {isChat ? (
          <>
            <div className="relative">
              <IconButton
                data-testid="topbar-drawer"
                size="sm"
                aria-label={t("topBar.openSessionsList")}
                icon={<Menu {...ICON} />}
                onClick={onToggleDrawer}
              />
              {pendingCount > 0 && (
                <span
                  data-testid="topbar-pending-dot"
                  className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--c-pending)" }}
                />
              )}
            </div>
            <IconButton
              data-testid="topbar-new"
              size="sm"
              aria-label={t("topBar.newSession")}
              icon={<Plus {...ICON} />}
              onClick={() => onNewSession()}
            />
          </>
        ) : (
          <IconButton
            data-testid="topbar-back"
            size="sm"
            aria-label={t("topbar.back")}
            icon={<ArrowLeft {...ICON} />}
            onClick={onBack}
          />
        )}
        <span
          className={`min-w-0 flex-1 select-none truncate text-[13px] text-fg-1 ${
            isChat ? "font-medium" : "font-semibold"
          }`}
          title={title}
        >
          {title}
        </span>
        {showFnButtons && (
          <>
            <IconButton
              data-testid="topbar-schedules"
              size="sm"
              aria-label={t("schedules.title")}
              aria-pressed={view === "schedules"}
              active={view === "schedules"}
              icon={<AlarmClock {...ICON} />}
              onClick={() => onNavigate("schedules")}
            />
            <IconButton
              data-testid="topbar-skills"
              size="sm"
              aria-label={t("topbar.skills")}
              aria-pressed={view === "skills"}
              active={view === "skills"}
              icon={<Zap {...ICON} />}
              onClick={() => onNavigate("skills")}
            />
          </>
        )}
      </div>

      {showPinRow && (
        <>
          <button
            ref={pinRowRef}
            type="button"
            data-testid="topbar-pin-row"
            aria-label={t("chat.pinnedTabSelector")}
            aria-expanded={pinOpen}
            onClick={() => setPinOpen((v) => !v)}
            className="mt-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-field"
          >
            {pinMode === "user" ? (
              <Star size={13} strokeWidth={1.75} className="shrink-0 text-accent" fill="currentColor" />
            ) : (
              <Pin
                size={13}
                strokeWidth={1.75}
                className={`shrink-0 ${isLocked ? "text-accent" : "text-fg-2"}`}
                fill={isLocked ? "currentColor" : "none"}
              />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2">
              {displayPinnedOrigin}
            </span>
            {pinnedTabs && pinnedTabs.length > 1 && (
              <span className="rounded bg-accent-tint px-1 font-mono text-[10px] text-accent">
                ×{pinnedTabs.length}
              </span>
            )}
            <ChevronDown size={11} strokeWidth={1.75} className="shrink-0 text-fg-3" />
          </button>
          <Popover open={pinOpen && !!pinStyle} style={pinStyle} placement="below" className="fixed z-20">
            <PinnedTabDropdown
              anchorRef={pinRowRef}
              pinMode={pinMode}
              pinnedTabs={pinnedTabs}
              streaming={streaming}
              onToggle={(tabId, origin) => onTogglePinTab(tabId, origin)}
              onClearPin={onClearUserPin}
              onClose={() => setPinOpen(false)}
            />
          </Popover>
        </>
      )}
    </div>
  );
}
