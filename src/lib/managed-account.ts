import { ACCOUNT_BASE } from "./managed-config";
import type { Entitlement } from "./managed-auth";

export interface ManagedAccountDeps {
  fetchFn?: typeof fetch;
  /** 缺省走 chrome.tabs.create。 */
  openTab?: (url: string) => void;
}

export async function getEntitlement(apiKey: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resp = await fetchFn(`${ACCOUNT_BASE}/me/entitlement`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Failed to load entitlement (${resp.status})`);
  return (await resp.json()) as Entitlement;
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
