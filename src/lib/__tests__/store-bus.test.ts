import { describe, it, expect, vi } from "vitest";
import { publishChange, onStoreChange } from "../store-bus";

describe("store-bus", () => {
  it("delivers changes for the subscribed store and filters others", async () => {
    const cb = vi.fn();
    const off = onStoreChange("sessions", cb);
    publishChange("sessions", "put", "s1");
    publishChange("config", "put", "theme-mode");
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ store: "sessions", op: "put", id: "s1" });
    off();
  });

  it("stops delivering after unsubscribe", async () => {
    const cb = vi.fn();
    const off = onStoreChange("config", cb);
    off();
    publishChange("config", "remove", "x");
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).not.toHaveBeenCalled();
  });
});
