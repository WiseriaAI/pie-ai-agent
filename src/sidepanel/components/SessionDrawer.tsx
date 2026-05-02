/**
 * SessionDrawer — M2-U2 overlay drawer showing the session list.
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
 * 3. SHOW ARCHIVED toggle (deferred to M2-U4 — placeholder here)
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
import SessionRow from "./SessionRow";

interface SessionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: SessionIndexEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResumeSession: (id: string) => void;
}

// 8 MB budget (MV3 quota is 10 MB; we reserve 2 MB for non-session keys)
const STORAGE_BUDGET_BYTES = 8 * 1024 * 1024;

// ── Focus trap helper ─────────────────────────────────────────────────────────

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
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
            color: "#525965",
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
            color: "#8A929E",
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
            background: "#B8C8D6",
            borderRadius: 1,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
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
  const archivedCount = sessions.filter((s) => s.status === "archived").length;

  function handleSelectSession(id: string) {
    onSelectSession(id);
    onClose();
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

        {/* Session list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ul
            role="list"
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {activeSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={handleSelectSession}
                onResume={onResumeSession}
              />
            ))}
          </ul>
        </div>

        {/* SHOW ARCHIVED toggle (M2-U4 stub) */}
        <div
          style={{
            padding: "14px 16px 6px 16px",
            borderTop: "1px solid #22272F",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              flex: 1,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 500,
              color: "#525965",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            Show Archived · {archivedCount}
          </span>
          {/* Chevron */}
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 3 L4.5 6 L7.5 3"
              stroke="#525965"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Storage indicator */}
        <StorageIndicator />
      </div>
    </>
  );
}
