import { useId } from "react";

/**
 * The multi-colour mesh-gradient sparkle, shared by ManagedPlanIcon and the
 * standalone MeshSparkle. Four soft radial blobs aimed at the four arms over a
 * neutral base star — purple↑ / clay→ / green↓ / blue← — so all four hues read
 * without any one dominating, and the (quiet, warm) clay on the right keeps
 * that arm crisp instead of merging into the cool blobs.
 *
 * Renders raw SVG children (defs + paths) in the 0–128 coordinate space, so it
 * drops straight into any <svg> whose geometry matches the brand mark
 * (ManagedPlanIcon's full 128 viewBox, or MeshSparkle's bite-cropped one).
 *
 * Source of truth mirrored by the static assets `public/icons/managed-plan.svg`
 * and `public/icons/mesh-sparkle.svg` (rasterised to PNG via `pnpm icons`).
 */

/** Fat 4-point sparkle seated at (98,28) — the brand mark's top-right bite. */
const STAR =
  "M98 11 Q100.55 25.45 115 28 Q100.55 30.55 98 45 Q95.45 30.55 81 28 Q95.45 25.45 98 11 Z";

export function SparkleGlyph({ idPrefix }: { idPrefix: string }) {
  const t = `${idPrefix}-t`;
  const r = `${idPrefix}-r`;
  const b = `${idPrefix}-b`;
  const l = `${idPrefix}-l`;
  return (
    <>
      <defs>
        <radialGradient id={t} gradientUnits="userSpaceOnUse" cx="98" cy="15" r="11">
          <stop offset="0" stopColor="#A234EA" />
          <stop offset="1" stopColor="#A234EA" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={r} gradientUnits="userSpaceOnUse" cx="111" cy="28" r="11">
          <stop offset="0" stopColor="#C9886A" />
          <stop offset="1" stopColor="#C9886A" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={b} gradientUnits="userSpaceOnUse" cx="98" cy="41" r="12">
          <stop offset="0" stopColor="#18B85C" />
          <stop offset="1" stopColor="#18B85C" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={l} gradientUnits="userSpaceOnUse" cx="85" cy="28" r="12">
          <stop offset="0" stopColor="#2D6BF0" />
          <stop offset="1" stopColor="#2D6BF0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={STAR} fill="#6E7090" />
      <path d={STAR} fill={`url(#${t})`} />
      <path d={STAR} fill={`url(#${r})`} />
      <path d={STAR} fill={`url(#${b})`} />
      <path d={STAR} fill={`url(#${l})`} />
    </>
  );
}

/**
 * Standalone reusable mesh sparkle (no pie/container) — e.g. a "premium / paid"
 * marker. viewBox is cropped to the sparkle's bounding box, so it is pixel-
 * identical to the sparkle inside ManagedPlanIcon.
 */
export function MeshSparkle({
  size = 24,
  className,
  title,
}: {
  size?: number | string;
  className?: string;
  /** When set, the icon is exposed to a11y as an image with this label. */
  title?: string;
}) {
  const idPrefix = `ms-${useId().replace(/:/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="80 10 36 36"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <SparkleGlyph idPrefix={idPrefix} />
    </svg>
  );
}

export default MeshSparkle;
