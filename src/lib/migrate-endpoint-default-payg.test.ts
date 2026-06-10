import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import { _resetKeyForTests } from "@/lib/crypto";
import { getConfig } from "@/lib/idb/config-store";
import { createInstance, getInstance } from "@/lib/instances";
import {
  migrateEndpointDefaultToPayg,
  ENDPOINT_DEFAULT_FLIP_SENTINEL,
} from "./migrate-endpoint-default-payg";

beforeEach(async () => {
  await _resetForTests();
  _resetKeyForTests();
});

describe("migrateEndpointDefaultToPayg", () => {
  it("pins pre-flip instances of flipped providers to the payg variant", async () => {
    const ids: Record<string, string> = {};
    for (const provider of ["zhipu", "moonshot", "moonshot-cn", "stepfun"] as const) {
      ids[provider] = await createInstance({ provider, nickname: provider, apiKey: "k" });
    }
    await migrateEndpointDefaultToPayg();
    for (const provider of ["zhipu", "moonshot", "moonshot-cn", "stepfun"] as const) {
      expect((await getInstance(ids[provider]!))!.endpointVariant).toBe("payg");
    }
  });

  it("leaves mimo (Plan-default already) untouched", async () => {
    const id = await createInstance({ provider: "mimo", nickname: "M", apiKey: "k" });
    await migrateEndpointDefaultToPayg();
    expect((await getInstance(id))!.endpointVariant).toBeUndefined();
  });

  it("does not overwrite an instance that already has an endpointVariant", async () => {
    // e.g. a beta tester who explicitly picked a (now-dangling) variant
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "kimi-code" });
    await migrateEndpointDefaultToPayg();
    expect((await getInstance(id))!.endpointVariant).toBe("kimi-code");
  });

  it("leaves custom-provider instances untouched", async () => {
    const id = await createInstance({ provider: "custom:abc", nickname: "C", apiKey: "k" });
    await migrateEndpointDefaultToPayg();
    expect((await getInstance(id))!.endpointVariant).toBeUndefined();
  });

  it("sets the sentinel and is idempotent — new Plan-default instances are never stamped", async () => {
    await migrateEndpointDefaultToPayg(); // fresh install: nothing to stamp, sentinel set
    expect(await getConfig<boolean>(ENDPOINT_DEFAULT_FLIP_SENTINEL)).toBe(true);

    // A NEW zhipu instance created after the flip legitimately defaults to Plan.
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k" });
    await migrateEndpointDefaultToPayg(); // second run is a no-op (sentinel present)
    expect((await getInstance(id))!.endpointVariant).toBeUndefined();
  });
});
