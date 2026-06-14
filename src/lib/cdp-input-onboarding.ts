import {
  setCdpInputEnabled,
  type CdpInputState,
} from "./cdp-input-enabled";
import { requestFromPanel, resolvePendingByKind } from "./panel-request";

/**
 * 请求 CDP 输入授权。挂起当前 turn 直至用户在卡片应答（true/false），或另一个
 * session 翻开关触发带外放行（见 onCdpInputEnabledChanged）。resolve 后持久化
 * 授权 flag（幂等；放行路径下 flag 已为 true，重设无副作用）。
 */
export async function requestCdpInputConsent(sessionId: string): Promise<boolean> {
  const granted = await requestFromPanel(sessionId, "cdp-consent", {});
  await setCdpInputEnabled(granted);
  return granted;
}

/**
 * background/index.ts 在 cdp-input-enabled flag 经 store-bus 变化时调用。flag 现在
 * 为 true 时，自动放行所有等待中的 consent（带外 resolve，卡片随之消失）。
 */
export function onCdpInputEnabledChanged(enabled: CdpInputState): void {
  if (enabled !== true) return;
  resolvePendingByKind("cdp-consent", true);
}
