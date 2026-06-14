import type { ButtonHTMLAttributes, ReactNode } from "react";

type Size = "xs" | "sm" | "md";
type Variant = "default" | "ghost";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label — REQUIRED for an icon-only button. */
  "aria-label": string;
  icon: ReactNode;
  size?: Size;
  variant?: Variant;
  /** Active / pressed visual state (e.g. a toggle that is currently on). */
  active?: boolean;
}

const SIZE: Record<Size, string> = {
  xs: "h-6 w-6", // 24px
  sm: "h-7 w-7", // 28px
  md: "h-8 w-8", // 32px
};

// Base (non-color) classes per variant. Border-color / text-color are resolved
// by `tone()` instead, so the active state is OWNED here and can't be lost to
// Tailwind class-ordering (active never emits the inactive border class).
const VARIANT_BASE: Record<Variant, string> = {
  default: "border bg-surface",
  ghost: "bg-transparent",
};

function tone(variant: Variant, active: boolean): string {
  if (variant === "default") {
    return active
      ? "border-accent text-fg-1"
      : "border-line text-fg-2 hover:border-fg-3 hover:text-fg-1";
  }
  // ghost
  return active
    ? "bg-field text-fg-1"
    : "text-fg-2 hover:bg-field hover:text-fg-1";
}

export function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  active = false,
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-chip",
        "transition-[background-color,border-color,color] duration-150 ease-out",
        "disabled:opacity-30 disabled:pointer-events-none",
        SIZE[size],
        VARIANT_BASE[variant],
        tone(variant, active),
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
