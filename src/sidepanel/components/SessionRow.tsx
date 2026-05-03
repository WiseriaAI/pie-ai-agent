/**
 * SessionRow — a single session in the drawer list.
 *
 * Renders:
 *   - 18×18 status icon (SVG, aria-hidden)
 *   - title + meta caption (time + step info)
 *   - optional inline action button (Resume / Review)
 *
 * The row itself is a list item (role=listitem) with aria-label containing
 * title, status, and relative time — satisfying R27 a11y requirement.
 */

import type { SessionIndexEntry } from "@/lib/sessions/types";

interface SessionRowProps {
  session: SessionIndexEntry;
  isActive: boolean;
  onSelect: (id: string) => void;
  onResume: (id: string) => void;
}

// ── Status icon components ────────────────────────────────────────────────────

function ActiveSelectedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="4" fill="var(--c-accent)" />
    </svg>
  );
}

function ActiveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="4" fill="var(--c-accent)" opacity="0.4" />
    </svg>
  );
}

function PausedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" stroke="var(--c-fg-2)" strokeWidth="1" />
    </svg>
  );
}

function FailedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="var(--c-fg-2)" />
      <line x1="6.5" y1="6.5" x2="11.5" y2="11.5" stroke="var(--c-surface-deep)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11.5" y1="6.5" x2="6.5" y2="11.5" stroke="var(--c-surface-deep)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Time formatting ───────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hr ago";
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function statusLabel(status: SessionIndexEntry["status"]): string {
  switch (status) {
    case "active":   return "active";
    case "paused":   return "paused";
    case "failed":   return "failed";
    case "archived": return "archived";
  }
}

// ── SessionRow ────────────────────────────────────────────────────────────────

export default function SessionRow({
  session,
  isActive,
  onSelect,
  onResume,
}: SessionRowProps) {
  const { id, status, title, lastAccessedAt } = session;
  const displayTitle = title ?? "Untitled session";
  const timeStr = formatRelativeTime(lastAccessedAt);
  const ariaLabel = `${displayTitle}, ${statusLabel(status)}, ${timeStr}`;

  // Row bg / left-border for active-selected state
  const rowStyle: React.CSSProperties = {
    padding: "12px 16px",
    display: "flex",
    alignItems: "center",
    gap: 10,
    cursor: "pointer",
    background: isActive ? "var(--c-surface)" : "transparent",
    borderLeft: isActive ? "2px solid var(--c-accent)" : "2px solid transparent",
    transition: "background 0.1s",
    userSelect: "none",
  };

  function handleRowClick(e: React.MouseEvent) {
    // Don't double-fire if user clicked a child button
    if ((e.target as HTMLElement).closest("button")) return;
    onSelect(id);
  }

  // Icon selection
  let icon: React.ReactNode;
  if (isActive && status === "active") {
    icon = <ActiveSelectedIcon />;
  } else if (status === "active") {
    icon = <ActiveIcon />;
  } else if (status === "paused") {
    icon = <PausedIcon />;
  } else if (status === "failed") {
    icon = <FailedIcon />;
  } else {
    // archived or unknown
    icon = <ActiveIcon />;
  }

  // Meta caption text + color
  let metaText = timeStr;
  const metaColor = "var(--c-fg-3)";
  if (status === "paused") {
    metaText = `${timeStr} · PAUSED`;
  } else if (status === "failed") {
    metaText = `${timeStr} · FAILED`;
  }

  // Title color
  const titleColor = status === "failed" ? "var(--c-fg-2)" : "var(--c-fg-1)";

  return (
    <li
      role="listitem"
      tabIndex={0}
      aria-label={ariaLabel}
      style={rowStyle}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleRowClick(e as unknown as React.MouseEvent);
        }
      }}
    >
      {/* Status icon */}
      <span style={{ width: 18, height: 18, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {icon}
      </span>

      {/* Text column */}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            fontWeight: 500,
            color: titleColor,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {/* M2-U3 R29: title is a React text node — no innerHTML / dangerouslySetInnerHTML path.
               HTML entities (e.g. &lt;) from escapeUntrustedWrappers are rendered as literal
               text by React, not parsed as HTML, so XSS via a crafted LLM title is not possible. */}
          {displayTitle}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: "0.08em",
            color: metaColor,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {metaText}
        </span>
      </span>

      {/* Inline action button */}
      {status === "paused" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResume(id);
          }}
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--c-accent)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
            flexShrink: 0,
          }}
        >
          Resume →
        </button>
      )}
    </li>
  );
}

