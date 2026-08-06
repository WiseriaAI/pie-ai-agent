/**
 * Per-instance RPM 滑动窗口限流器。挂在 streamChat（见 index.ts），
 * key = instanceId（RPM 限额绑 API key，instance 即 key 维度）。
 * ponytail: 纯内存窗口，SW 重启计数清零 —— 最坏窗口内多发几条；
 * 若未来要跨重启精确，升级为 IDB 持久化时间戳。
 */
const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

function prune(key: string, now: number): number[] {
  const arr = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  windows.set(key, arr);
  return arr;
}

/** 满窗返回预计恢复时刻（epoch ms），未满返回 null。纯读，不记账。 */
export function peekWait(key: string, limit: number): number | null {
  const arr = prune(key, Date.now());
  return arr.length < limit ? null : arr[0]! + WINDOW_MS;
}

/** 窗口有空位则记账立即返回；满则 sleep 到最早一条过期后重查（while 竞争）。 */
export async function acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const now = Date.now();
    const arr = prune(key, now);
    if (arr.length < limit) {
      arr.push(now);
      return;
    }
    await sleep(arr[0]! + WINDOW_MS - now, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(ms, 0));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function _resetForTests(): void {
  windows.clear();
}
