import { ACCOUNT_BASE } from "./managed-config";
import { normalizeEntitlement, cacheEntitlement } from "./managed-account";
import { getLocale } from "./i18n";

export interface QuotaWindow {
  usedFraction: number;
  resetAt: number;
}
export interface SubscriptionInfo {
  planName: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** 当前驱动 active 的来源：stripe（付费订阅，可开 portal）/ redemption（兑换码，无账单可管）。 */
  source: "stripe" | "redemption";
  /** 计费周期；仅 stripe source 有，redemption 省略。缺省按月付兜底显示。 */
  interval?: "month" | "year";
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
export interface PricingInfo {
  /** ISO 货币码小写（Stripe 约定），交给 Intl 格式化。 */
  currency: string;
  monthly: { amount: number; introAmount?: number; introPercentOff?: number };
  annual: { amount: number; perMonthAmount: number; savePercent: number };
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
  /** 仅"从未订过"且后端 feature 开时下发；客户端据此打"首月半价"徽标。缺省=无促销。 */
  introOffer?: { percentOff: number };
  /** 仅 plan:none、后端年付开+价格拉取成功时下发；存在=渲染价格卡，缺=回退单订阅按钮。仅展示价、客户端不计算。 */
  pricing?: PricingInfo;
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
  /** exchange 的本地化语言，缺省取当前 UI locale（getLocale()）。 */
  locale?: string;
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
  const locale = deps.locale ?? getLocale();

  const redirectUri = getRedirectURL();
  const authUrl = `${ACCOUNT_BASE}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const resultUrl = await launch({ url: authUrl, interactive: true });
  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) throw new Error("Login cancelled or not authorized");

  const resp = await fetchFn(`${ACCOUNT_BASE}/auth/exchange?locale=${encodeURIComponent(locale)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!resp.ok) throw new Error(`Login exchange failed (${resp.status})`);
  // 归一化 entitlement：与 getEntitlement 同一道防线，护住喂 UI（含首月半价徽标）的主路径，
  // 不让 /auth/exchange 的畸形字段（如 introOffer.percentOff）裸穿到渲染层。
  const json = (await resp.json()) as { apiKey?: unknown; entitlement?: unknown };
  const result = { apiKey: String(json.apiKey ?? ""), entitlement: normalizeEntitlement(json.entitlement) };
  if (result.apiKey) await cacheEntitlement(result.apiKey, result.entitlement);
  return result;
}
