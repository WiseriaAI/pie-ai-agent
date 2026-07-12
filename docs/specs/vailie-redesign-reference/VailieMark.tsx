/**
 * VailieMark — the brand IP: a borderless gradient blob that IS the assistant.
 *
 * Static frame is always a CLEAN CIRCLE with edges dissolving to transparent
 * (no outline, no shadow, no clip edge — the shape is defined purely by colour
 * fading to alpha 0). Motion is the only thing that lets the shape deform;
 * every animation returns to the circle. Silver-grey body, sky-blue welling up
 * from below, a peach filament in the upper-right — the 60/30/10 mix.
 *
 * States (mesh + motion):
 *   idle      — balanced; 8s breathe, barely perceptible
 *   thinking  — peach filament stirs; 2.4s quicker pulse ("it's thinking")
 *   working   — denser, blue-forward; directional churn ("acting on the page")
 *   done      — peach bloom then settle back to idle
 *   recording — peach-forward variant used as the recording indicator
 *
 * Pure CSS gradients, no deps. Honours prefers-reduced-motion (motion off).
 * Keyframes live in vailie-mark.css (import once, e.g. in index.css).
 */
import type { CSSProperties } from "react";

export type VailieState = "idle" | "thinking" | "working" | "done" | "recording";

/** Layered radial-gradient recipe per state. Ellipse %s are relative to the
 *  square box, so the blob scales with `size` with no re-tuning. Peach/blue
 *  brighten in dark mode via the alpha-only fade against a lighter core. */
const MESH: Record<VailieState, string> = {
  idle:
    "radial-gradient(24% 15% at 54% 42%, rgba(255,179,194,.35) 0%, rgba(255,179,194,0) 90%)," +
    "radial-gradient(26% 22% at 66% 26%, rgba(255,179,194,.65) 0%, rgba(255,179,194,0) 86%)," +
    "radial-gradient(34% 40% at 36% 56%, rgba(124,184,255,.65) 0%, rgba(124,184,255,0) 88%)," +
    "radial-gradient(40% 24% at 58% 72%, rgba(124,184,255,.55) 0%, rgba(124,184,255,0) 88%)," +
    "radial-gradient(28% 24% at 30% 28%, rgba(213,222,231,.85) 0%, rgba(213,222,231,0) 85%)," +
    "radial-gradient(56% 50% at 50% 46%, rgba(199,210,222,1) 0%, rgba(207,217,228,0) 85%)",
  thinking:
    "radial-gradient(30% 18% at 48% 34%, rgba(255,179,194,.55) 0%, rgba(255,179,194,0) 88%)," +
    "radial-gradient(20% 16% at 68% 52%, rgba(255,179,194,.5) 0%, rgba(255,179,194,0) 86%)," +
    "radial-gradient(30% 34% at 40% 62%, rgba(124,184,255,.75) 0%, rgba(124,184,255,0) 86%)," +
    "radial-gradient(34% 20% at 62% 74%, rgba(124,184,255,.6) 0%, rgba(124,184,255,0) 86%)," +
    "radial-gradient(50% 44% at 50% 50%, rgba(199,210,222,1) 0%, rgba(207,217,228,0) 84%)",
  working:
    "radial-gradient(20% 13% at 60% 34%, rgba(255,179,194,.5) 0%, rgba(255,179,194,0) 86%)," +
    "radial-gradient(38% 30% at 42% 58%, rgba(124,184,255,.85) 0%, rgba(124,184,255,0) 84%)," +
    "radial-gradient(44% 22% at 60% 66%, rgba(124,184,255,.7) 0%, rgba(124,184,255,0) 84%)," +
    "radial-gradient(44% 40% at 50% 50%, rgba(199,210,222,1) 0%, rgba(207,217,228,0) 82%)",
  done:
    "radial-gradient(30% 24% at 64% 26%, rgba(255,179,194,.8) 0%, rgba(255,179,194,0) 88%)," +
    "radial-gradient(26% 18% at 46% 40%, rgba(255,179,194,.4) 0%, rgba(255,179,194,0) 90%)," +
    "radial-gradient(36% 42% at 36% 58%, rgba(124,184,255,.6) 0%, rgba(124,184,255,0) 90%)," +
    "radial-gradient(42% 26% at 60% 74%, rgba(124,184,255,.5) 0%, rgba(124,184,255,0) 90%)," +
    "radial-gradient(60% 54% at 50% 46%, rgba(203,214,226,1) 0%, rgba(210,220,230,0) 88%)",
  recording:
    "radial-gradient(30% 30% at 54% 30%, rgba(255,159,178,1) 0%, rgba(255,159,178,0) 70%)," +
    "radial-gradient(24% 24% at 66% 60%, rgba(255,159,178,.6) 0%, rgba(255,159,178,0) 68%)," +
    "radial-gradient(44% 44% at 40% 60%, rgba(124,184,255,.9) 0%, rgba(124,184,255,0) 72%)," +
    "radial-gradient(48% 48% at 50% 48%, rgba(196,208,222,1) 0%, rgba(207,217,228,0) 94%)",
};

export interface VailieMarkProps {
  /** px diameter of the (square) box. Default 28 — the top-bar size. */
  size?: number;
  state?: VailieState;
  /** G3 motion budget: ≤2 animated instances on screen (top-bar idle + the
   *  active turn). History rows and done lists MUST pass animate={false} —
   *  state mesh still renders, motion (and will-change) fully off. */
  animate?: boolean;
  className?: string;
  /** Accessible label; omit for decorative instances (aria-hidden). */
  label?: string;
}

export function VailieMark({ size = 28, state = "idle", animate = true, className, label }: VailieMarkProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    // no border, no boxShadow, no borderRadius clip — edges are the gradient.
    backgroundImage: MESH[state],
  };
  return (
    <span
      className={`vailie-mark vailie-mark--${state}${animate ? "" : " vailie-mark--static"}${className ? " " + className : ""}`}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export default VailieMark;
