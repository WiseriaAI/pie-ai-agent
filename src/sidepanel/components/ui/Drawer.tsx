// Drawer — motion-driven overlay dialog primitive.
//
// Owns the full overlay mechanic so consumers provide content only:
//   - AnimatePresence mount/unmount (replaces hand-rolled delayed-unmount +
//     double-rAF + setTimeout lifecycles)
//   - backdrop fade-in + click-to-close
//   - panel slide-in from an edge
//   - ESC-to-close, focus trap (Tab/Shift+Tab wrap), initial focus, focus
//     restore on close
//   - role=dialog + aria-modal + aria-label
//
// Non-portal, position:fixed inline (escapes layout via fixed + z-index) —
// matches the prior SessionDrawer behavior; no portal-to-body indirection.
// Honors prefers-reduced-motion via the app-wide MotionProvider
// (reducedMotion="user"), which the previous inline CSS transitions did not.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** Slide-in edge. Defaults to "left". */
  side?: "left" | "right";
  /** Panel width in px. */
  width?: number;
  /** Optional data-testid forwarded to the backdrop (lets consumers/tests target it). */
  backdropTestId?: string;
  /** Inline styles merged onto the panel (consumer owns bg/border/etc). */
  panelStyle?: CSSProperties;
  children: ReactNode;
}

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='listitem']",
].join(", ");

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

export function Drawer({
  open,
  onClose,
  ariaLabel,
  side = "left",
  width = 296,
  backdropTestId,
  panelStyle,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const preFocusRef = useRef<Element | null>(null);

  // Open lifecycle: capture + set initial focus; ESC + focus trap while open;
  // restore the pre-open focus on close. Guarded on `open` so listeners aren't
  // attached while the panel animates out.
  useEffect(() => {
    if (!open) return;

    preFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel) {
      const focusable = getFocusable(panel);
      if (focusable.length > 0) focusable[0]!.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const current = panelRef.current;
      if (!current) return;
      const focusable = getFocusable(current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (preFocusRef.current instanceof HTMLElement) preFocusRef.current.focus();
    };
  }, [open, onClose]);

  const offscreen = side === "left" ? "-100%" : "100%";

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            data-testid={backdropTestId}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
            style={{
              position: "fixed",
              inset: 0,
              background: "var(--c-overlay-strong)",
              zIndex: 40,
            }}
          />
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            initial={{ x: offscreen }}
            animate={{ x: 0 }}
            exit={{ x: offscreen }}
            transition={{ duration: DURATION.slow, ease: EASE_STANDARD }}
            style={{
              position: "fixed",
              top: 0,
              [side]: 0,
              width,
              height: "100%",
              zIndex: 50,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              ...panelStyle,
            }}
          >
            {children}
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}
