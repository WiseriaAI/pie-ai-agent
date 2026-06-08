export type AtlasTargetType =
  | "collection"
  | "control"
  | "control_group"
  | "form"
  | "navigation"
  | "record"
  | "table"
  | (string & {});

export type PageAtlasResolveFailureReason =
  | "atlas_not_found"
  | "tab_mismatch"
  | "atlas_expired"
  | "origin_changed"
  | "target_not_found"
  | "unsupported_target_type";

export interface AtlasFingerprint {
  url?: string;
  origin?: string | null;
  title?: string;
  contentHash?: string;
  capturedAt?: number;
  [key: string]: unknown;
}

interface AtlasTargetBase {
  id: string;
  type: AtlasTargetType;
  label?: string;
  description?: string;
  frameId?: number;
  elementIndex?: number;
  selector?: string;
  fingerprint?: AtlasFingerprint;
  [key: string]: unknown;
}

export interface AtlasRecord extends AtlasTargetBase {
  type: "record";
  fields?: Record<string, unknown>;
}

export interface AtlasControl extends AtlasTargetBase {
  type: "control";
  role?: string;
  name?: string;
  disabled?: boolean;
  value?: unknown;
}

export interface AtlasForm extends AtlasTargetBase {
  type: "form";
  controls?: AtlasControl[];
  controlIds?: string[];
}

export interface AtlasControlGroup extends AtlasTargetBase {
  type: "control_group";
  controls?: AtlasControl[];
  controlIds?: string[];
}

export interface AtlasNavigation extends AtlasTargetBase {
  type: "navigation";
  href?: string;
  entries?: Array<{
    label?: string;
    href?: string;
    targetId?: string;
  }>;
}

export type AtlasTarget =
  | AtlasRecord
  | AtlasControl
  | AtlasForm
  | AtlasControlGroup
  | AtlasNavigation
  | (AtlasTargetBase & {
      type: Exclude<
        AtlasTargetType,
        "record" | "control" | "form" | "control_group" | "navigation"
      >;
    });

export interface PageAtlasState {
  atlasId: string;
  tabId: number;
  url: string;
  origin: string | null;
  createdAt: number;
  targets: AtlasTarget[];
  fingerprint?: AtlasFingerprint;
}

export interface ResolveTargetArgs {
  atlasId: string;
  tabId: number;
  currentUrl: string;
  targetId: string;
  expectedType?: AtlasTargetType | AtlasTargetType[];
  now?: number;
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
