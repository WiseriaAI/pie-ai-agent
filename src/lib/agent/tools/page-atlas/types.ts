export type AtlasTargetType = "collection" | "table" | "detail_region" | "region";

export type AtlasConfidence = "high" | "medium" | "low";

export interface AtlasFieldGuess {
  name: string;
  confidence: AtlasConfidence;
}

export interface AtlasRecord {
  id: string;
  fields: Record<string, string>;
  text: string;
  evidence: string;
}

export interface AtlasTarget {
  id: string;
  type: AtlasTargetType;
  label: string;
  frameId: number;
  confidence: AtlasConfidence;
  summary: string;
  fieldGuesses?: AtlasFieldGuess[];
  columns?: string[];
  records?: AtlasRecord[];
  visibleCount?: number;
  estimatedTotal?: number;
  cursor?: string;
}

export interface AtlasControl {
  id: string;
  frameId: number;
  pieIdx: number;
  type: string;
  label: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface AtlasForm {
  id: string;
  label: string;
  frameId: number;
  fields: string[];
  submitControlId?: string;
}

export interface AtlasControlGroup {
  id: string;
  label: string;
  frameId: number;
  controls: string[];
}

export interface AtlasNavigation {
  id: string;
  type: "pagination" | "tabs" | "breadcrumbs" | "links";
  label: string;
  frameId: number;
  controls: string[];
}

export interface AtlasFingerprint {
  url: string;
  title: string;
  bodyTextLengthBucket: number;
  interactiveCountBucket: number;
  topSectionCount: number;
}

export interface PageAtlasState {
  atlasId: string;
  tabId: number;
  url: string;
  origin: string | null;
  title: string;
  createdAt: number;
  fingerprint: AtlasFingerprint;
  targets: AtlasTarget[];
  controls: AtlasControl[];
  forms: AtlasForm[];
  controlGroups: AtlasControlGroup[];
  navigation: AtlasNavigation[];
}

export type PageAtlasResolveFailureReason =
  | "atlas_not_found"
  | "tab_mismatch"
  | "atlas_expired"
  | "origin_changed"
  | "target_not_found"
  | "unsupported_target_type";

export interface ResolveTargetArgs {
  atlasId: string;
  targetId: string;
  tabId: number;
  currentUrl: string;
  allowedTypes: AtlasTargetType[];
  now: number;
}

export type ResolveTargetResult =
  | {
      ok: true;
      atlas: PageAtlasState;
      target: AtlasTarget;
    }
  | {
      ok: false;
      reason: PageAtlasResolveFailureReason;
      message: string;
    };
