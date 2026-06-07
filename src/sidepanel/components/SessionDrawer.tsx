/**
 * SessionDrawer — M2-U2 overlay drawer showing the session list.
 * M2-U4: adds "Show archived" toggle, unarchive/delete-forever buttons,
 * soft-delete per active row, and real storage usage from getBytesInUse(null).
 *
 * Design spec:
 * - 296px wide, full height, left-anchored, bg var(--c-surface-deep), border-right hairline
 * - Backdrop (var(--c-overlay-strong)) covers the remaining area; click closes drawer
 * - ESC keydown closes drawer
 * - Focus trap: Tab/Shift+Tab cycle within the drawer
 * - role=dialog aria-modal=true aria-label="Sessions"
 *
 * Internal sections:
 * 1. Header: logo + "Sessions" label + session count
 * 2. ACTIVE section: list of non-archived sessions
 * 3. SHOW ARCHIVED toggle (M2-U4 — real, collapsible)
 * 4. Storage indicator: usage bar + MB label
 *
 * R27 a11y baseline:
 * - role=dialog + aria-modal + aria-label
 * - role=list + role=listitem on rows
 * - Per-row aria-label: "${title}, ${status}, ${time}"
 * - ESC key closes
 * - Focus trap within drawer
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { SessionIndexEntry } from "@/lib/sessions/types";
import { getTotalBytes } from "@/lib/sessions/storage";
import {
  unarchiveSession,
  hardDeleteSession,
  softDeleteSession,
} from "@/lib/sessions/lifecycle";
import { useStoreChange } from "@/sidepanel/hooks/useStoreChange";
import SessionRow from "./SessionRow";

interface SessionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: SessionIndexEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResumeSession: (id: string) => void;
}

// ── Delayed-unmount helper ────────────────────────────────────────────────────
// Keeps the drawer DOM present long enough for the closing transition to run,
// then removes it. Mirrors what AnimatePresence does in motion libraries, but
// without pulling in 20kB. Delay must match the longest transition below
// (240ms panel slide).
function useDelayedUnmount(isOpen: boolean, delay: number) {
  const [render, setRender] = useState(isOpen);
  useEffect(() => {
    if (isOpen) {
      setRender(true);
      return;
    }
    const t = setTimeout(() => setRender(false), delay);
    return () => clearTimeout(t);
  }, [isOpen, delay]);
  return render;
}

const DRAWER_TRANSITION_MS = 240;
const DRAWER_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

// ── Focus trap helper ─────────────────────────────────────────────────────────

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='listitem']",
].join(", ");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

// ── StorageIndicator ──────────────────────────────────────────────────────────

function StorageIndicator() {
  const t = useT();
  const [usedBytes, setUsedBytes] = useState(0);
  const load = useCallback(async () => { setUsedBytes(await getTotalBytes()); }, []);
  useEffect(() => { void load(); }, [load]);
  useStoreChange("sessions", () => { void load(); });
  useStoreChange("config", () => { void load(); });
  useStoreChange("instances", () => { void load(); });
  const usedMB = usedBytes / (1024 * 1024);
  return (
    <div style={{ marginTop: "auto", padding: "14px 16px", borderTop: "1px solid var(--c-line)" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span
          aria-label={t("sessions.storage")}
          style={{
            flex: 1,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-3)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {t("sessions.storage")}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-2)",
          }}
        >
          {usedMB.toFixed(1)} MB
        </span>
      </div>
    </div>
  );
}

// ── ArchivedRow ───────────────────────────────────────────────────────────────

interface ArchivedRowProps {
  session: SessionIndexEntry;
  onUnarchive: (id: string) => void;
  onDeleteForever: (id: string) => void;
}

function ArchivedRow({ session, onUnarchive, onDeleteForever }: ArchivedRowProps) {
  const t = useT();
  const { id, title, lastAccessedAt } = session;
  const displayTitle = title ?? t("sessions.untitled");

  const diff = Date.now() - lastAccessedAt;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const timeStr =
    days === 0
      ? t("sessions.today")
      : days === 1
        ? t("sessions.yesterday")
        : t("sessions.daysAgo", { days });

  return (
    <li
      role="listitem"
      aria-label={`${displayTitle}, ${t("sessions.status.archived")}, ${timeStr}`}
      style={{
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderLeft: "2px solid transparent",
      }}
    >
      {/* Archived icon: faded circle */}
      <span
        style={{
          width: 18,
          height: 18,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" stroke="var(--c-fg-3)" strokeWidth="1" strokeDasharray="3 2" />
        </svg>
      </span>

      {/* Text */}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--c-fg-3)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayTitle}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: "0.08em",
            color: "var(--c-fg-4)",
            whiteSpace: "nowrap",
          }}
        >
          {timeStr}
        </span>
      </span>

      {/* Actions */}
      <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          aria-label={t("sessions.unarchiveAria", { title: displayTitle })}
          onClick={() => onUnarchive(id)}
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-2)",
            background: "none",
            border: "1px solid var(--c-line)",
            borderRadius: 4,
            cursor: "pointer",
            padding: "2px 6px",
          }}
        >
          {t("sessions.restore")}
        </button>
        <button
          type="button"
          aria-label={t("sessions.deleteForeverAria", { title: displayTitle })}
          onClick={() => onDeleteForever(id)}
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-danger-fg)",
            background: "none",
            border: "1px solid var(--c-danger-line)",
            borderRadius: 4,
            cursor: "pointer",
            padding: "2px 6px",
          }}
        >
          {t("sessions.delete")}
        </button>
      </span>
    </li>
  );
}

