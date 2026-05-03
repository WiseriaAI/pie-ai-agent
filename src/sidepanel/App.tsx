import { useState, useEffect, useCallback } from "react";
import Chat from "@/sidepanel/components/Chat";
import Settings from "@/sidepanel/components/Settings";
import SessionDrawer from "@/sidepanel/components/SessionDrawer";
import TopBarListButton from "@/sidepanel/components/TopBarListButton";
import TopBarNewSessionButton from "@/sidepanel/components/TopBarNewSessionButton";
import TopBarSettingsButton from "@/sidepanel/components/TopBarSettingsButton";
import TopBarThemeButton, { type ThemeMode } from "@/sidepanel/components/TopBarThemeButton";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";
import { getProviderMeta } from "@/lib/model-router";
import { normalizeSkillSlashKey } from "@/lib/skills";
import { useSession } from "@/sidepanel/hooks/useSession";
import { listSessionIndex } from "@/lib/sessions/storage";
import { hardDeleteExpired } from "@/lib/sessions/lifecycle";
import type { SessionIndexEntry, SessionAgentState } from "@/lib/sessions/types";

type View = "agent" | "settings";

/**
 * App — root component.
 *
 * M2-U2 changes:
 * - New top bar: [≡●] [+] {sessionTitle} ─── [settings icon]
 * - SessionDrawer overlay for session list
 * - activeSessionId managed via useSession.setActive / createAndActivate
 * - pendingCount computed from storage (sessions with live pendingConfirm)
 * - Settings → handleRunSkill detects archived session + auto-creates new one
 *
 * Hook lives at App level so the SW port + onMessage listener survive
 * Chat unmounts (Settings sub-view swap). Plan M1-U2 root-cause #1 fix.
 */
