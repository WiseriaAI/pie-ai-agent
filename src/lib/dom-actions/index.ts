// Types
export type {
  ElementRegion,
  ElementInfo,
  PageSnapshot,
  FrameSnapshot,
  ReachableFrameSnapshot,
  UnreachableFrameSnapshot,
  PageSemantic,
  FrameInjectionResult,
  ActionResult,
} from "./types";
export { MAX_TOTAL_ELEMENTS, MAX_ELEMENTS_PER_FRAME } from "./types";

// DOM action functions (injected into target page via executeScript)
export { snapshotInteractiveElements } from "./snapshot";
export { clickByIndex } from "./click";
export { typeByIndex } from "./type";
export { scroll } from "./scroll";
export { selectByIndex } from "./select";

// Service Worker action (NOT injected into page)
export { wait } from "./wait";
