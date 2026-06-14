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

/** 容忍后端缺字段/新激活边缘：补齐 v2.1 安全默认，绝不抛。 */
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: (r.subscription as Entitlement["subscription"]) ?? null,
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as unknown[]).map(normalizeModel) : [],
  };
}

/** managed 选中模型的元数据（从进程内缓存按 id 查），供 vision/上下文解析复用。无缓存/未命中 → undefined。 */
export function cachedManagedModel(apiKey: string, modelId: string): ModelInfo | undefined {
  return getCachedEntitlement(apiKey)?.models.find((m) => m.id === modelId);
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
