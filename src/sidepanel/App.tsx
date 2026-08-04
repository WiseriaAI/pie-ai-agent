import { useState, useEffect, useCallback } from "react";
import Chat from "@/sidepanel/components/Chat";
import SessionDrawer from "@/sidepanel/components/SessionDrawer";
import SkillsList from "@/sidepanel/components/SkillsList";
import SearchProviderSection from "@/sidepanel/components/SearchProviderSection";
import SettingsRoot from "@/sidepanel/components/settings/SettingsRoot";
import ModelsPage from "@/sidepanel/components/settings/pages/ModelsPage";
import BridgePage from "@/sidepanel/components/settings/pages/BridgePage";
import FeedbackPage from "@/sidepanel/components/settings/pages/FeedbackPage";
import AboutPage from "@/sidepanel/components/settings/pages/AboutPage";
import { UiLanguagePage, AssistantLanguagePage } from "@/sidepanel/components/settings/pages/LanguagePage";
import CustomRulesPage from "@/sidepanel/components/settings/pages/CustomRulesPage";
import TopBar, { type AppView, type SettingsPage } from "@/sidepanel/components/TopBar";
import type { ThemeMode } from "@/sidepanel/theme";
import SchedulesPanel from "@/sidepanel/components/Schedules/SchedulesPanel";
import { getInstance } from "@/lib/instances";
import { resolveSelection } from "@/lib/model-selection-resolver";
import { normalizeSkillSlashKey } from "@/lib/skills";
import { useSession } from "@/sidepanel/hooks/useSession";
import { useRecording } from "@/sidepanel/hooks/useRecording";
import RecordingMode from "@/sidepanel/components/RecordingMode";
import { listSessionIndex, getPendingConfirmCount } from "@/lib/sessions/storage";
import { hardDeleteExpired } from "@/lib/sessions/lifecycle";
import { getConfig, setConfig, removeConfig } from "@/lib/idb/config-store";
import { DEEPLINK_KEY, DEEPLINK_MANAGED_SUBSCRIBE } from "@/lib/deeplink";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import type { SessionIndexEntry } from "@/lib/sessions/types";

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
  const [view, setView] = useState<AppView>("agent");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("root");
  // Slide direction for the settings root ↔ sub-page swap: drilling in slides
  // from the right, going back slides from the left (page-enter-* classes).
  const [settingsNavDir, setSettingsNavDir] = useState<"fwd" | "back">("fwd");
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [chatPrefill, setChatPrefill] = useState<string | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  // Bumped each time a website "Subscribe" deep-link is consumed; threaded into
  // Settings → NewConfigWizard to open the managed-subscribe screen.
  const [subscribeNonce, setSubscribeNonce] = useState(0);
  // M1: theme mode owned at App level so the button reflects state and we
  // can persist to localStorage. M2 will wire data-theme to actually switch.
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("theme-mode");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });

  // M2: Apply theme-mode to document root, persist, and mirror to the IDB
  // `config` store for cross-window sync (via store-bus).
  // - 'light' / 'dark' → set dataset.theme so the [data-theme] CSS overrides win
  // - 'system' → delete dataset.theme, falling back to prefers-color-scheme
  // localStorage is kept as the synchronous source for the pre-paint theme
  // bootstrap in main.tsx (must read before any await), so we write both.
  useEffect(() => {
    if (themeMode === "light" || themeMode === "dark") {
      document.documentElement.dataset.theme = themeMode;
    } else {
      delete document.documentElement.dataset.theme;
    }
    localStorage.setItem("theme-mode", themeMode);
    void setConfig("theme-mode", themeMode);
  }, [themeMode]);

  const session = useSession();

  // Reframe (2026-05-05) — pendingRecording is the serialized trace + step
  // count surfaced after Finish. App passes it to Chat, which shows a chip
  // above the input and on Send injects it into expandedForLLM as args to
  // the create_skill_from_recording built-in skill.
  const [pendingRecording, setPendingRecording] = useState<{
    trace: string;
    stepCount: number;
  } | null>(null);
  const handleRecordingFinished = useCallback(
    (serializedTrace: string, stepCount: number) => {
      setPendingRecording({ trace: serializedTrace, stepCount });
    },
    [],
  );
  const handlePendingRecordingConsumed = useCallback(() => {
    setPendingRecording(null);
  }, []);
  const recording = useRecording({
    sessionId: session.sessionId,
    onFinished: handleRecordingFinished,
  });

  // ── Load session index ────────────────────────────────────────────────────
  // Refreshed via the store-bus "sessions" event so the drawer updates when
  // the SW writes session state (status transitions, new sessions, etc.)
  const refreshSessionIndex = useCallback(async () => {
    const list = await listSessionIndex();
    // Hide empty active sessions from the drawer — a freshly-mounted panel
    // creates one of these and the user shouldn't see it until they actually
    // send a message. Non-active statuses (paused / failed / archived) are
    // always shown so the user can resume / discard work.
    // `messageCount` is optional on legacy entries; treat undefined as
    // non-empty (1) to avoid hiding pre-upgrade sessions.
    // Schedule-originated sessions are managed from the Schedules page (opened
    // via a run-history row), so they are never listed in the drawer.
    const visible = list.filter(
      (e) => e.origin !== "schedule" && (e.status !== "active" || (e.messageCount ?? 1) > 0),
    );
    setSessions(visible);
  }, []);

  // ── Compute pendingCount ──────────────────────────────────────────────────
  // Count sessions whose :agent record has a live agent-tool pendingConfirm.
  // Scans the IDB `sessions` store; refreshed via the store-bus "sessions"
  // event rather than polling.
  const refreshPendingCount = useCallback(async () => {
    setPendingCount(await getPendingConfirmCount());
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

    // firstRun → open settings root
    void (async () => {
      if (await getConfig<boolean>("firstRun")) {
        openSettings();
        void removeConfig("firstRun");
      }
    })();

    loadProviderLabel();
  }, [refreshSessionIndex, refreshPendingCount]);

  // ── Deep-link: website "Subscribe" → managed-subscribe screen ──────────────
  // The SW stashes a one-shot intent in chrome.storage.session when it opens the
  // panel from a pie.chat "Subscribe" click (subscribe-bridge.ts → background
  // open-managed-subscribe). Consume it on mount (panel opened fresh) and live
  // via onChanged (panel already open), clear it, then route to Settings.
  useEffect(() => {
    let alive = true;
    const consume = (val: unknown) => {
      if (val !== DEEPLINK_MANAGED_SUBSCRIBE) return;
      void chrome.storage.session.remove(DEEPLINK_KEY);
      openSettings("models");
      setSubscribeNonce((n) => n + 1);
    };
    void chrome.storage.session
      .get(DEEPLINK_KEY)
      .then((r) => { if (alive) consume(r?.[DEEPLINK_KEY]); })
      .catch(() => {});
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "session" && changes[DEEPLINK_KEY]?.newValue !== undefined) {
        consume(changes[DEEPLINK_KEY].newValue);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  // ── Cross-context reactivity via store-bus ─────────────────────────────────
  // Replaces the former chrome.storage.local.onChanged listener. Each former
  // key-class maps to a store: session_* → "sessions"; last_model_selection /
  // instances_index / instance_* → "instances" + "config" (active_instance_id
  // lives in config); theme-mode → "config".

  // Session list + pending count. The session index is written in the same
  // batch as session records but only emits a coarse "sessions" event
  // (writeSessionBatch never publishes to the "session_index" store), so one
  // subscription covers both the index refresh and the pending-count rescan.
  useStoreChange("sessions", () => {
    void refreshSessionIndex();
    void refreshPendingCount();
  });

  // Provider label depends on the active selection (config: last_model_selection
  // / active_instance_id) and instance config (instances: instance_*).
  useStoreChange("instances", () => {
    loadProviderLabel();
  });
  useStoreChange("config", (c) => {
    if (c.id === "theme-mode") {
      // M2: cross-window theme sync. Re-read and only update when it differs
      // from current (the writer window already handled its own setState).
      void getConfig<string>("theme-mode").then((next) => {
        if (next === "light" || next === "dark" || next === "system") {
          setThemeMode((prev) => (prev === next ? prev : next));
        }
      });
      return;
    }
    // last_model_selection / active_instance_id (and any other config write)
    // can change the resolved provider label.
    loadProviderLabel();
  });

  async function loadProviderLabel() {
    try {
      const sel = await resolveSelection({});
      if (!sel) {
        setProviderLabel(null);
        return;
      }
      const inst = await getInstance(sel.instanceId);
      if (inst) {
        setProviderLabel(`${inst.nickname.toUpperCase()} · ${sel.model}`);
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
  // on every parent render (store-bus "sessions" events drive App re-render
  // frequently while drawer is open; inline arrow would thrash preFocusRef).
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), []);

  const handleSelectSession = useCallback(async (id: string) => {
    const ok = await session.setActive(id);
    // setActive returns null only when the session meta no longer exists (the
    // streaming guard was removed in #30). In that case keep the drawer open;
    // only close it when the switch actually succeeded.
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

  // ── Open a session from the Schedules run history ─────────────────────────
  // A run row carries its 1:1 sessionId; clicking it activates that session and
  // returns to the chat view so the user sees the scheduled run's conversation.
  // setActive returns null only when the session meta no longer exists (e.g. it
  // was hard-deleted) — in that case stay on the current view.
  const handleOpenSessionFromSchedule = useCallback(async (id: string) => {
    const ok = await session.setActive(id);
    if (ok != null) setView("agent");
  }, [session]);

  // ── Create a schedule via chat ────────────────────────────────────────────
  // From the Schedules page, the user can choose to describe the schedule in
  // chat instead of filling the form. Start a fresh session (a new schedule is
  // a new task, not a continuation), prefill the composer with the localized
  // template, and switch to the chat view. createAndActivate refuses (null)
  // only while a task is streaming — then we just prefill the current session.
  const handleCreateScheduleViaChat = useCallback(async (template: string) => {
    await session.createAndActivate();
    setChatPrefill(template);
    setView("agent");
  }, [session]);

  // ── New session ───────────────────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    const newId = await session.createAndActivate();
    if (newId == null) return; // refused due to streaming — toast already emitted
    setDrawerOpen(false);
  }, [session]);

  // ── Settings navigation (two-layer stack) ─────────────────────────────────
  // openSettings enters the settings view at a given page (default root) and
  // closes the drawer. goBack pops one level: settings sub-page → root; root /
  // schedules / skills → chat.
  const openSettings = useCallback((page: SettingsPage = "root") => {
    setSettingsNavDir("fwd");
    setSettingsPage(page);
    setView("settings");
    setDrawerOpen(false);
  }, []);

  const goBack = useCallback(() => {
    if (view === "settings" && settingsPage !== "root") {
      setSettingsNavDir("back");
      setSettingsPage("root");
    } else setView("agent");
  }, [view, settingsPage]);

  // ── Keyboard shortcuts (panel-focused) ─────────────────────────────────────
  // Cmd/Ctrl+K → new session, Cmd/Ctrl+D → toggle the session drawer, and Esc →
  // return to chat from Settings/Schedules when idle (the drawer + Composer
  // handle their own Esc). Cmd/Ctrl+N is intentionally avoided: Chrome reserves
  // it for "new window" and a web page cannot suppress it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        void handleNewSession();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setDrawerOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && !e.defaultPrevented && !drawerOpen && view !== "agent") {
        goBack();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleNewSession, drawerOpen, view, goBack]);

  // ── Session title for top bar ─────────────────────────────────────────────
  const activeSessionEntry = sessions.find((s) => s.id === session.sessionId);
  const sessionTitle = activeSessionEntry?.title ?? (session.sessionId ? "New Session" : "…");

  return (
    <div
      className="bg-canvas text-fg-1 dot-grid flex h-screen flex-col"
      style={{ position: "relative", overflow: "hidden" }}
    >
      {/* ── Contextual single top bar (six states + pin sub-row) ──────────── */}
      <TopBar
        view={view}
        settingsPage={settingsPage}
        sessionTitle={sessionTitle}
        pendingCount={pendingCount}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onNewSession={() => void handleNewSession()}
        onNavigate={(v) => setView(view === v ? "agent" : v)}
        onBack={goBack}
        pinnedTabs={session.pinnedTabs}
        pinMode={session.pinMode ?? null}
        streaming={session.streaming}
        onTogglePinTab={(tabId, origin) => void session.togglePinTab(tabId, origin)}
        onClearUserPin={() => void session.clearUserPin()}
      />

      {/* ── Main content area ─────────────────────────────────────────────── */}
      {/* key={view} forces remount on switch so .view-enter keyframe replays.
          The wrapper inherits flex layout from the outer container. */}
      <div
        key={view}
        className="view-enter"
        style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        {view === "agent" && recording.active ? (
          <RecordingMode
            active={recording.active}
            actions={recording.actions}
            lastAbortReason={recording.lastAbortReason}
            onFinish={() => recording.finishRecording()}
            onDiscard={() => recording.discardRecording()}
          />
        ) : view === "agent" ? (
          <Chat
            providerLabel={providerLabel}
            onOpenSettings={() => openSettings()}
            prefillInput={chatPrefill}
            onPrefillConsumed={() => setChatPrefill(undefined)}
            session={session}
            pendingRecording={pendingRecording}
            onPendingRecordingConsumed={handlePendingRecordingConsumed}
            onStartRecording={
              session.sessionId && !session.streaming
                ? recording.startRecording
                : undefined
            }
          />
        ) : view === "schedules" ? (
          <SchedulesPanel
            onOpenSession={(id) => void handleOpenSessionFromSchedule(id)}
            onCreateViaChat={(template) => void handleCreateScheduleViaChat(template)}
          />
        ) : view === "skills" ? (
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <SkillsList onRunSkill={(id, name) => void handleRunSkill(id, name)} />
          </div>
        ) : view === "settings" ? (
          <div
            key={settingsPage}
            className={`${settingsNavDir === "back" ? "page-enter-back" : "page-enter-fwd"} flex-1 overflow-y-auto px-4 py-6`}
          >
            {settingsPage === "root" ? (
              <SettingsRoot
                themeMode={themeMode}
                onThemeModeChange={setThemeMode}
                onOpenPage={(p) => {
                  setSettingsNavDir("fwd");
                  setSettingsPage(p);
                }}
              />
            ) : settingsPage === "models" ? (
              <ModelsPage openSubscribeNonce={subscribeNonce} />
            ) : settingsPage === "bridge" ? (
              <BridgePage />
            ) : settingsPage === "search" ? (
              <SearchProviderSection />
            ) : settingsPage === "uiLanguage" ? (
              <UiLanguagePage />
            ) : settingsPage === "assistantLanguage" ? (
              <AssistantLanguagePage />
            ) : settingsPage === "customRules" ? (
              <CustomRulesPage />
            ) : settingsPage === "about" ? (
              <AboutPage />
            ) : (
              <FeedbackPage />
            )}
          </div>
        ) : null}
      </div>

      {/* ── Session drawer (overlay) ──────────────────────────────────────── */}
      <SessionDrawer
        isOpen={drawerOpen}
        onClose={handleCloseDrawer}
        sessions={sessions}
        activeSessionId={session.sessionId}
        onSelectSession={handleSelectSession}
        onResumeSession={handleResumeSession}
        onOpenSettings={() => openSettings()}
      />
    </div>
  );
}
