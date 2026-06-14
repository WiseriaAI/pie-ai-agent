import type { CSSProperties, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface PopoverProps {
  /** true: mount + animate in. false: animate out, then unmount. */
  open: boolean;
  /** Positioning (left/top/bottom/…) measured by the CALLER — Popover owns only
   *  mount + animation, never placement. Merged onto the portaled element. */
  style?: CSSProperties;
  className?: string;
  /** Forwarded onto the portaled element so the caller can run outside-click /
   *  measurement against it. */
  popoverRef?: RefObject<HTMLDivElement | null>;
  /** e.g. "dialog" / "menu" — forwarded for a11y. */
  role?: string;
  children: ReactNode;
}

/** Portaled popover with scale+fade enter/exit. Replaces the hand-rolled
 *  mounted/shown + double-RAF + onTransitionEnd dance: AnimatePresence keeps the
 *  node mounted through the exit animation, so close is animated and unmounts on
 *  its own. Portaled to document.body so ancestor overflow/stacking never clips
 *  it. */
export function Popover({ open, style, className, popoverRef, role, children }: PopoverProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          ref={popoverRef}
          role={role}
          style={style}
          className={className}
          initial={{ opacity: 0, scale: 0.96, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 4 }}
          transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
