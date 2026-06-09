import type {
  AtlasFingerprint,
  AtlasTargetType,
  PageAtlasState,
  ResolveTargetArgs,
  ResolveTargetResult,
} from "./types";

const DEFAULT_TTL_MS = 120_000;

export interface PageAtlasStore {
  save(atlas: PageAtlasState): void;
  get(atlasId: string): PageAtlasState | undefined;
  clear(): void;
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

function comparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function fingerprintsMatch(expected: AtlasFingerprint, actual: AtlasFingerprint): boolean {
  return (
    comparableUrl(expected.url) === comparableUrl(actual.url)
    && expected.bodyTextLengthBucket === actual.bodyTextLengthBucket
    && expected.interactiveCountBucket === actual.interactiveCountBucket
    && expected.topSectionCount === actual.topSectionCount
  );
}

export function createPageAtlasStore(
  options: { ttlMs?: number } = {},
): PageAtlasStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const atlases = new Map<string, PageAtlasState>();

  return {
    save(atlas) {
      atlases.set(atlas.atlasId, atlas);
    },

    get(atlasId) {
      return atlases.get(atlasId);
    },

    clear() {
      atlases.clear();
    },

    resolveTarget(args) {
      const atlas = atlases.get(args.atlasId);
      if (!atlas) {
        return {
          ok: false,
          reason: "atlas_not_found",
          message: 'Call read_page({mode:"atlas"}) first, then use a target_id from that atlas.',
        };
      }

      if (atlas.tabId !== args.tabId) {
        return {
          ok: false,
          reason: "tab_mismatch",
          message: `atlas ${args.atlasId} belongs to tab ${atlas.tabId}, not tab ${args.tabId}`,
        };
      }

      if (
        !Number.isFinite(args.now)
        || !Number.isFinite(atlas.createdAt)
        || args.now - atlas.createdAt > ttlMs
      ) {
        atlases.delete(args.atlasId);
        return {
          ok: false,
          reason: "atlas_expired",
          message: 'The page atlas is stale. Call read_page({mode:"atlas"}) again.',
        };
      }

      const currentOrigin = parseOrigin(args.currentUrl);
      if (
        currentOrigin !== atlas.origin
        || ((currentOrigin === null || atlas.origin === null) && args.currentUrl !== atlas.url)
      ) {
        return {
          ok: false,
          reason: "origin_changed",
          message: 'The page origin changed since the atlas was created. Call read_page({mode:"atlas"}) again.',
        };
      }

      if (comparableUrl(args.currentUrl) !== comparableUrl(atlas.url)) {
        return {
          ok: false,
          reason: "page_changed",
          message: 'The page URL changed since the atlas was created. Call read_page({mode:"atlas"}) again.',
        };
      }

      if (args.currentFingerprint && !fingerprintsMatch(atlas.fingerprint, args.currentFingerprint)) {
        return {
          ok: false,
          reason: "page_changed",
          message: 'The page structure changed since the atlas was created. Call read_page({mode:"atlas"}) again.',
        };
      }

      const target = atlas.targets.find((candidate) => candidate.id === args.targetId);
      if (!target) {
        return {
          ok: false,
          reason: "target_not_found",
          message: `target ${args.targetId} does not exist in atlas ${args.atlasId}. Call read_page({mode:"atlas"}) again.`,
        };
      }

      if (!isAllowedType(target.type, args.allowedTypes)) {
        return {
          ok: false,
          reason: "unsupported_target_type",
          message: `target ${target.id} is type ${target.type}; expected ${args.allowedTypes.join(" or ")}`,
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

function isAllowedType(actual: AtlasTargetType, allowedTypes: AtlasTargetType[]) {
  return allowedTypes.includes(actual);
}

export const pageAtlasStore = createPageAtlasStore();
