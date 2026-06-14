import { LazyMotion, domAnimation, MotionConfig, m, AnimatePresence } from "motion/react";
import type { ReactNode } from "react";

/** Motion duration tokens in SECONDS — numeric mirrors of the CSS --duration-*
 *  tokens in index.css (140/200/260ms), so motion transitions and the residual
 *  CSS keyframes stay visually in lockstep. */
export const DURATION = { fast: 0.14, base: 0.2, slow: 0.26 } as const;

/** Mirror of --ease-standard (cubic-bezier(0.32,0.72,0,1)) as a motion easing
 *  tuple. */
export const EASE_STANDARD = [0.32, 0.72, 0, 1] as const;

/** App-wide motion provider.
 *  - `LazyMotion features={domAnimation}` loads ONLY the DOM-animation feature
 *    bundle (measured +31KB gzip vs +50KB for a full `motion` import).
 *  - `strict` makes `motion.*` throw, forcing every consumer onto the
 *    tree-shakeable `m.*`.
 *  - `MotionConfig reducedMotion="user"` makes all motion animations honor the
 *    OS prefers-reduced-motion setting (jump to final state, no movement),
 *    complementing the CSS @media (prefers-reduced-motion) guard in index.css. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

// Single import surface: UI primitives pull `m` / `AnimatePresence` from here
// (never directly from "motion/react"), keeping the m.*↔LazyMotion pairing and
// the strict-mode contract centralized.
export { m, AnimatePresence };
