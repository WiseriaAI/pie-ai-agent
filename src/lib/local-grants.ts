import type { GrantRecord } from "@/types/local-bridge";

/**
 * skill grants 查询/撤销（#270：控制入口住 SkillsList，Settings 不再消费）。
 * SW 侧消息既有：daemon-off / 旧 daemon / SW 睡死 → 空列表 / false，调用方零分支。
 */
export function queryGrants(): Promise<GrantRecord[]> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "local-grants:list" }, (res) => {
        if (chrome.runtime.lastError) return resolve([]);
        resolve(res && Array.isArray(res.grants) ? (res.grants as GrantRecord[]) : []);
      });
    } catch {
      resolve([]);
    }
  });
}

export function revokeGrant(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "local-grants:revoke", key }, (res) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(res?.ok === true);
      });
    } catch {
      resolve(false);
    }
  });
}
