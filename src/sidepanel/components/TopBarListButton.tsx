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
  const ariaLabel = `Open sessions list${pendingCount > 0 ? `, ${pendingCount} pending` : ""}`;

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
        border: `1px solid ${isOpen ? "#B8C8D6" : "#22272F"}`,
        background: "#14171C",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        cursor: "pointer",
        padding: 0,
      }}
    >
      {/* ≡ icon — three horizontal lines, 11×9 ice silver */}
      <svg
        width="11"
        height="9"
        viewBox="0 0 11 9"
        fill="none"
        aria-hidden="true"
      >
        <rect x="0" y="0" width="11" height="1.5" rx="0.75" fill="#B8C8D6" />
        <rect x="0" y="3.75" width="11" height="1.5" rx="0.75" fill="#B8C8D6" />
        <rect x="0" y="7.5" width="11" height="1.5" rx="0.75" fill="#B8C8D6" />
      </svg>

      {/* Warning dot — only rendered when pendingCount > 0 */}
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
            background: "#C260BE",
            border: "1.5px solid #080D10",
            display: "block",
          }}
        />
      )}
    </button>
  );
}
