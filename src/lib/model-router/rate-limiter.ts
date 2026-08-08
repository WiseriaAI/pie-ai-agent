/**
 * Per-instance RPM 滑动窗口限流器。挂在 streamChat（见 index.ts），
 * key = instanceId（RPM 限额绑 API key，instance 即 key 维度）。
 * ponytail: 纯内存窗口，SW 重启计数清零 —— 最坏窗口内多发几条；
 * 若未来要跨重启精确，升级为 IDB 持久化时间戳。
 *
 * 单次尝试 + 由调用方循环，不在这里内含 while：多个 waiter 抢同一个空位时
 * 落败方必须能重新播报新的 resumeAt，否则面板倒计时归零后再无更新。
 */
const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

/** 有空位则记账并返回 null；满窗返回预计恢复时刻（epoch ms），不记账。 */
export function tryAcquire(key: string, limit: number): number | null {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  windows.set(key, arr);
  if (arr.length < limit) {
    arr.push(now);
    return null;
  }
  return arr[0]! + WINDOW_MS;
}

/** sleep 到 `until`（epoch ms）；abort 抛 AbortError。 */
export function waitUntil(until: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(until - Date.now(), 0));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function _resetForTests(): void {
  windows.clear();
}
