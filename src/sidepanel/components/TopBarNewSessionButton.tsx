import { useT } from "@/lib/i18n";

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
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("topBar.newSession")}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        border: "1px solid var(--c-line)",
        background: "var(--c-surface)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        cursor: "pointer",
        padding: 0,
        transition: "border-color 150ms ease-out, background 150ms ease-out",
      }}
    >
      {/* + icon — 10×10 accent cross */}
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        aria-hidden="true"
      >
        <rect x="4.25" y="0" width="1.5" height="10" rx="0.75" fill="var(--c-accent)" />
        <rect x="0" y="4.25" width="10" height="1.5" rx="0.75" fill="var(--c-accent)" />
      </svg>
    </button>
  );
}
