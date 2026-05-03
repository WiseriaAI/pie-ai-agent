/**
 * TopBarThemeButton — three-state theme toggle (light / dark / system).
 *
 * 24×24, hairline border, surface bg. Icon swaps with mode:
 *   - light  → sun (center circle + 8 short rays)
 *   - dark   → crescent moon
 *   - system → split circle (left half filled, right half outlined)
 *
 * Click cycles light → dark → system → light. Persistence is owned by the
 * parent (App.tsx) — this component is a pure controlled toggle that emits
 * onModeChange and renders the icon for the given mode prop.
 *
 * Colors are hardcoded in M1; M3 will migrate to var(--c-*) tokens.
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

function modeLabel(mode: ThemeMode): string {
  if (mode === "light") return "Theme: light. Click for dark.";
  if (mode === "dark") return "Theme: dark. Click for system.";
  return "Theme: system. Click for light.";
}

function SunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4" stroke="var(--c-accent)" strokeWidth="1.2" />
      {/* Left semicircle filled */}
      <path d="M6 2 A4 4 0 0 0 6 10 Z" fill="var(--c-accent)" />
    </svg>
  );
}

export default function TopBarThemeButton({
  mode,
  onModeChange,
}: TopBarThemeButtonProps) {
  return (
    <button
      type="button"
      onClick={() => onModeChange(cycleTheme(mode))}
      aria-label={modeLabel(mode)}
      title={modeLabel(mode)}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        border: "1px solid var(--c-line)",
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
      {mode === "light" ? <SunIcon /> : mode === "dark" ? <MoonIcon /> : <SystemIcon />}
    </button>
  );
}
