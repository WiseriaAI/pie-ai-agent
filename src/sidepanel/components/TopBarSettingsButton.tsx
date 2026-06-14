import { useT } from "@/lib/i18n";
import { IconButton } from "./ui/IconButton";

/**
 * TopBarSettingsButton — gear button that opens / closes the settings view.
 * 24×24, hairline border, surface bg, ice-silver gear icon. isActive=true
 * switches the border to accent to indicate the settings view is open.
 */

interface TopBarSettingsButtonProps {
  isActive: boolean;
  onClick: () => void;
}

export default function TopBarSettingsButton({
  isActive,
  onClick,
}: TopBarSettingsButtonProps) {
  const t = useT();
  return (
    <IconButton
      size="xs"
      variant="default"
      active={isActive}
      onClick={onClick}
      aria-label={isActive ? t("topBar.closeSettings") : t("topBar.openSettings")}
      aria-pressed={isActive}
      icon={
        // 6-tooth cog silhouette (Heroicons mini cog), filled accent.
        <svg width="12" height="12" viewBox="0 0 20 20" fill="var(--c-accent)">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.993 6.993 0 0 1 7.51 3.456l.33-1.652zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
          />
        </svg>
      }
    />
  );
}
