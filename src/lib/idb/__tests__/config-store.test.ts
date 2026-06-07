import { describe, it, expect, beforeEach, vi } from "vitest";
import { getConfig, setConfig, removeConfig, getAllConfig } from "../config-store";
import { _resetForTests } from "../db";

beforeEach(async () => { await _resetForTests(); });

describe("config-store", () => {
  it("set then get round-trips", async () => {
    await setConfig("theme-mode", "dark");
    expect(await getConfig<string>("theme-mode")).toBe("dark");
  });

  it("get returns undefined for missing key", async () => {
    expect(await getConfig("nope")).toBeUndefined();
  });

  it("remove deletes the key", async () => {
    await setConfig("x", 1);
    await removeConfig("x");
    expect(await getConfig("x")).toBeUndefined();
  });

  it("getAllConfig returns a key→value map", async () => {
    await setConfig("a", 1);
    await setConfig("b", 2);
    expect(await getAllConfig()).toEqual({ a: 1, b: 2 });
  });

  it("setConfig publishes a config change", async () => {
    const { onStoreChange } = await import("../../store-bus");
    const cb = vi.fn();
    const off = onStoreChange("config", cb);
    await setConfig("k", 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ store: "config", op: "put", id: "k" }));
    off();
  });
});