// ── SessionDrawer ─────────────────────────────────────────────────────────────

export default function SessionDrawer({
  isOpen,
  onClose,
  sessions,
  activeSessionId,
  onSelectSession,
  onResumeSession,
}: SessionDrawerProps) {
  const t = useT();
  const drawerRef = useRef<HTMLDivElement>(null);
  // Track the element that had focus before the drawer opened so we can
  // restore it when the drawer closes.
  const preFocusRef = useRef<Element | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // ESC to close + focus trap
  useEffect(() => {
    if (!isOpen) return;

    // Save the currently focused element so we can restore on close
    preFocusRef.current = document.activeElement;

    // Initial focus: first focusable element in the drawer
    const drawer = drawerRef.current;
    if (drawer) {
      const focusable = getFocusableElements(drawer);
      if (focusable.length > 0) {
        focusable[0]!.focus();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      // Focus trap
      if (e.key !== "Tab") return;
      const current = drawerRef.current;
      if (!current) return;
      const focusable = getFocusableElements(current);
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (e.shiftKey) {
        // Shift+Tab: if we're on first, wrap to last
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: if we're on last, wrap to first
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to the element that was focused before the drawer opened
      if (preFocusRef.current instanceof HTMLElement) {
        preFocusRef.current.focus();
      }
    };
  }, [isOpen, onClose]);

  // M5: stay mounted long enough for the close transition to finish before
  // removing the DOM. focus-trap effect above already guards on isOpen so
  // listeners aren't attached while the drawer is animating out.
  const shouldRender = useDelayedUnmount(isOpen, DRAWER_TRANSITION_MS);
  if (!shouldRender) return null;

  // Sessions split by status — archived goes to the "show archived" section
  const activeSessions = sessions.filter((s) => s.status !== "archived");
  const archivedSessions = sessions.filter((s) => s.status === "archived");
  const archivedCount = archivedSessions.length;

  function handleSelectSession(id: string) {
    onSelectSession(id);
    onClose();
  }

  async function handleSoftDelete(id: string) {
    await softDeleteSession(id);
    // Storage onChanged in App.tsx will refresh the sessions list.
  }

  async function handleUnarchive(id: string) {
    await unarchiveSession(id);
  }

  async function handleDeleteForever(id: string) {
    await hardDeleteSession(id);
  }

  return (
    <>
      {/* Backdrop — fades in/out; pointer-events disabled while closing so
           clicks fall through immediately even if the panel hasn't unmounted. */}
      <div
        data-testid="drawer-backdrop"
        data-state={isOpen ? "open" : "closed"}
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--c-overlay-strong)",
          zIndex: 40,
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? "auto" : "none",
          transition: `opacity 200ms ${DRAWER_EASING}`,
        }}
      />

      {/* Drawer panel — slides in from the left edge */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("sessions.header")}
        data-state={isOpen ? "open" : "closed"}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 296,
          height: "100%",
          background: "var(--c-surface-deep)",
          borderRight: "1px solid var(--c-line)",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transform: isOpen ? "translateX(0)" : "translateX(-100%)",
          transition: `transform ${DRAWER_TRANSITION_MS}ms ${DRAWER_EASING}`,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 16px 12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {/* Logo: V3 bite-curve mark, 18×18.
              Uses --c-fg-1 / --c-canvas tokens so the mark inverts cleanly
              between light and dark mode (deep base on light surface, light
              base on dark surface) while staying a 1:1 silhouette of the
              manifest icon. */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 128 128"
            fill="none"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <rect width="128" height="128" rx="26" fill="var(--c-fg-1)" />
            <circle cx="64" cy="64" r="44" fill="var(--c-canvas)" />
            <circle cx="98" cy="30" r="22" fill="var(--c-fg-1)" />
          </svg>

          {/* Title */}
          <span
            style={{
              flex: 1,
              fontFamily: "Inter, sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--c-fg-1)",
            }}
          >
            {t("sessions.header")}
          </span>

          {/* Session count */}
          <span
            aria-label={t("sessions.sessionCount", { count: activeSessions.length })}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: "var(--c-fg-3)",
              letterSpacing: "0.16em",
            }}
          >
            {activeSessions.length}
          </span>
        </div>

        {/* ACTIVE section divider */}
        <div
          style={{
            padding: "14px 16px 6px 16px",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-3)",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          {t("sessions.active")} · {activeSessions.length}
        </div>

        {/* Session list (scrollable) */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ul
            role="list"
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {activeSessions.map((session) => (
              <SessionRowWithDelete
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={handleSelectSession}
                onResume={onResumeSession}
                onDelete={handleSoftDelete}
              />
            ))}
          </ul>
        </div>

        {/* SHOW ARCHIVED toggle — real collapsible section */}
        <button
          type="button"
          aria-expanded={showArchived}
          aria-controls="archived-session-list"
          onClick={() => setShowArchived((v) => !v)}
          style={{
            padding: "14px 16px 6px 16px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            borderTop: "1px solid var(--c-line)",
            cursor: "pointer",
            width: "100%",
            textAlign: "left",
          }}
        >
          <span
            style={{
              flex: 1,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: archivedCount > 0 ? "var(--c-fg-2)" : "var(--c-fg-3)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {showArchived ? t("sessions.hideArchived") : t("sessions.showArchived")} · {archivedCount}
          </span>
          {/* Chevron — flips when open */}
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            aria-hidden="true"
            style={{
              transform: showArchived ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s ease",
            }}
          >
            <path
              d="M1.5 3 L4.5 6 L7.5 3"
              stroke="var(--c-fg-3)"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Archived session list (collapsible) */}
        {showArchived && (
          <div
            id="archived-session-list"
            style={{ maxHeight: 200, overflowY: "auto", borderBottom: "1px solid var(--c-line)" }}
          >
            <ul
              role="list"
              aria-label={t("sessions.archivedAria")}
              style={{ margin: 0, padding: 0, listStyle: "none" }}
            >
              {archivedSessions.length === 0 ? (
                <li
                  style={{
                    padding: "12px 16px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 12,
                    color: "var(--c-fg-4)",
                  }}
                >
                  {t("sessions.noArchived")}
                </li>
              ) : (
                archivedSessions.map((session) => (
                  <ArchivedRow
                    key={session.id}
                    session={session}
                    onUnarchive={handleUnarchive}
                    onDeleteForever={handleDeleteForever}
                  />
                ))
              )}
            </ul>
          </div>
        )}

        {/* Storage indicator */}
        <StorageIndicator />
      </div>
    </>
  );
}

// ── SessionRowWithDelete ──────────────────────────────────────────────────────
// Wraps SessionRow and adds a soft-delete ("Delete") button on hover-reveal.
// Uses a simple show-on-focus approach to keep the row accessible.

interface SessionRowWithDeleteProps {
  session: SessionIndexEntry;
  isActive: boolean;
  onSelect: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}

function SessionRowWithDelete({
  session,
  isActive,
  onSelect,
  onResume,
  onDelete,
}: SessionRowWithDeleteProps) {
  const t = useT();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <SessionRow
        session={session}
        isActive={isActive}
        onSelect={onSelect}
        onResume={onResume}
      />
      {/* Delete button — revealed on hover (not shown for archived rows) */}
      {hovered && session.status !== "archived" && (
        <button
          type="button"
          aria-label={t("sessions.archiveAria", { title: session.title ?? t("sessions.untitled") })}
          title={t("sessions.archiveSession")}
          onClick={(e) => {
            e.stopPropagation();
            void onDelete(session.id);
          }}
          style={{
            position: "absolute",
            top: "50%",
            right: 8,
            transform: "translateY(-50%)",
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 500,
            color: "var(--c-fg-3)",
            background: "var(--c-surface-deep)",
            border: "1px solid var(--c-line)",
            borderRadius: 4,
            cursor: "pointer",
            padding: "2px 6px",
            // Only show when row doesn't have a Resume button (paused rows)
            // If it's a paused row with a Resume button, skip the overlap.
            display: session.status === "paused" ? "none" : "block",
          }}
        >
          {t("sessions.archive")}
        </button>
      )}
    </div>
  );
}
