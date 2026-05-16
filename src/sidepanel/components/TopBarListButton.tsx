import { useT } from "@/lib/i18n";

/**
 * TopBarListButton — the ≡ hamburger button that toggles the SessionDrawer.
 *
 * When there are pending confirms across sessions (pendingCount > 0) a warning
 * dot is rendered in the top-right corner of the button using an island visual
 * effect (bg ring matches the canvas background).
 *
 * When the drawer is open (isOpen=true) the border switches to ice-silver to
 * indicate active state.
 */

interface TopBarListButtonProps {
  pendingCount: number;
  isOpen: boolean;
  onClick: () => void;
}

export default function TopBarListButton({
  pendingCount,
  isOpen,
  onClick,
}: TopBarListButtonProps) {
  const t = useT();
  const ariaLabel = `${t("topBar.openSessionsList")}${pendingCount > 0 ? t("topBar.pendingBadge", { count: pendingCount }) : ""}`;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={isOpen}
      style={{
        position: "relative",
        width: 24,
        height: 24,
        borderRadius: 6,
        border: `1px solid ${isOpen ? "var(--c-accent)" : "var(--c-line)"}`,
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
      {/* ≡ icon — three horizontal lines, 11×9, accent color */}
      <svg
        width="11"
        height="9"
        viewBox="0 0 11 9"
        fill="none"
        aria-hidden="true"
      >
        <rect x="0" y="0" width="11" height="1.5" rx="0.75" fill="var(--c-accent)" />
        <rect x="0" y="3.75" width="11" height="1.5" rx="0.75" fill="var(--c-accent)" />
        <rect x="0" y="7.5" width="11" height="1.5" rx="0.75" fill="var(--c-accent)" />
      </svg>

      {/* Warning dot — only rendered when pendingCount > 0.
          Island border matches the top-bar background so the dot reads as
          floating above it (carved-out ring effect). */}
      {pendingCount > 0 && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -1,
            right: -1,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--c-pending)",
            border: "1.5px solid var(--c-canvas)",
            display: "block",
          }}
        />
      )}
    </button>
  );
}
