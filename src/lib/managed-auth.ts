import { ACCOUNT_BASE } from "./managed-config";

export interface QuotaWindow {
  usedFraction: number;
  resetAt: number;
}
export interface SubscriptionInfo {
  planName: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}
export interface ModelInfo {
  id: string;
  name: string;
  /** 一行能力描述（已按 locale 由后端解析）。 */
  description?: string;
  /** 是否支持图片输入。tools 对 managed 一律视 true。 */
  vision: boolean;
  maxContextTokens: number;
  /** 相对周额度消耗档（1=最省），渲染为 N/3 实心点。 */
  costLevel: 1 | 2 | 3;
}
export interface Entitlement {
  plan: "none" | "active" | "blocked";
  email: string;
  /** plan==none 时为 null；blocked 时非 null（供更新支付）。 */
  subscription: SubscriptionInfo | null;
  /** plan!=active 时为 null；具名窗口 map（P3 可加 fiveHour）。 */
  quota: { weekly?: QuotaWindow } | null;
  /** 仅 plan==active 非空。 */
  models: ModelInfo[];
}
export interface LoginResult {
  apiKey: string;
  entitlement: Entitlement;
}

export interface ManagedAuthDeps {
  /** 缺省走 chrome.identity.launchWebAuthFlow（MV3 返回 Promise<string> redirectURL）。 */
  launchWebAuthFlow?: (opts: { url: string; interactive: boolean }) => Promise<string>;
  /** 缺省走 chrome.identity.getRedirectURL()（https://<EXTENSION_ID>.chromiumapp.org/）。 */
  getRedirectURL?: () => string;
  fetchFn?: typeof fetch;
}

/**
 * Google 一键登录 → 兑换长效 virtual key。
 * redirect_uri 在 start 与 exchange 两处必须完全一致（含尾斜杠）。
 * 幂等：同一 Google 账号重复登录返回同一把 key（后端保证），中途放弃可安全重登。
 */
export async function startManagedLogin(deps: ManagedAuthDeps = {}): Promise<LoginResult> {
  const launch =
    deps.launchWebAuthFlow ??
    ((opts) => chrome.identity.launchWebAuthFlow(opts) as unknown as Promise<string>);
  const getRedirectURL = deps.getRedirectURL ?? (() => chrome.identity.getRedirectURL());
  const fetchFn = deps.fetchFn ?? fetch;

  const redirectUri = getRedirectURL();
  const authUrl = `${ACCOUNT_BASE}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const resultUrl = await launch({ url: authUrl, interactive: true });
  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) throw new Error("Login cancelled or not authorized");

  const resp = await fetchFn(`${ACCOUNT_BASE}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!resp.ok) throw new Error(`Login exchange failed (${resp.status})`);
  return (await resp.json()) as LoginResult;
}
