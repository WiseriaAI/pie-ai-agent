import { useT } from "@/lib/i18n";
import { IconButton } from "./ui/IconButton";

/**
 * TopBarListButton — the ≡ hamburger button that toggles the SessionDrawer.
 *
 * Pending confirms across sessions (pendingCount > 0) surface a warning dot in
 * the top-right corner (island ring matches the canvas bg). When the drawer is
 * open (isOpen=true) the IconButton's active state switches the border to accent.
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
    <IconButton
      size="xs"
      variant="default"
      active={isOpen}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-expanded={isOpen}
      className="relative"
      icon={
        <>
          {/* ≡ icon — three horizontal lines, 11×9, accent color */}
          <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
            <rect x="0" y="0" width="11" height="1.5" rx="0.75" fill="var(--c-accent)" />
            <rect x="0" y="3.75" width="11" height="1.5" rx="0.75" fill="var(--c-accent)" />
            <rect x="0" y="7.5" width="11" height="1.5" rx="0.75" fill="var(--c-accent)" />
          </svg>
          {/* Warning dot — island ring matches the top-bar bg so it reads as
              floating above the button (carved-out ring effect). */}
          {pendingCount > 0 && (
            <span
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
        </>
      }
    />
  );
}
