import { listInstances, updateInstance } from "@/lib/instances";
import { getConfig, setConfig } from "@/lib/idb/config-store";

/** Sentinel: this migration runs exactly once. Instances created AFTER the flip
 *  legitimately default to the Plan endpoint (no endpointVariant), so the
 *  sentinel prevents a later run from wrongly stamping them as "payg". */
export const ENDPOINT_DEFAULT_FLIP_SENTINEL = "endpoint_default_flip_payg_migrated";

/** Providers whose default endpoint flipped pay-as-you-go → Plan (PR #166).
 *  Before the flip these shipped (v0.19.5) WITHOUT any variant concept, so every
 *  existing instance is a pay-as-you-go user with no endpointVariant. Pin them to
 *  the "payg" variant so they keep hitting the same endpoint and their key stays
 *  valid after the update. (mimo is absent: its default was always the Plan
 *  endpoint, so its existing instances are correctly Plan-default already.) */
const FLIPPED_PROVIDERS = new Set(["zhipu", "moonshot", "moonshot-cn", "stepfun"]);

/**
 * One-shot (IDB-post, Phase 3): pin pre-flip instances of the flipped providers
 * to the "payg" endpoint variant. Idempotent via a config-store sentinel — a
 * fresh install stamps nothing and still sets the sentinel, so the migration
 * never touches instances created under the new (Plan-default) registry.
 */
export async function migrateEndpointDefaultToPayg(): Promise<void> {
  if (await getConfig<boolean>(ENDPOINT_DEFAULT_FLIP_SENTINEL)) return;

  const instances = await listInstances();
  for (const inst of instances) {
    if (FLIPPED_PROVIDERS.has(inst.provider) && !inst.endpointVariant) {
      await updateInstance(inst.id, { endpointVariant: "payg" });
    }
  }

  await setConfig(ENDPOINT_DEFAULT_FLIP_SENTINEL, true);
}