export default function App() {
  const [view, setView] = useState<View>("agent");
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [chatPrefill, setChatPrefill] = useState<string | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  // M1: theme mode owned at App level so the button reflects state and we
  // can persist to localStorage. M2 will wire data-theme to actually switch.
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("theme-mode");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });

  // M2: Apply theme-mode to document root, persist, and mirror to
  // chrome.storage.local for cross-window sync.
  // - 'light' / 'dark' → set dataset.theme so the [data-theme] CSS overrides win
  // - 'system' → delete dataset.theme, falling back to prefers-color-scheme
  useEffect(() => {
    if (themeMode === "light" || themeMode === "dark") {
      document.documentElement.dataset.theme = themeMode;
    } else {
      delete document.documentElement.dataset.theme;
    }
    localStorage.setItem("theme-mode", themeMode);
    void chrome.storage.local.set({ "theme-mode": themeMode });
  }, [themeMode]);

  const session = useSession();

  // ── Load session index ────────────────────────────────────────────────────
  // Maintained by storage onChanged so the drawer refreshes when SW writes
  // session state (status transitions, new sessions, etc.)
  const refreshSessionIndex = useCallback(async () => {
    const list = await listSessionIndex();
    setSessions(list);
  }, []);

  // ── Compute pendingCount ──────────────────────────────────────────────────
  // Count sessions whose session_${id}_agent has pendingConfirm != null.
  // Maintains a local cache updated via onChanged rather than polling.
  const refreshPendingCount = useCallback(async () => {
    const all = await chrome.storage.local.get(null);
    let count = 0;
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("session_") || !key.endsWith("_agent")) continue;
      const agentState = value as SessionAgentState | null | undefined;
      if (agentState?.pendingConfirm != null) {
        count++;
      }
    }
    setPendingCount(count);
  }, []);

  useEffect(() => {
    // M2-U4: opportunistic 30-day hard-delete sweep on sidepanel mount.
    // Fire-and-forget — does not block mount or session loading.
    hardDeleteExpired().catch((e) => {
      console.warn("[panel] hardDeleteExpired sweep failed:", e);
    });

    // Initial load
    void refreshSessionIndex();
    void refreshPendingCount();

    // firstRun → open settings
    chrome.storage.local.get("firstRun", (result) => {
      if (result.firstRun) {
        setView("settings");
        chrome.storage.local.remove("firstRun");
      }
    });

    loadProviderLabel();

    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      // Refresh provider label if provider config changed
      if (changes.active_provider || Object.keys(changes).some((k) => k.startsWith("provider_"))) {
        loadProviderLabel();
      }
      // Refresh session index if session_index or any session key changed
      const hasSessionChange = Object.keys(changes).some(
        (k) => k === "session_index" || k.startsWith("session_"),
      );
      if (hasSessionChange) {
        void refreshSessionIndex();
        void refreshPendingCount();
      }
      // M2: cross-window theme sync. Guard against feedback loop by only
      // updating state when the new value differs from current (the writer
      // window's setState already handled its own update).
      if (changes["theme-mode"]) {
        const next = changes["theme-mode"].newValue;
        if (next === "light" || next === "dark" || next === "system") {
          setThemeMode((prev) => (prev === next ? prev : next));
        }
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, [refreshSessionIndex, refreshPendingCount]);

  async function loadProviderLabel() {
    const active = await getActiveProvider();
    if (!active) {
      setProviderLabel(null);
      return;
    }
    try {
      const config = await getProviderConfig(active);
      if (config) {
        const meta = getProviderMeta(active);
        const name = meta?.name ?? active;
        setProviderLabel(`${name} · ${config.model}`);
      } else {
        setProviderLabel(null);
      }
    } catch {
      setProviderLabel(null);
    }
  }

  // ── handleRunSkill (R23 — archived session auto-creates new) ─────────────
  async function handleRunSkill(skillId: string, skillName: string) {
    const slug = normalizeSkillSlashKey(skillName);
    const key = slug.length > 0 ? slug : skillId;
    const prefill = `/${key}`;

    // R23: if active session is archived, auto-create a new one before
    // dispatching the slash command so the user doesn't type into a dead session.
    const activeEntry = sessions.find((s) => s.id === session.sessionId);
    if (activeEntry?.status === "archived") {
      const newId = await session.createAndActivate();
      if (newId == null) return; // streaming guard blocked creation
    }

    setChatPrefill(prefill);
    setView("agent");
  }

  // ── Drawer handlers ───────────────────────────────────────────────────────
  // P1-5 — stable identity so SessionDrawer focus-trap effect doesn't re-fire
  // on every parent render (storage onChanged events drive App re-render
  // frequently while drawer is open; inline arrow would thrash preFocusRef).
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), []);

  const handleSelectSession = useCallback(async (id: string) => {
    const ok = await session.setActive(id);
    // P1-3: if setActive returned null (refused because streaming=true),
    // keep the drawer open — the streaming guard in setActive already emits
    // nothing; we let the P0-1 createAndActivate guard's toast guide the user.
    // Only close the drawer when the switch actually succeeded.
    if (ok != null) setDrawerOpen(false);
  }, [session]);

  // P1-8 — capture `id` in closure. Without this, a race where createAndActivate
  // runs between setActive resolution and the .then microtask could cause
  // resumeTask to fire on the wrong session (sessionIdRef already updated to
  // the new session). Guard: verify result === id AND session.sessionId === id
  // before calling resumeTask.
  const handleResumeSession = useCallback(async (id: string) => {
    const result = await session.setActive(id);
    if (result === id && session.sessionId === id) {
      // setActive updated sessionIdRef synchronously; resumeTask reads it.
      session.resumeTask();
    }
    // Close drawer only if we actually switched to the session.
    if (result === id) setDrawerOpen(false);
  }, [session]);

  // ── New session ───────────────────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    const newId = await session.createAndActivate();
    if (newId == null) return; // refused due to streaming — toast already emitted
    setDrawerOpen(false);
  }, [session]);

  // ── Session title for top bar ─────────────────────────────────────────────
  const activeSessionEntry = sessions.find((s) => s.id === session.sessionId);
  const sessionTitle = activeSessionEntry?.title ?? (session.sessionId ? "New Session" : "…");

  return (
    <div
      className="bg-canvas text-fg-1 dot-grid flex h-screen flex-col"
      style={{ position: "relative", overflow: "hidden" }}
    >
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          borderBottom: "1px solid var(--c-line)",
          flexShrink: 0,
          background: "var(--c-canvas)",
          zIndex: 10,
        }}
      >
        {/* ≡ drawer toggle with pending dot */}
        <TopBarListButton
          pendingCount={pendingCount}
          isOpen={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        />

        {/* + new session */}
        <TopBarNewSessionButton onClick={() => void handleNewSession()} />

        {/* Session title — pure text, not a button */}
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--c-fg-1)",
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            userSelect: "none",
          }}
          title={sessionTitle}
        >
          {sessionTitle}
        </span>

        {/* Theme toggle (light / dark / system cycle) */}
        <TopBarThemeButton mode={themeMode} onModeChange={setThemeMode} />

        {/* Settings */}
        <TopBarSettingsButton
          isActive={view === "settings"}
          onClick={() => setView(view === "settings" ? "agent" : "settings")}
        />
      </div>

      {/* ── Main content area ─────────────────────────────────────────────── */}
      {/* key={view} forces remount on switch so .view-enter keyframe replays.
          The wrapper inherits flex layout from the outer container. */}
      <div
        key={view}
        className="view-enter"
        style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        {view === "agent" ? (
          <Chat
            providerLabel={providerLabel}
            onOpenSettings={() => setView("settings")}
            prefillInput={chatPrefill}
            onPrefillConsumed={() => setChatPrefill(undefined)}
            session={session}
          />
        ) : (
          <Settings
            onBack={() => setView("agent")}
            onRunSkill={(id, name) => void handleRunSkill(id, name)}
          />
        )}
      </div>

      {/* ── Session drawer (overlay) ──────────────────────────────────────── */}
      <SessionDrawer
        isOpen={drawerOpen}
        onClose={handleCloseDrawer}
        sessions={sessions}
        activeSessionId={session.sessionId}
        onSelectSession={handleSelectSession}
        onResumeSession={handleResumeSession}
      />
    </div>
  );
}
