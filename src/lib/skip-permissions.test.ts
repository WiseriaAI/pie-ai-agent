import { describe, it, expect } from "vitest";
import {
  isSkipPermissionsEnabled,
  setSkipPermissionsEnabled,
  SKIP_PERMISSIONS_STORAGE_KEY,
} from "./skip-permissions";

describe("skip-permissions toggle storage", () => {
  it("defaults to false when key absent", async () => {
    expect(await isSkipPermissionsEnabled()).toBe(false);
  });

  it("returns true after set true", async () => {
    await setSkipPermissionsEnabled(true);
    expect(await isSkipPermissionsEnabled()).toBe(true);
  });

  it("coerces non-boolean to boolean", async () => {
    await setSkipPermissionsEnabled("yes" as unknown as boolean);
    expect(await isSkipPermissionsEnabled()).toBe(true);
    await setSkipPermissionsEnabled(0 as unknown as boolean);
    expect(await isSkipPermissionsEnabled()).toBe(false);
  });

  it("exports stable storage key", () => {
    expect(SKIP_PERMISSIONS_STORAGE_KEY).toBe("skip_permissions_enabled");
  });
});
