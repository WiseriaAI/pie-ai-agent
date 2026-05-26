import { migrateLegacyKeyboardFlag } from "@/lib/cdp-input-enabled";

/**
 * Run once per SW startup to migrate the legacy keyboard_simulation_enabled
 * flag into the new cdp_input_enabled key. Idempotent.
 */
export async function runCdpInputMigration(): Promise<void> {
  await migrateLegacyKeyboardFlag();
}
