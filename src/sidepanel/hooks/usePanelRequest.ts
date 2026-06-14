import { useEffect, useState, useCallback } from "react";

export interface ActivePanelRequest {
  requestId: string;
  kind: string;
  payload: unknown;
}

export type PanelResponseBody = { ok: true; data: unknown } | { ok: false; reason: string };

interface State {
  /** 当前 session 待应答的请求；无则 null。一次至多一个。 */
  active: ActivePanelRequest | null;
  respond: (requestId: string, body: PanelResponseBody) => void;
}

/**
 * Panel 侧 HITL 分发：监听统一 `panel-request`，暴露当前待应答请求；`respond`
 * 回 `panel-response`。超时/带外放行（panel-request-timeout / -resolved）清卡。
 * 取代旧的 useCdpOnboarding / useLocalFileRequest。
 */
export function usePanelRequest(
  port: chrome.runtime.Port | null,
  sessionId: string | null,
): State {
  const [active, setActive] = useState<ActivePanelRequest | null>(null);

  useEffect(() => {
    if (!port || !sessionId) return;
    const listener = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as {
        type?: string;
        sessionId?: string;
        requestId?: string;
        kind?: string;
        payload?: unknown;
      };
      if (m.sessionId !== sessionId) return;
      if (m.type === "panel-request" && m.requestId && m.kind) {
        setActive({ requestId: m.requestId, kind: m.kind, payload: m.payload });
      } else if (
        m.type === "panel-request-timeout" ||
        m.type === "panel-request-resolved"
      ) {
        setActive((cur) => (cur && cur.requestId === m.requestId ? null : cur));
      }
    };
    port.onMessage.addListener(listener);
    return () => port.onMessage.removeListener(listener);
  }, [port, sessionId]);

  // 切 session 时清卡，避免残留。
  useEffect(() => setActive(null), [sessionId]);

  const respond = useCallback(
    (requestId: string, body: PanelResponseBody) => {
      if (!port || !sessionId) return;
      port.postMessage({ type: "panel-response", sessionId, requestId, ...body });
      setActive((cur) => (cur && cur.requestId === requestId ? null : cur));
    },
    [port, sessionId],
  );

  return { active, respond };
}
