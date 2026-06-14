import { useT } from "@/lib/i18n";
import { IconButton } from "./ui/IconButton";

/**
 * TopBarNewSessionButton — the + button that creates a new session.
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
    <IconButton
      size="xs"
      variant="default"
      onClick={onClick}
      aria-label={t("topBar.newSession")}
      icon={
        // + icon — 10×10 accent cross
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <rect x="4.25" y="0" width="1.5" height="10" rx="0.75" fill="var(--c-accent)" />
          <rect x="0" y="4.25" width="10" height="1.5" rx="0.75" fill="var(--c-accent)" />
        </svg>
      }
    />
  );
}
