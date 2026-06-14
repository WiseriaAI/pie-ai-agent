// Thin adapter contract test: verifies that requestLocalFileFromPanel delegates
// to the panel-request primitive with kind="local-file" and the 120s timeout.
// The old implementation-detail tests (portsBySession / handleLocalFileResponse)
// were deleted because those internals no longer exist after the migration.
import { describe, it, expect, vi } from "vitest";
import { requestLocalFileFromPanel, REQUEST_TIMEOUT_MS } from "./local-file-request";

vi.mock("./panel-request", () => ({
  requestFromPanel: vi.fn().mockResolvedValue({
    name: "test.txt",
    mime: "text/plain",
    text: "hello",
    truncated: false,
  }),
}));

describe("local-file-request thin adapter", () => {
  it("delegates to requestFromPanel with kind='local-file' and 120s timeout", async () => {
    const { requestFromPanel } = await import("./panel-request");
    const result = await requestLocalFileFromPanel("S1");
    expect(requestFromPanel).toHaveBeenCalledWith("S1", "local-file", {}, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result).toMatchObject({ name: "test.txt" });
  });

  it("REQUEST_TIMEOUT_MS is 120 000 ms", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(120_000);
  });
});
