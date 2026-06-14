import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

// Distilled from existing buttons (InstanceForm.tsx:283-307).
const VARIANT: Record<Variant, string> = {
  primary: "bg-fg-1 text-canvas font-medium hover:opacity-90 active:opacity-80",
  secondary:
    "border border-line bg-transparent text-fg-2 hover:border-fg-3 hover:text-fg-1",
  ghost: "bg-transparent text-fg-2 hover:bg-field hover:text-fg-1",
  danger: "bg-transparent text-warning hover:bg-warning-tint",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[12px]", // 32px — 现状主力高度
  md: "h-9 px-4 text-[13px]", // 36px
};

export function Button({
  variant = "secondary",
  size = "sm",
  iconLeft,
  iconRight,
  loading = false,
  fullWidth = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-control",
        "transition-[opacity,background-color,border-color,color] duration-150 ease-out",
        "disabled:opacity-30 disabled:pointer-events-none",
        VARIANT[variant],
        SIZE[size],
        fullWidth ? "w-full" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {loading ? <Spinner /> : iconLeft}
      {children}
      {/* iconRight is intentionally hidden while loading — the Spinner occupies the leading slot */}
      {!loading && iconRight}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      <path d="M14 8A6 6 0 1 1 2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
