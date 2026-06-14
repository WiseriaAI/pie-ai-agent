import { IconButton } from "./ui/IconButton";

/**
 * TopBarSchedulesButton — clock button that opens / closes the Schedules view.
 * 24×24 hairline-bordered surface; the border switches to accent (active) when
 * the Schedules view is open.
 */

interface Props {
  isActive: boolean;
  onClick: () => void;
}

export default function TopBarSchedulesButton({ isActive, onClick }: Props) {
  return (
    <IconButton
      size="xs"
      variant="default"
      active={isActive}
      onClick={onClick}
      aria-label={isActive ? "Close schedules" : "Open schedules"}
      aria-pressed={isActive}
      icon={
        // Clock face (stroke style) — reads as "scheduled / recurring".
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="7.25" stroke="var(--c-accent)" strokeWidth="1.4" />
          <path
            d="M10 6v4l2.5 2"
            stroke="var(--c-accent)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      }
    />
  );
}
