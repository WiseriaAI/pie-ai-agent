import { ACCOUNT_BASE } from "./managed-config";
import type { Entitlement, ModelInfo } from "./managed-auth";
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

/** annualOffer 存在性=年付可买，独立于 savePercent 保留（区别于 introOffer 的缺值即丢）。 */
function normalizeAnnualOffer(raw: unknown): { savePercent?: number } | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  return typeof o.savePercent === "number" && o.savePercent > 0 ? { savePercent: o.savePercent } : {};
}

/** 容忍后端缺字段/新激活边缘：补齐 v2.1 安全默认，绝不抛。 */
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  const introOffer = normalizeIntroOffer(r.introOffer);
  const annualOffer = normalizeAnnualOffer(r.annualOffer);
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: normalizeSubscription(r.subscription),
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as unknown[]).map(normalizeModel) : [],
    ...(introOffer ? { introOffer } : {}),
    ...(annualOffer !== undefined ? { annualOffer } : {}),
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
