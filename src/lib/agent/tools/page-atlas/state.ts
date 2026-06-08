import type {
  AtlasTargetType,
  PageAtlasState,
  ResolveTargetArgs,
  ResolveTargetResult,
} from "./types";

const DEFAULT_TTL_MS = 60_000;

export interface PageAtlasStore {
  save(atlas: PageAtlasState): PageAtlasState;
  get(atlasId: string): PageAtlasState | undefined;
  clear(atlasId?: string): void;
  resolveTarget(args: ResolveTargetArgs): ResolveTargetResult;
}

export function parseOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function createPageAtlasStore(
  options: { ttlMs?: number } = {},
): PageAtlasStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const atlases = new Map<string, PageAtlasState>();

  const isExpired = (atlas: PageAtlasState, now: number) =>
    now - atlas.createdAt > ttlMs;

  return {
    save(atlas) {
      atlases.set(atlas.atlasId, atlas);
      return atlas;
    },

    get(atlasId) {
      return atlases.get(atlasId);
    },

    clear(atlasId) {
      if (atlasId) {
        atlases.delete(atlasId);
        return;
      }
      atlases.clear();
    },

    resolveTarget(args) {
      const atlas = atlases.get(args.atlasId);
      if (!atlas) {
        return {
          ok: false,
          reason: "atlas_not_found",
          message: `atlas ${args.atlasId} not found`,
        };
      }

      if (atlas.tabId !== args.tabId) {
        return {
          ok: false,
          reason: "tab_mismatch",
          message: `atlas ${args.atlasId} belongs to tab ${atlas.tabId}; current tab is ${args.tabId}`,
        };
      }

      const now = args.now ?? Date.now();
      if (isExpired(atlas, now)) {
        atlases.delete(args.atlasId);
        return {
          ok: false,
          reason: "atlas_expired",
          message: `atlas ${args.atlasId} expired`,
        };
      }

      const currentOrigin = parseOrigin(args.currentUrl);
      if (currentOrigin !== atlas.origin) {
        return {
          ok: false,
          reason: "origin_changed",
          message: `atlas ${args.atlasId} was captured on origin ${atlas.origin ?? "unknown"}; current origin is ${currentOrigin ?? "unknown"}`,
        };
      }

      const target = atlas.targets.find((candidate) => candidate.id === args.targetId);
      if (!target) {
        return {
          ok: false,
          reason: "target_not_found",
          message: `target ${args.targetId} not found`,
        };
      }

      if (!isExpectedType(target.type, args.expectedType)) {
        return {
          ok: false,
          reason: "unsupported_target_type",
          message: `target ${args.targetId} is type ${target.type}; expected ${formatExpectedType(args.expectedType)}`,
        };
      }

      return {
        ok: true,
        atlas,
        target,
      };
    },
  };
}

function isExpectedType(
  actual: AtlasTargetType,
  expected: ResolveTargetArgs["expectedType"],
) {
  if (!expected) return true;
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function formatExpectedType(expected: ResolveTargetArgs["expectedType"]) {
  if (!expected) return "any";
  if (Array.isArray(expected)) return expected.join(" or ");
  return expected;
}

export const pageAtlasStore = createPageAtlasStore();
