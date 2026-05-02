/**
 * SessionDrawer — M2-U2 overlay drawer showing the session list.
 * M2-U4: adds "Show archived" toggle, unarchive/delete-forever buttons,
 * soft-delete per active row, and real storage usage from getBytesInUse(null).
 *
 * Design spec:
 * - 296px wide, full height, left-anchored, bg #0E1216, border-right hairline
 * - Backdrop (rgba(8,13,16,0.72)) covers the remaining area; click closes drawer
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

import { useEffect, useRef, useState } from "react";
import type { SessionIndexEntry } from "@/lib/sessions/types";
import { getTotalBytes } from "@/lib/sessions/storage";
import {
  unarchiveSession,
  hardDeleteSession,
  softDeleteSession,
} from "@/lib/sessions/lifecycle";
import SessionRow from "./SessionRow";

interface SessionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: SessionIndexEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResumeSession: (id: string) => void;
}

// 8 MB budget (MV3 quota is 10 MB; we reserve 2 MB for non-session keys).
// Highlight the storage bar when above 7.5 MB.
const STORAGE_BUDGET_BYTES = 8 * 1024 * 1024;
const STORAGE_WARN_BYTES = 7.5 * 1024 * 1024;

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
  const [usedBytes, setUsedBytes] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const bytes = await getTotalBytes();
      if (!cancelled) setUsedBytes(bytes);
    }

    void load();

    // Refresh on any storage change (sessions are being written frequently)
    const listener = () => { void load(); };
    chrome.storage.local.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.local.onChanged.removeListener(listener);
    };
  }, []);

  const usedMB = usedBytes / (1024 * 1024);
  const budgetMB = STORAGE_BUDGET_BYTES / (1024 * 1024);
  const percent = Math.min((usedBytes / STORAGE_BUDGET_BYTES) * 100, 100);
  const isWarning = usedBytes >= STORAGE_WARN_BYTES;

  return (
    <div
      style={{
        marginTop: "auto",
        padding: "14px 16px",
        borderTop: "1px solid #22272F",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span
          aria-label="Storage"
          style={{
            flex: 1,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: isWarning ? "#C25F5F" : "#525965",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Storage
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 500,
            color: isWarning ? "#C25F5F" : "#8A929E",
          }}
        >
          {usedMB.toFixed(1)} / {budgetMB.toFixed(1)} MB
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${Math.round(percent)}% storage used`}
        style={{
          height: 2,
          background: "#22272F",
          borderRadius: 1,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${percent}%`,
            background: isWarning ? "#C25F5F" : "#B8C8D6",
            borderRadius: 1,
            transition: "width 0.3s ease",
          }}
        />
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
  const { id, title, lastAccessedAt } = session;
  const displayTitle = title ?? "Untitled session";

  const diff = Date.now() - lastAccessedAt;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const timeStr = days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;

  return (
    <li
      role="listitem"
      aria-label={`${displayTitle}, archived, ${timeStr}`}
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
          <circle cx="9" cy="9" r="5.5" stroke="#525965" strokeWidth="1" strokeDasharray="3 2" />
        </svg>
      </span>

      {/* Text */}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            fontWeight: 500,
            color: "#525965",
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
            color: "#3A4049",
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
          aria-label={`Unarchive ${displayTitle}`}
          onClick={() => onUnarchive(id)}
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 500,
            color: "#8A929E",
            background: "none",
            border: "1px solid #22272F",
            borderRadius: 4,
            cursor: "pointer",
            padding: "2px 6px",
          }}
        >
          Restore
        </button>
        <button
          type="button"
          aria-label={`Delete ${displayTitle} forever`}
          onClick={() => onDeleteForever(id)}
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 500,
            color: "#8A3A3A",
            background: "none",
            border: "1px solid #3A2222",
            borderRadius: 4,
            cursor: "pointer",
            padding: "2px 6px",
          }}
        >
          Delete
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

  if (!isOpen) return null;

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
      {/* Backdrop */}
      <div
        data-testid="drawer-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(8,13,16,0.72)",
          zIndex: 40,
        }}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 296,
          height: "100%",
          background: "#0E1216",
          borderRight: "1px solid #22272F",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
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
          {/* Logo: 18×18 circle + inner dot */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <circle
              cx="9"
              cy="9"
              r="8.5"
              stroke="#B8C8D6"
              strokeWidth="1"
            />
            <circle cx="9" cy="9" r="2" fill="#B8C8D6" />
          </svg>

          {/* Title */}
          <span
            style={{
              flex: 1,
              fontFamily: "Inter, sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: "#E5E8EC",
            }}
          >
            Sessions
          </span>

          {/* Session count */}
          <span
            aria-label={`${activeSessions.length} sessions`}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: "#525965",
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
            color: "#525965",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          Active · {activeSessions.length}
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
            borderTop: "1px solid #22272F",
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
              color: archivedCount > 0 ? "#8A929E" : "#525965",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {showArchived ? "Hide Archived" : "Show Archived"} · {archivedCount}
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
              stroke="#525965"
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
            style={{ maxHeight: 200, overflowY: "auto", borderBottom: "1px solid #22272F" }}
          >
            <ul
              role="list"
              aria-label="Archived sessions"
              style={{ margin: 0, padding: 0, listStyle: "none" }}
            >
              {archivedSessions.length === 0 ? (
                <li
                  style={{
                    padding: "12px 16px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 12,
                    color: "#3A4049",
                  }}
                >
                  No archived sessions
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
          aria-label={`Archive ${session.title ?? "session"}`}
          title="Archive session"
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
            color: "#525965",
            background: "#0E1216",
            border: "1px solid #22272F",
            borderRadius: 4,
            cursor: "pointer",
            padding: "2px 6px",
            // Only show when row doesn't have a Resume button (paused rows)
            // If it's a paused row with a Resume button, skip the overlap.
            display: session.status === "paused" ? "none" : "block",
          }}
        >
          Archive
        </button>
      )}
    </div>
  );
}
