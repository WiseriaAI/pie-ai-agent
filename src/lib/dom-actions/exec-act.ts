import { actByIdxInjected, type ActParams, type ActResult } from "./act-core";

/**
 * Run actByIdxInjected in the target tab/frame. Returns the op-tagged
 * ActResult; maps frame-navigated/removed executeScript failures to a
 * re-snapshot hint. Shared by tools.ts (type/select) and tools/mouse.ts
 * (subframe synthetic click).
 */
export async function execActInTab(
  tabId: number,
  params: ActParams,
  frameId?: number,
): Promise<ActResult> {
  const target: chrome.scripting.InjectionTarget = frameId !== undefined
    ? { tabId, frameIds: [frameId] }
    : { tabId };
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: actByIdxInjected,
      args: [params],
    });
    return (
      (results[0]?.result as ActResult | undefined) ?? {
        ok: false,
        error: "Execution failed",
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (frameId !== undefined && /Frame with ID .* not found|No frame with id/i.test(msg)) {
      return {
        ok: false,
        error: `Frame ${frameId} unreachable or removed. Re-snapshot.`,
      };
    }
    throw err;
  }
}
