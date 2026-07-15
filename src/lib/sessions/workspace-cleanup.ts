// #296 — session workspace 清理的 panel→SW 路由。
//
// 脚本产物住在 daemon 侧 ~/.pie/sessions/<sid>/workspace/。清理它要发 daemon RPC
// (delete_session_workspace)，但 daemon 端口是 SW 独占（panel 不能 connectNative）。
// 而 session 生命周期（archive / hardDelete / expiry sweep）跑在 panel。故 panel 经
// runtime message 把清理请求路由到 SW，SW 调 requestDeleteSessionWorkspace。
//
// best-effort（spec D8）：桥没连 / SW 不在 / 无接收方 → 静默失败，daemon 启动 GC
// （超 30 天孤儿目录）兜底。绝不因清理失败阻断 session 删除本身。

export const DELETE_SESSION_WORKSPACE_MESSAGE = "delete-session-workspace" as const;

export interface DeleteSessionWorkspaceMessage {
  type: typeof DELETE_SESSION_WORKSPACE_MESSAGE;
  sessionId: string;
}

/** 请求 daemon 删掉某 session 的 workspace 产物目录（fire-and-forget，永不 reject）。 */
export async function deleteSessionWorkspaceRpc(sessionId: string): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    await chrome.runtime.sendMessage({
      type: DELETE_SESSION_WORKSPACE_MESSAGE,
      sessionId,
    } satisfies DeleteSessionWorkspaceMessage);
  } catch {
    // 无接收方 / SW 不在 / 桥断 → 忽略；GC 兜底。
  }
}
