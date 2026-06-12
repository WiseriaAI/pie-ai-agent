/**
 * TopBarSchedulesButton — clock button that opens / closes the Schedules view.
 *
 * Mirrors TopBarSettingsButton's 24×24 hairline-bordered surface style; the
 * border switches to accent when the Schedules view is active.
 */

interface Props {
  isActive: boolean;
  onClick: () => void;
}

export default function TopBarSchedulesButton({ isActive, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isActive ? "Close schedules" : "Open schedules"}
      aria-pressed={isActive}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        border: `1px solid ${isActive ? "var(--c-accent)" : "var(--c-line)"}`,
        background: "var(--c-surface)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "border-color 150ms ease-out, background 150ms ease-out",
      }}
    >
      {/* Clock face (stroke style) — reads as "scheduled / recurring". */}
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.25" stroke="var(--c-accent)" strokeWidth="1.4" />
        <path
          d="M10 6v4l2.5 2"
          stroke="var(--c-accent)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
