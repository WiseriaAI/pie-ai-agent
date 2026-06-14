import { useState, useEffect, useCallback, type RefObject } from "react";

/** Tracks an anchor element's viewport rect while `open`, re-measuring on window
 *  resize and any scroll (capture phase, so an inner scroll container counts
 *  too). Returns null when closed or before the first measure.
 *
 *  The caller derives popover coords from the rect — placement and clamping stay
 *  caller-specific (a top-bar dropdown opens straight down; ModelPicker flips up
 *  when cramped). This centralizes only the measure + listener boilerplate that
 *  is easy to get wrong (the scroll listener MUST use the capture phase or an
 *  inner scroll container won't fire it). Pair with a portaled <Popover>. */
export function useAnchorRect(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    const el = anchorRef.current;
    if (el) setRect(el.getBoundingClientRect());
  }, [anchorRef]);

  useEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    measure();
    const onResize = () => measure();
    const onScroll = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  return rect;
}
