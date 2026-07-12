/**
 * Borderless ("无界") primitives for the Vailie redesign. These encode the
 * interaction rules the whole redesign leans on — pin them as code, not prose:
 *
 *   1. Zero borders / dividers. Hierarchy = background micro-difference +
 *      spacing + soft shadow. Never a 1px line.
 *   2. Buttons are silent bare icons; hover lights a soft field/tint ground.
 *   3. Hover is NOT the only affordance: focus-visible always shows a ring
 *      (side panel is desktop, but keyboard a11y still holds).
 *
 * Utility class names (bg-field, text-fg-2, ...) come from the @theme mapping
 * in tokens.css and match the existing codebase convention.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

/* ── IconButton ─────────────────────────────────────────────────────────
 * Silent → hover-lit. `active` paints the accent-tint pressed/selected look
 * (e.g. the open menu icon). focus-visible ring via ring utilities. */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: number; // px hit-target; icon sizes itself. Default 44 (wide top bar).
  active?: boolean;
  children: ReactNode; // an svg
}
export function IconButton({ size = 44, active, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      style={{ width: size, height: size }}
      className={
        "flex items-center justify-center rounded-[12px] transition-colors " +
        "text-fg-2 hover:bg-field hover:text-fg-1 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line " +
        (active ? "bg-accent-tint text-accent-strong " : "") +
        (className ?? "")
      }
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Card ── surface + soft shadow, no border. radius 16, shadow 0 4px 16px. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={
        "bg-surface rounded-[16px] p-5 shadow-[0_4px_16px_rgba(21,25,31,0.05)] " +
        (className ?? "")
      }
    >
      {children}
    </div>
  );
}

/* ── SegmentedTabs ── active = white pill + tiny shadow; labels CENTERED. */
export interface SegmentedTabsProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}
export function SegmentedTabs<T extends string>({ options, value, onChange }: SegmentedTabsProps<T>) {
  return (
    <div className="flex bg-field rounded-[12px] p-[3px]" role="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={
              "flex-1 text-center text-[13px] py-2 rounded-[9px] transition-colors " +
              (on
                ? "bg-surface text-fg-1 font-medium shadow-[0_1px_4px_rgba(21,25,31,0.08)]"
                : "text-fg-2")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── StatusPill ── dot + label; success / warning / neutral. */
export function StatusPill({ tone, label }: { tone: "success" | "warning" | "neutral"; label: string }) {
  const map = {
    success: "bg-success-tint text-success",
    warning: "bg-warning-tint text-warning-fg",
    neutral: "bg-field text-fg-2",
  } as const;
  const dot = { success: "bg-success", warning: "bg-warning", neutral: "bg-fg-3" } as const;
  return (
    <span className={`inline-flex items-center gap-[5px] rounded-[9px] px-[9px] py-[3px] text-[11px] ${map[tone]}`}>
      <span className={`w-[5px] h-[5px] rounded-full ${dot[tone]}`} />
      {label}
    </span>
  );
}

/* ── QuotaBar ── weekly quota; fill colour bands by used fraction. */
export function QuotaBar({ usedFraction, resetLabel }: { usedFraction: number; resetLabel: string }) {
  const pct = Math.round(usedFraction * 100);
  const band =
    usedFraction >= 0.95 ? { fill: "bg-warning", text: "text-warning-fg" }
    : usedFraction >= 0.8 ? { fill: "bg-pending", text: "text-pending" }
    : { fill: "bg-fg-1", text: "text-fg-1" };
  return (
    <div className="flex flex-col gap-[6px] bg-canvas rounded-[12px] px-[14px] py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] tracking-[0.1em] font-medium text-fg-3">
          本周 · {resetLabel}重置
        </span>
        <span className={`text-[14px] font-semibold ${band.text}`}>
          {pct}%<span className="text-[11px] font-normal text-fg-3"> 已用</span>
        </span>
      </div>
      <div className="h-2 rounded-[4px] bg-line">
        <div className={`h-2 rounded-[4px] ${band.fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
