import type { ButtonHTMLAttributes, ReactNode } from "react";

type Size = "sm" | "md";
type Variant = "default" | "ghost";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label — REQUIRED for an icon-only button. */
  "aria-label": string;
  icon: ReactNode;
  size?: Size;
  variant?: Variant;
}

const SIZE: Record<Size, string> = {
  sm: "h-7 w-7", // 28px
  md: "h-8 w-8", // 32px
};

const VARIANT: Record<Variant, string> = {
  default:
    "border border-line bg-surface text-fg-2 hover:border-fg-3 hover:text-fg-1",
  ghost: "bg-transparent text-fg-2 hover:bg-field hover:text-fg-1",
};

export function IconButton({
  icon,
  size = "md",
  variant = "ghost",
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
        VARIANT[variant],
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
