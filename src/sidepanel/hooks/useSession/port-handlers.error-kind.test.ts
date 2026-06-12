import { describe, expect, it } from "vitest";
import { createPortHandlers } from "./port-handlers";
import type { SessionRuntimeSlot } from "./runtime-map";

describe("chat-error carries kind into slot", () => {
  it("sets slot.errorKind from the wire message", () => {
    const slots = new Map<string, SessionRuntimeSlot>();
    const slotsRef = { current: slots };
    const { handleMessage } = createPortHandlers({
      slotsRef: slotsRef as never,
      setSlots: () => {},
      persistMessages: async () => {},
    });
    handleMessage({ type: "chat-error", error: "quota exhausted", kind: "budget", sessionId: "s1" } as never);
    expect(slotsRef.current.get("s1")).toMatchObject({ error: "quota exhausted", errorKind: "budget" });
  });
});
