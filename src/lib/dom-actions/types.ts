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

  label?: string;
  error?: string;
}

export interface PageSemantic {
  headings: Array<{ level: 1 | 2 | 3; text: string }>;
  alerts: string[];
  status: string[];
}

/**
 * iframe spec §3 — per-frame snapshot shape. SW-side helper composes these
 * from per-frame InjectionResult + webNavigation.getAllFrames diff.
 *
 * frames[0] is ALWAYS the top frame (frameId=0). Unreachable frames are
 * inlined alongside reachable ones — single-array design (spec Decisions row
 * "不可达 frame 表达").
 */
export type FrameSnapshot = ReachableFrameSnapshot | UnreachableFrameSnapshot;

export interface ReachableFrameSnapshot {
  frameId: number;
  frameUrl: string;
  origin: string;
  crossOrigin: boolean;          // origin !== topFrame.origin（top 永远 false）
  parentFrameId: number | null;  // top 为 null
  elements: ElementInfo[];
  truncated?: true;              // 元素超过本帧配额时
}

export interface UnreachableFrameSnapshot {
  frameId: number;
  frameUrl: string;
  origin: string | null;
  crossOrigin: boolean;
  parentFrameId: number | null;
  unreachable: true;
  reason: "sandbox" | "extension-child" | "about-blank" | "frame-error";
}

/**
 * iframe spec §3 — SW-level page snapshot, composed from per-frame
 * InjectionResult and a webNavigation frame tree.
 *
 * `semantic` is TOP-FRAME ONLY (plan-level decision; spec §3 schema does not
 * specify per-frame semantic). Rationale: cross-origin iframe semantic value
 * is low (LLM can read elements text) and per-frame semantic explosion adds
 * noise without commensurate signal.
 */
export interface PageSnapshot {
  url: string;     // top frame url
  title: string;  // top frame title
  frames: FrameSnapshot[];
  semantic: PageSemantic;  // top-frame only
}

export interface ActionResult {
  success: boolean;
  observation?: string;
  error?: string;
}

/**
 * Per-frame injection return shape used by frame-discovery.ts / getAllFramesAndDiff
 * to compose FrameSnapshot[] from injection results + webNavigation frame tree.
 */
export interface FrameInjectionResult {
  url: string;
  title: string;
  elements: ElementInfo[];
  semantic: PageSemantic;
}
