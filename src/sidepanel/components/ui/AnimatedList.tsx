import { useAutoAnimate } from "@formkit/auto-animate/react";

/** List auto-animation. Attach the returned ref to a list container; its direct
 *  children animate on add / remove / reorder. Honors prefers-reduced-motion
 *  automatically (auto-animate's default). Tuned to the design-system motion
 *  tokens (--duration-base 200ms / --ease-standard). */
export function useAnimatedList<T extends HTMLElement = HTMLElement>() {
  const [ref] = useAutoAnimate<T>({
    duration: 200, // --duration-base
    easing: "cubic-bezier(0.32, 0.72, 0, 1)", // --ease-standard
  });
  return ref;
}
