// Types
export type {
  ActionResult,
} from "./types";

// DOM action functions (injected into target page via executeScript)
export { clickByIndex } from "./click";
export { typeByIndex } from "./type";
export { scroll } from "./scroll";
export { selectByIndex } from "./select";

// Service Worker action (NOT injected into page)
export { wait } from "./wait";
