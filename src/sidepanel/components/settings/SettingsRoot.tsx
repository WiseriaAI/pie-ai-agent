import { useEffect, useState, type ReactNode } from "react";
import {
  Box,
  Plug,
  Search,
  Contrast,
  Globe,
  MessageSquare,
  MousePointerClick,
  MessageCircle,
  Info,
  ChevronRight,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { listInstances } from "@/lib/instances";
import { getSearchProviderStatus, ACTIVE_SEARCH_PROVIDER } from "@/lib/search-provider";
import type { ThemeMode } from "@/sidepanel/theme";
import type { SettingsPage } from "@/sidepanel/components/TopBar";
import { queryBridgeStatus, type BridgeStatus } from "./bridge-status";

const ROW_ICON = { size: 16, strokeWidth: 1.75 } as const;

export interface SettingsRootProps {
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
  onOpenPage: (p: Exclude<SettingsPage, "root">) => void;
}

// ── A single drill-down / control row ─────────────────────────────────────────
function NavRow({
  id,
  icon,
  label,
  badge,
  onClick,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`settings-row-${id}`}
      onClick={onClick}
      className="flex h-[46px] w-full items-center gap-3 border-t border-line px-3.5 text-left first:border-t-0 hover:bg-field"
    >
      <span className="shrink-0 text-fg-2">{icon}</span>
      <span className="flex-1 text-[13px] font-medium text-fg-1">{label}</span>
      {badge != null && (
        <span data-testid={`settings-badge-${id}`} className="text-[12px] text-fg-3">
          {badge}
        </span>
      )}
      <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-fg-3" />
    </button>
  );
}

// A non-button row (for inline controls like the language selects / theme).
function ControlRow({ icon, label, control }: { icon: ReactNode; label: string; control: ReactNode }) {
  return (
    <div className="flex min-h-[46px] w-full items-center gap-3 border-t border-line px-3.5 first:border-t-0">
      <span className="shrink-0 text-fg-2">{icon}</span>
      <span className="flex-1 text-[13px] font-medium text-fg-1">{label}</span>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">{children}</div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 pb-1.5 font-mono text-[10px] font-medium tracking-[0.14em] text-fg-3">
      {children}
    </div>
  );
}

function ThemeSegmented({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
}) {
  const t = useT();
  return (
    <div className="flex gap-0.5 rounded-lg border border-line bg-field p-0.5">
      {(["light", "dark", "system"] as const).map((m) => (
        <button
          key={m}
          type="button"
          data-testid={`theme-${m}`}
          aria-pressed={themeMode === m}
          onClick={() => onThemeModeChange(m)}
          className={`rounded-md px-2.5 py-0.5 text-[11px] ${
            themeMode === m ? "bg-canvas font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"
          }`}
        >
          {t(`settings.theme.${m}`)}
        </button>
      ))}
    </div>
  );
}

export default function SettingsRoot({
  themeMode,
  onThemeModeChange,
  onOpenPage,
}: SettingsRootProps) {
  const t = useT();
  const [configCount, setConfigCount] = useState<number | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [searchName, setSearchName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listInstances().then((l) => {
      if (alive) setConfigCount(l.length);
    });
    void getSearchProviderStatus(ACTIVE_SEARCH_PROVIDER).then((s) => {
      if (alive) setSearchName(s.configured ? "Tavily" : null);
    });
    queryBridgeStatus((s) => {
      if (alive) setBridge(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const bridgeBadge =
    bridge && bridge.hasPermission ? (
      <span className="flex items-center gap-1.5">
        {bridge.ready && (
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        )}
        {bridge.ready ? t("settings.nav.bridgeConnected") : t("settings.nav.bridgeOff")}
      </span>
    ) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {/* Group 1 — basics (core subsystems + CDP) */}
      <div>
        <GroupLabel>{t("settings.nav.basics")}</GroupLabel>
        <Group>
          <NavRow
            id="models"
            icon={<Box {...ROW_ICON} />}
            label={t("settings.nav.models")}
            badge={
              configCount != null
                ? t("settings.nav.configCount", { count: String(configCount) })
                : undefined
            }
            onClick={() => onOpenPage("models")}
          />
          <NavRow
            id="bridge"
            icon={<Plug {...ROW_ICON} />}
            label={t("settings.nav.bridge")}
            badge={bridgeBadge}
            onClick={() => onOpenPage("bridge")}
          />
          <NavRow
            id="search"
            icon={<Search {...ROW_ICON} />}
            label={t("settings.nav.search")}
            badge={searchName ?? undefined}
            onClick={() => onOpenPage("search")}
          />
          <NavRow
            id="cdp"
            icon={<MousePointerClick {...ROW_ICON} />}
            label={t("settings.cdpInput.title")}
            onClick={() => onOpenPage("cdp")}
          />
        </Group>
      </div>

      {/* Group 2 — preferences */}
      <div>
        <GroupLabel>{t("settings.nav.preferences")}</GroupLabel>
        <Group>
          <ControlRow
            icon={<Contrast {...ROW_ICON} />}
            label={t("settings.theme.label")}
            control={<ThemeSegmented themeMode={themeMode} onThemeModeChange={onThemeModeChange} />}
          />
          <NavRow
            id="uiLanguage"
            icon={<Globe {...ROW_ICON} />}
            label={t("settings.language.uiLabel")}
            onClick={() => onOpenPage("uiLanguage")}
          />
          <NavRow
            id="assistantLanguage"
            icon={<MessageSquare {...ROW_ICON} />}
            label={t("settings.language.assistantLabel")}
            onClick={() => onOpenPage("assistantLanguage")}
          />
        </Group>
      </div>

      {/* Group 3 — other */}
      <Group>
        <NavRow
          id="feedback"
          icon={<MessageCircle {...ROW_ICON} />}
          label={t("settings.nav.feedback")}
          onClick={() => onOpenPage("feedback")}
        />
        <NavRow
          id="about"
          icon={<Info {...ROW_ICON} />}
          label={t("settings.nav.about")}
          badge={`v${chrome.runtime.getManifest().version}`}
          onClick={() => onOpenPage("about")}
        />
      </Group>
    </div>
  );
}
