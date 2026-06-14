import { ACCOUNT_BASE } from "./managed-config";
import type { Entitlement } from "./managed-auth";

export interface ManagedAccountDeps {
  fetchFn?: typeof fetch;
  /** 缺省走 chrome.tabs.create。 */
  openTab?: (url: string) => void;
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
  const resp = await fetchFn(`${ACCOUNT_BASE}/me/entitlement`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Failed to load entitlement (${resp.status})`);
  const ent = normalizeEntitlement(await resp.json());
  entitlementCache.set(apiKey, ent);
  return ent;
}

/** 容忍后端缺字段/新激活边缘：补齐 v2 安全默认，绝不抛。 */
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: (r.subscription as Entitlement["subscription"]) ?? null,
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as Entitlement["models"]) : [],
  };
}

async function openBilling(path: "/billing/checkout" | "/billing/portal", apiKey: string, deps: ManagedAccountDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const openTab = deps.openTab ?? ((url: string) => { chrome.tabs.create({ url }); });
  const resp = await fetchFn(`${ACCOUNT_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`${path} failed (${resp.status})`);
  const { url } = (await resp.json()) as { url: string };
  openTab(url);
}

export const openCheckout = (apiKey: string, deps: ManagedAccountDeps = {}) => openBilling("/billing/checkout", apiKey, deps);
export const openPortal = (apiKey: string, deps: ManagedAccountDeps = {}) => openBilling("/billing/portal", apiKey, deps);
