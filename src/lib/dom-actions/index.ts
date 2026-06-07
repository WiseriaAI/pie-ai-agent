// Types
export type {
  ActionResult,
} from "./types";

// DOM action functions (injected into target page via executeScript)
export { actByIdxInjected } from "./act-core";
export { scroll } from "./scroll";

// Service Worker action (NOT injected into page)
export { wait } from "./wait";
