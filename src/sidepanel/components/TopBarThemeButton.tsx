import { useT } from "@/lib/i18n";
import { IconButton } from "./ui/IconButton";

/**
 * TopBarThemeButton — three-state theme toggle (light / dark / system).
 *
 * 24×24, hairline border, surface bg. Icon swaps with mode:
 *   - light  → sun (center circle + 8 short rays)
 *   - dark   → crescent moon
 *   - system → split circle (left half filled, right half outlined)
 *
 * Click cycles light → dark → system → light. Persistence is owned by the
 * parent (App.tsx); this is a pure controlled toggle that emits onModeChange.
 */

export type ThemeMode = "light" | "dark" | "system";

interface TopBarThemeButtonProps {
  mode: ThemeMode;
  onModeChange: (next: ThemeMode) => void;
}

function cycleTheme(current: ThemeMode): ThemeMode {
  if (current === "light") return "dark";
  if (current === "dark") return "system";
  return "light";
}

function modeLabel(mode: ThemeMode, t: ReturnType<typeof useT>): string {
  if (mode === "light") return t("topBar.themeLight");
  if (mode === "dark") return t("topBar.themeDark");
  return t("topBar.themeSystem");
}

function SunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="2" stroke="var(--c-accent)" strokeWidth="1.2" />
      <path
        d="M6 0.75v1.5M6 9.75v1.5M0.75 6h1.5M9.75 6h1.5M2.1 2.1l1.05 1.05M8.85 8.85l1.05 1.05M9.9 2.1L8.85 3.15M3.15 8.85L2.1 9.9"
        stroke="var(--c-accent)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      {/* Crescent: a full circle with an offset overlay using stroke-only path */}
      <path
        d="M9.5 7.6A4 4 0 1 1 4.4 2.5 3.2 3.2 0 0 0 9.5 7.6Z"
        stroke="var(--c-accent)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SystemIcon() {
  // Half-fill / half-outline circle: left side filled, right side outlined.
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="4" stroke="var(--c-accent)" strokeWidth="1.2" />
      <path d="M6 2 A4 4 0 0 0 6 10 Z" fill="var(--c-accent)" />
    </svg>
  );
}

export default function TopBarThemeButton({
  mode,
  onModeChange,
}: TopBarThemeButtonProps) {
  const t = useT();
  return (
    <IconButton
      size="xs"
      variant="default"
      onClick={() => onModeChange(cycleTheme(mode))}
      aria-label={modeLabel(mode, t)}
      title={modeLabel(mode, t)}
      icon={mode === "light" ? <SunIcon /> : mode === "dark" ? <MoonIcon /> : <SystemIcon />}
    />
  );
}
