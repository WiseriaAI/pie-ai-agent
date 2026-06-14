// HITL（human-in-the-loop）请求原语。
//
// 取代两份手搓实现（cdp-input-onboarding.ts / local-file-request.ts）：SW 挂起
// 一个 turn → 往 panel 发请求 → 等用户卡片裁决 → resolve/reject 一个 promise。
// 一个 session 一个 port，承载整条通道；pending 按 requestId 隔离，并发不串台。
//
// 注意：本原语**不是**风险拦截 confirm 层（那套已删，有 no-confirm-* 跨层测试守着）。
// 它只服务"工具语义即问人"（授权 / 选文件 / 选模型）的场景。

import type { LocalFileResult } from "./local-file-request";
import type { ScheduleDraftPayload, ScheduleModelSelection } from "./agent/tools/schedule-meta";

/** kind 注册表：加一种人机交互 = 加一行，编译期校验 payload/返回。 */
export interface PanelRequestMap {
  "cdp-consent": { req: Record<string, never>; res: boolean };
  "local-file": { req: Record<string, never>; res: LocalFileResult };
  "schedule-model": { req: ScheduleDraftPayload; res: ScheduleModelSelection };
}
export type PanelRequestKind = keyof PanelRequestMap;

interface PendingRequest {
  sessionId: string;
  kind: PanelRequestKind;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const portsBySession = new Map<string, chrome.runtime.Port>();
const pendingByRequestId = new Map<string, PendingRequest>();

/** Test-only：清空模块状态。 */
export function __resetPanelRequestState(): void {
  portsBySession.clear();
  for (const p of pendingByRequestId.values()) if (p.timer) clearTimeout(p.timer);
  pendingByRequestId.clear();
}

export function registerPanelPort(sessionId: string, port: chrome.runtime.Port): void {
  portsBySession.set(sessionId, port);
}

/** Panel 关闭：reject 该 session 全部 pending，避免悬挂。 */
export function unregisterPanelPort(sessionId: string): void {
  portsBySession.delete(sessionId);
  for (const [reqId, p] of pendingByRequestId.entries()) {
    if (p.sessionId !== sessionId) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingByRequestId.delete(reqId);
    p.reject(new Error(`panel-request cancelled (panel closed) for session ${sessionId}`));
  }
}

export async function requestFromPanel<K extends PanelRequestKind>(
  sessionId: string,
  kind: K,
  payload: PanelRequestMap[K]["req"],
  opts?: { timeoutMs?: number },
): Promise<PanelRequestMap[K]["res"]> {
  const port = portsBySession.get(sessionId);
  if (!port) {
    throw new Error(`Cannot send panel-request "${kind}": no sidepanel port for session ${sessionId}`);
  }
  const requestId = crypto.randomUUID();
  return new Promise<PanelRequestMap[K]["res"]>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs != null) {
      timer = setTimeout(() => {
        pendingByRequestId.delete(requestId);
        const p = portsBySession.get(sessionId);
        if (p) p.postMessage({ type: "panel-request-timeout", sessionId, requestId });
        reject(new Error(`panel-request "${kind}" timed out`));
      }, opts.timeoutMs);
    }
    pendingByRequestId.set(requestId, {
      sessionId,
      kind,
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
    });
    port.postMessage({ type: "panel-request", sessionId, requestId, kind, payload });
  });
}

/** Panel 回话：按 requestId 定位并 resolve/reject。未知 id 静默忽略。 */
export function handlePanelResponse(
  requestId: string,
  response: { ok: true; data: unknown } | { ok: false; reason: string },
): void {
  const pending = pendingByRequestId.get(requestId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingByRequestId.delete(requestId);
  if (response.ok) pending.resolve(response.data);
  else pending.reject(new Error(response.reason));
}

/**
 * 带外 resolve：不经 panel 回话，直接 resolve 某 kind 的全部 pending（跨 session）。
 * 用于 CDP 特例——另一个 session 把 cdp-input 开关翻 true 时自动放行所有等待中的
 * consent。同时给对应 panel 发 panel-request-resolved，让卡片消失。
 */
export function resolvePendingByKind<K extends PanelRequestKind>(
  kind: K,
  data: PanelRequestMap[K]["res"],
): void {
  for (const [reqId, p] of pendingByRequestId.entries()) {
    if (p.kind !== kind) continue;
    if (p.timer) clearTimeout(p.timer);
    pendingByRequestId.delete(reqId);
    const port = portsBySession.get(p.sessionId);
    if (port) port.postMessage({ type: "panel-request-resolved", sessionId: p.sessionId, requestId: reqId });
    p.resolve(data);
  }
}
