/**
 * TopBarNewSessionButton — the + button that creates a new session.
 *
 * 24×24, hairline border, surface bg, ice-silver + icon.
 */

interface TopBarNewSessionButtonProps {
  onClick: () => void;
}

export default function TopBarNewSessionButton({
  onClick,
}: TopBarNewSessionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="New session"
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        border: "1px solid #22272F",
        background: "#14171C",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        cursor: "pointer",
        padding: 0,
      }}
    >
      {/* + icon — 10×10 ice silver cross */}
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        aria-hidden="true"
      >
        <rect x="4.25" y="0" width="1.5" height="10" rx="0.75" fill="#B8C8D6" />
        <rect x="0" y="4.25" width="10" height="1.5" rx="0.75" fill="#B8C8D6" />
      </svg>
    </button>
  );
}
