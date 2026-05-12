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

/**
 * iframe spec §3 — total element cap across all frames in a tab. Top frame
 * gets first slice of the budget; remaining frames consume in DOM order
 * until budget exhausted, after which frames are listed with elements: []
 * and truncated: true (visible to LLM as "frame has content but truncated",
 * not "frame is empty"). Top frame is never truncated even if it exceeds
 * MAX_ELEMENTS (kept ≤ MAX_ELEMENTS by snapshot.ts at injection time).
 */
export const MAX_TOTAL_ELEMENTS = 600;

/**
 * iframe spec §3 — per-frame visible-element cap. Enforced at INJECTION time
 * inside snapshot.ts (each frame's executeScript run is independent). Tab
 * total is enforced post-merge in SW (MAX_TOTAL_ELEMENTS).
 */
export const MAX_ELEMENTS_PER_FRAME = 200;

export interface ActionResult {
  success: boolean;
  observation?: string;
  error?: string;
}

/**
 * Per-frame injection return shape — what snapshotInteractiveElements
 * actually returns (one InjectionResult.result per frame). SW-side helper
 * composes the FrameSnapshot array from this + getAllFrames result.
 */
export interface FrameInjectionResult {
  url: string;
  title: string;
  elements: ElementInfo[];
  semantic: PageSemantic;
}
