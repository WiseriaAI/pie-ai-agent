import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { m, DURATION, EASE_STANDARD } from "./motion";

/** Animates its own height to fit its content whenever that content's height
 *  changes — a provider dropdown opening, form fields appearing on select, tab
 *  content swapping, an error row showing. Unlike Collapse (open↔closed) this
 *  reacts to ANY content resize via ResizeObserver. It animates REAL height, so
 *  blocks below reflow smoothly instead of jumping. Honors prefers-reduced-
 *  motion through MotionConfig (animations snap to the end).
 *
 *  In layout-less test environments offsetHeight is 0; we keep height "auto"
 *  there so the wrapper is a transparent passthrough (no clipping, no resize). */
export function SmoothHeight({ children, className }: { children: ReactNode; className?: string }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      setHeight(h > 0 ? h : "auto");
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <m.div
      animate={{ height }}
      transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
      style={{ overflow: "hidden" }}
      className={className}
    >
      <div ref={innerRef}>{children}</div>
    </m.div>
  );
}
