import { ACCOUNT_BASE } from "./managed-config";
import type { Entitlement, ModelInfo, PricingInfo } from "./managed-auth";
import { getLocale } from "./i18n";

export interface ManagedAccountDeps {
  fetchFn?: typeof fetch;
  /** 缺省走 chrome.tabs.create。 */
  openTab?: (url: string) => void;
  /** 缺省取当前 UI locale（getLocale()）。 */
  locale?: string;
}

/** 进程内 entitlement 缓存（按 apiKey）。供面板展开时立即回显上次状态、避免每次
 *  闪一个空 loading；用量等数值由后台刷新后更新上去。仅当前会话有效（扩展重载即清）。 */
const entitlementCache = new Map<string, Entitlement>();

/** 读上次成功拉取的 entitlement（无则 null）。 */
export function getCachedEntitlement(apiKey: string): Entitlement | null {
  return entitlementCache.get(apiKey) ?? null;
}

export async function getEntitlement(apiKey: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(`${ACCOUNT_BASE}/me/entitlement?locale=${encodeURIComponent(locale)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Failed to load entitlement (${resp.status})`);
  const ent = normalizeEntitlement(await resp.json());
  entitlementCache.set(apiKey, ent);
  return ent;
}

function normalizeModel(raw: unknown): ModelInfo {
  const m = (raw ?? {}) as Record<string, unknown>;
  const costLevel = m.costLevel === 2 || m.costLevel === 3 ? m.costLevel : 1;
  return {
    id: String(m.id ?? ""),
    name: typeof m.name === "string" && m.name ? m.name : String(m.id ?? ""),
    ...(typeof m.description === "string" ? { description: m.description } : {}),
    vision: m.vision === true,
    maxContextTokens: typeof m.maxContextTokens === "number" && m.maxContextTokens > 0 ? m.maxContextTokens : 128000,
    costLevel,
  };
}

function normalizeSubscription(raw: unknown): Entitlement["subscription"] {
  if (raw == null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    planName: typeof s.planName === "string" && s.planName ? s.planName : "Pie",
    currentPeriodEnd: typeof s.currentPeriodEnd === "number" ? s.currentPeriodEnd : null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd === true,
    source: s.source === "redemption" ? "redemption" : "stripe",
    ...(s.interval === "month" || s.interval === "year" ? { interval: s.interval } : {}),
  };
}

function normalizeIntroOffer(raw: unknown): { percentOff: number } | undefined {
  const o = (raw ?? undefined) as Record<string, unknown> | undefined;
  if (o && typeof o.percentOff === "number" && o.percentOff > 0) return { percentOff: o.percentOff };
  return undefined;
}

/** v2.5 订阅价格归一化。严格门禁：核心字段缺任一 → undefined（回退单按钮，绝不半截卡）。
 *  intro 两子字段同有同无（一个缺→都丢）。
 *  价格字段（amount/perMonthAmount/introPercentOff）须为正数；
 *  savePercent/introAmount 可为 0（年付=月×12 无折扣时 savePercent=0；极端折扣下 introAmount 可为 0）。 */
function normalizePricing(raw: unknown): PricingInfo | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  const pos = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const nonneg = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const m = (p.monthly ?? {}) as Record<string, unknown>;
  const a = (p.annual ?? {}) as Record<string, unknown>;
  // currency 须是合法 3 字母 ISO 码——否则 formatMoney 的 Intl.NumberFormat 会抛 RangeError，
  // 整块丢弃改走单按钮回退，守「绝不渲染半截卡」不变量。
  const currency = typeof p.currency === "string" && /^[a-z]{3}$/i.test(p.currency) ? p.currency : undefined;
  const monthlyAmount = pos(m.amount);
  const annualAmount = pos(a.amount);
  const perMonthAmount = pos(a.perMonthAmount);
  const savePercent = nonneg(a.savePercent); // 可为 0（年付无折扣）
  if (currency == null || monthlyAmount == null || annualAmount == null || perMonthAmount == null || savePercent == null) {
    return undefined;
  }
  const monthly: PricingInfo["monthly"] = { amount: monthlyAmount };
  const introAmount = nonneg(m.introAmount); // 极端折扣下可为 0
  const introPercentOff = pos(m.introPercentOff);
  if (introAmount != null && introPercentOff != null) {
    monthly.introAmount = introAmount;
    monthly.introPercentOff = introPercentOff;
  }
  return { currency, monthly, annual: { amount: annualAmount, perMonthAmount, savePercent } };
}

/** 容忍后端缺字段/新激活边缘：补齐 v2.1 安全默认，绝不抛。 */
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  const introOffer = normalizeIntroOffer(r.introOffer);
  const pricing = normalizePricing(r.pricing);
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: normalizeSubscription(r.subscription),
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as unknown[]).map(normalizeModel) : [],
    ...(introOffer ? { introOffer } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

/** managed 选中模型的元数据（从进程内缓存按 id 查），供 vision/上下文解析复用。无缓存/未命中 → undefined。 */
export function cachedManagedModel(apiKey: string, modelId: string): ModelInfo | undefined {
  return getCachedEntitlement(apiKey)?.models.find((m) => m.id === modelId);
}

async function openBilling(path: "/billing/checkout" | "/billing/portal", apiKey: string, deps: ManagedAccountDeps, body?: Record<string, unknown>): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const openTab = deps.openTab ?? ((url: string) => { chrome.tabs.create({ url }); });
  const init: RequestInit = body
    ? { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) }
    : { method: "POST", headers: { authorization: `Bearer ${apiKey}` } };
  const resp = await fetchFn(`${ACCOUNT_BASE}${path}`, init);
  if (!resp.ok) throw new Error(`${path} failed (${resp.status})`);
  const { url } = (await resp.json()) as { url: string };
  openTab(url);
}

export const openCheckout = (apiKey: string, deps: ManagedAccountDeps = {}, interval?: "month" | "year") =>
  openBilling("/billing/checkout", apiKey, deps, interval ? { interval } : undefined);
export const openPortal = (apiKey: string, deps: ManagedAccountDeps = {}) => openBilling("/billing/portal", apiKey, deps);

/** /redeem 失败：携带后端 error code（code_not_found / code_already_redeemed / code_expired / too_many_attempts / …）。 */
export class RedeemError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "RedeemError";
  }
}

/** 兑换码兑换订阅。成功回新鲜 entitlement（已归一化并写入缓存）；失败抛 RedeemError。 */
export async function redeem(apiKey: string, code: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(`${ACCOUNT_BASE}/redeem?locale=${encodeURIComponent(locale)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    let errCode = "redeem_failed";
    try {
      const b = (await resp.json()) as { error?: string };
      if (b && typeof b.error === "string") errCode = b.error;
    } catch {
      /* 非 JSON 错误体：保留 redeem_failed */
    }
    throw new RedeemError(errCode, resp.status);
  }
  const ent = normalizeEntitlement(await resp.json());
  entitlementCache.set(apiKey, ent);
  return ent;
}
