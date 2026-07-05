import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  BRIDGE_CAPABILITIES,
  type BridgeRequest,
  type BridgeResponse,
} from "./local-bridge";

describe("local-bridge protocol", () => {
  it("PROTOCOL_VERSION is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("advertises run_local_agent capability", () => {
    expect(BRIDGE_CAPABILITIES).toContain("run_local_agent");
  });

  it("request/response carry a correlation id", () => {
    const req: BridgeRequest = {
      id: "abc",
      method: "run_local_agent",
      params: { target: "claude", prompt: "hi" },
    };
    const res: BridgeResponse = { id: "abc", ok: true, result: { output: "hi" } };
    expect(req.id).toBe(res.id);
  });
});
