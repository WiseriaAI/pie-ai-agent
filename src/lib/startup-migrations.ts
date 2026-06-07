// src/lib/startup-migrations.ts
//
// Single ordered startup-migration pipeline, shared by BOTH startup entry
// points (the service worker `src/background/index.ts` and the side panel
// `src/sidepanel/main.tsx`). Consolidating here is required for the V2→V3
// sweep (`migrateV2toV3`) to be race-free:
//
//   - All [MIGRATION-UPSTREAM] chrome.storage migrations MUST finish before the
//     sweep, because the sweep reads the final settled chrome.storage state and
//     then `chrome.storage.local.clear()`s it.
//   - The sweep MUST finish before anything reads an IDB store (session list,
//     instances, config) — otherwise a reader sees an empty IDB while the data
//     is still sitting in chrome.storage.
//   - IDB-post migrations (e.g. `migrateLegacyKeyboardFlag`, which now reads the
//     config-store) MUST run AFTER the sweep, or they read an empty config-store.
//
// The SW and the panel are independent contexts that boot in parallel, so mere
// call-ordering inside one file is not enough. Both contexts await the SAME
// `runStartupMigrations()` promise. Whichever context wins runs the pipeline;
// the loser's call either shares the in-context singleton or — across contexts —
// no-ops because every step is idempotent (the sweep via `schema_version===3`,
// the upstream migrations via their own sentinels).
import { migrateV1toV2 } from "@/lib/migration-v2";
import { migrateInstanceModel } from "@/lib/migrate-instance-model";
import { migrateSkillsEnabledAllOn } from "@/lib/skills/migration-enabled-v1";
import { cleanupThinShellSkills } from "@/lib/skills/migration-cleanup-thinshell";
import { migrateSkillsToPackages } from "@/lib/skills/migration-packages";
import { cleanupLegacySkipPermissions } from "@/background/cleanup-migration";
import { runSessionMigrations } from "@/lib/sessions/migration";
import { migrateLegacyKeyboardFlag } from "@/lib/cdp-input-enabled";
import { migrateV2toV3 } from "@/lib/migration-v3";

let pipelinePromise: Promise<void> | null = null;

async function runPipeline(): Promise<void> {
  // ── Phase 1: [MIGRATION-UPSTREAM] — all read/write chrome.storage.local.
  // Must all settle before the sweep. Run serially; each is one-shot/idempotent
  // and touches a disjoint key namespace, so order among them is not load-bearing
  // (we keep it deterministic for predictability).
  await migrateV1toV2();
  await migrateInstanceModel();
  await migrateSkillsEnabledAllOn();
  await cleanupLegacySkipPermissions();
  await cleanupThinShellSkills();
  await migrateSkillsToPackages();
  await runSessionMigrations();

  // ── Phase 2: the V2→V3 sweep — chrome.storage.local → IndexedDB, then clear.
  await migrateV2toV3();

  // ── Phase 3: IDB-post migrations — read/write the IDB config-store, so they
  // must run only after the sweep has populated it.
  await migrateLegacyKeyboardFlag();
}

/**
 * Run the full startup-migration pipeline exactly once per context (singleton
 * promise). Safe to call from multiple entry points and to await repeatedly.
 * Individual steps swallow/log their own errors where appropriate; a thrown
 * step rejects the shared promise so callers can decide whether to proceed.
 */
export function runStartupMigrations(): Promise<void> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = runPipeline();
  return pipelinePromise;
}

/** Test-only: drop the cached pipeline promise so a fresh run can be exercised. */
export function _resetStartupMigrationsForTests(): void {
  pipelinePromise = null;
}
