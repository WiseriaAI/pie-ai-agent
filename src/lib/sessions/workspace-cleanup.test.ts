import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE_SESSION_WORKSPACE_MESSAGE, deleteSessionWorkspaceRpc } from "./workspace-cleanup";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deleteSessionWorkspaceRpc", () => {
  it("posts the delete-session-workspace message with the sessionId", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    await deleteSessionWorkspaceRpc(SID);
    expect(sendMessage).toHaveBeenCalledWith({
      type: DELETE_SESSION_WORKSPACE_MESSAGE,
      sessionId: SID,
    });
  });

  it("never rejects when there is no receiver (sendMessage throws)", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    await expect(deleteSessionWorkspaceRpc(SID)).resolves.toBeUndefined();
  });

  it("no-ops (no throw) when chrome.runtime is unavailable", async () => {
    vi.stubGlobal("chrome", undefined);
    await expect(deleteSessionWorkspaceRpc(SID)).resolves.toBeUndefined();
  });
});
