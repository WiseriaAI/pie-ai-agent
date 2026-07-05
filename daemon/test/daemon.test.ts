import { test, expect } from "bun:test";
import { handleMessage } from "../src/daemon";
import { PROTOCOL_VERSION } from "../../src/types/local-bridge";

test("hello returns protocolVersion + capabilities", async () => {
  const out = await handleMessage(
    JSON.stringify({ id: "1", method: "hello", params: { protocolVersion: PROTOCOL_VERSION } }),
  );
  const res = JSON.parse(out);
  expect(res.id).toBe("1");
  expect(res.ok).toBe(true);
  expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(res.result.capabilities).toContain("run_local_agent");
});

test("unknown method returns structured error", async () => {
  const out = await handleMessage(JSON.stringify({ id: "2", method: "nope", params: {} }));
  const res = JSON.parse(out);
  expect(res.ok).toBe(false);
  expect(res.error.code).toBe("unknown_method");
});
