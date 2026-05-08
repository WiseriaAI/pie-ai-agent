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

  // Semantic snapshot (#44 P0): set only when distinct from existing fields.
  // label: resolved form label via <label for> / aria-labelledby / ancestor <label>.
  //        NOT duplicated from ariaLabel/placeholder (dedupe at collection time).
  // error: resolved validation message via aria-invalid=true + aria-describedby.
  label?: string;
  error?: string;
}

export interface PageSemantic {
  headings: Array<{ level: 1 | 2 | 3; text: string }>;
  alerts: string[];
  status: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
  // Always present; may have all-empty arrays. Renderer skips empty sub-sections.
  semantic: PageSemantic;
}

export interface ActionResult {
  success: boolean;
  observation?: string;
  error?: string;
}
