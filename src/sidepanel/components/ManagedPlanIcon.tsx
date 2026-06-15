import { useId } from "react";
import { SparkleGlyph } from "./MeshSparkle";

/**
 * Pie "official subscription" plan mark — the bitten-pie brand mark with a
 * multi-colour mesh-gradient sparkle nested in the bite, signalling the paid /
 * managed tier (vs the monochrome BYOK base mark). The body stays strictly
 * two-tone (#14181D base / #FAFBFC pie); only the sparkle carries colour
 * (see SparkleGlyph, reused here and by the standalone MeshSparkle).
 *
 * Source of truth mirrored by `public/icons/managed-plan.svg` (rasterised to
 * PNG via `pnpm icons`). Standalone / reserve component: not wired into any
 * surface yet.
 */
export function ManagedPlanIcon({
  size = 24,
  className,
  title,
}: {
  size?: number | string;
  className?: string;
  /** When set, the icon is exposed to a11y as an image with this label. */
  title?: string;
}) {
  const idPrefix = `mp-${useId().replace(/:/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {/* Bitten-pie body — strictly two-tone */}
      <rect width="128" height="128" rx="26" fill="#14181D" />
      <circle cx="64" cy="64" r="44" fill="#FAFBFC" />
      <circle cx="98" cy="28" r="26" fill="#14181D" />
      {/* Multi-colour mesh sparkle in the bite */}
      <SparkleGlyph idPrefix={idPrefix} />
    </svg>
  );
}

export default ManagedPlanIcon;
