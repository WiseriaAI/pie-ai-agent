import { useEffect, useRef, useState } from "react";
import type { DisplayMessage } from "@/types";

const CELEBRATE_MS = 2500; // ≈ 2 个 success 循环（pie-hop 1.15s）

/**
 * Pie IP 完成态瞬态信号：streaming 成功收尾后为 true 持续 2.5s。
 * 纯 UI state，不持久化 —— 切会话 / 重开 panel / 恢复历史都不重播。
 *
 * 成功判定：streaming true→false 边沿、无 error、末尾消息是
 * agent-summary(success=true) 或 assistant（chat-done 自然完成）。
 * abort / discard 以 success:false 的 agent-summary 收尾，天然不触发。
 */
export function useCelebrate({
  streaming,
  error,
  messages,
  sessionId,
}: {
  streaming: boolean;
  error: string | null;
  messages: readonly DisplayMessage[];
  sessionId: string | null;
}): boolean {
  const [celebrating, setCelebrating] = useState(false);
  const prevStreamingRef = useRef(streaming);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (streaming) {
      // 新任务开始：取消进行中的庆祝。
      clearTimer();
      setCelebrating(false);
      return;
    }
    if (!was || error) return; // 非 true→false 边沿，或错误收尾
    const last = messages[messages.length - 1];
    const ok =
      (last?.role === "agent-summary" && last.success) ||
      last?.role === "assistant";
    if (!ok) return;
    setCelebrating(true);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCelebrating(false);
    }, CELEBRATE_MS);
    // 注意：不在此 effect 返回 cleanup —— messages 后续变化会重跑 effect，
    // 若返回 cleanup 会把计时器清掉导致 celebrating 永远卡 true。
  }, [streaming, error, messages]);

  // 切会话立即复位；卸载时清计时器。
  useEffect(() => {
    clearTimer();
    setCelebrating(false);
  }, [sessionId]);
  useEffect(() => clearTimer, []);

  return celebrating;
}
