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
  /** Where the popover sits relative to its trigger, so the slide originates
   *  from the trigger. "below" (default): slides down-in from above (up-out).
   *  "above": slides up-in from below (down-out). */
  placement?: "above" | "below";
  children: ReactNode;
}

/** Portaled popover with slide+fade enter/exit. Replaces the hand-rolled
 *  mounted/shown + double-RAF + onTransitionEnd dance: AnimatePresence keeps the
 *  node mounted through the exit animation, so close is animated and unmounts on
 *  its own. Portaled to document.body so ancestor overflow/stacking never clips
 *  it. */
export function Popover({ open, style, className, popoverRef, role, placement = "below", children }: PopoverProps) {
  // Slide originates from the trigger: a popover ABOVE its trigger slides up
  // from below (+y), one BELOW slides down from above (−y).
  const dy = placement === "above" ? 8 : -8;
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          ref={popoverRef}
          role={role}
          style={style}
          className={className}
          initial={{ opacity: 0, y: dy }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: dy }}
          transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
