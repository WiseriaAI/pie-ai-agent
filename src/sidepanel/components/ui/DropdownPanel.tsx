import type { CSSProperties, ReactNode } from "react";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface DropdownPanelProps {
  /** true: mount + animate in. false: animate out, then unmount. */
  open: boolean;
  /** Positioning + visual classes from the CALLER. Unlike <Popover> this panel
   *  is NOT portaled — it stays a DOM child of the trigger's container, so the
   *  caller keeps its existing CSS positioning (absolute relative to a
   *  `relative` parent, or normal flow) AND its outside-click `ref.contains`
   *  logic works unchanged. No coordinate math needed. */
  className?: string;
  /** e.g. "listbox" / "menu" — forwarded for a11y. */
  role?: string;
  style?: CSSProperties;
  /** Where the panel sits relative to its trigger, so the slide originates from
   *  the trigger. "below" (default): slides down-in from above (up-out).
   *  "above": slides up-in from below (down-out). */
  placement?: "above" | "below";
  children: ReactNode;
}

/** Inline (non-portaled) dropdown panel with slide+fade enter/exit. The
 *  trigger-hugging sibling of <Popover>: use this for menus that hug their
 *  trigger and never need to escape ancestor overflow/stacking (so no portal,
 *  no coordinate math). AnimatePresence keeps the node mounted through the exit
 *  animation, replacing one-shot `.scale-in` CSS that had no graceful close. */
export function DropdownPanel({
  open,
  className,
  role,
  style,
  placement = "below",
  children,
}: DropdownPanelProps) {
  // Slide originates from the trigger: a panel BELOW its trigger slides down
  // from above (−y), one ABOVE slides up from below (+y).
  const dy = placement === "above" ? 6 : -6;
  return (
    <AnimatePresence>
      {open && (
        <m.div
          role={role}
          className={className}
          style={style}
          initial={{ opacity: 0, y: dy }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: dy }}
          transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
