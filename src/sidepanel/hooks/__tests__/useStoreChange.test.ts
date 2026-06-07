import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStoreChange } from "../useStoreChange";
import { publishChange } from "@/lib/store-bus";

describe("useStoreChange", () => {
  it("invokes callback when the subscribed store changes", async () => {
    const cb = vi.fn();
    renderHook(() => useStoreChange("sessions", cb));
    act(() => publishChange("sessions", "put", "s1"));
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalled();
  });

  it("does not invoke for a different store", async () => {
    const cb = vi.fn();
    renderHook(() => useStoreChange("sessions", cb));
    act(() => publishChange("config", "put", "x"));
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).not.toHaveBeenCalled();
  });
});
