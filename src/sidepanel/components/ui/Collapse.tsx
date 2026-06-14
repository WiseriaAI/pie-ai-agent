import type { ReactNode } from "react";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface CollapseProps {
  /** true: mount + animate open. false: animate closed, then unmount. */
  open: boolean;
  children: ReactNode;
  /** Classes on the animating wrapper (e.g. spacing/border on the revealed
   *  block). */
  className?: string;
}

/** Two-way height-auto expand/collapse. motion animates height 0 ↔ "auto"
 *  (it measures the content); AnimatePresence keeps the node mounted through
 *  the exit animation so CLOSING is animated too — fixing the common
 *  "open animates, close just unmounts" asymmetry. overflow-hidden clips the
 *  content while height is mid-transition. */
export function Collapse({ open, children, className }: CollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
          style={{ overflow: "hidden" }}
          className={className}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
