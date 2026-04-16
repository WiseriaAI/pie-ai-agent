export type ElementRegion = "main" | "nav" | "footer" | "aside" | "header" | "other";

export interface ElementInfo {
  index: number;
  tag: string;
  type?: string;
  role?: string;
  text: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled: boolean;
  region: ElementRegion;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
}

export interface ActionResult {
  success: boolean;
  observation?: string;
  error?: string;
}
