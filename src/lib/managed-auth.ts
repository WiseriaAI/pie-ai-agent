import { getProviderMeta } from "@/lib/model-router/providers/registry";

const AUTH_KEY = "managed_auth";
const ENT_KEY = "managed_entitlement";
const REFRESH_SKEW_MS = 5 * 60_000; // 提前 5 分钟刷新

export interface StoredAuth { jwt: string; refreshToken: string; expiresAt: number; }
export interface Entitlement { plan: "free" | "paid"; tiers: { tierId: string; displayName: string }[]; }

function base(): string {
  return getProviderMeta("managed")!.defaultBaseUrl;
}

export async function saveAuth(a: StoredAuth): Promise<void> {
  await chrome.storage.local.set({ [AUTH_KEY]: a });
}
export async function getStoredAuth(): Promise<StoredAuth | null> {
  const r = await chrome.storage.local.get(AUTH_KEY);
  return (r[AUTH_KEY] as StoredAuth) ?? null;
}
export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove([AUTH_KEY, ENT_KEY]);
}

export function isExpiringSoon(expiresAt: number): boolean {
  return expiresAt - Date.now() <= REFRESH_SKEW_MS;
}

let refreshInFlight: Promise<string> | null = null;

/** 用 refresh token 换新 JWT，落盘并返回新 JWT。并发调用共享同一个飞行中的请求。 */
export async function refreshJwt(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = _doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function _doRefresh(): Promise<string> {
  const cur = await getStoredAuth();
  if (!cur) throw new Error("managed: not logged in");
  const res = await fetch(`${base()}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: cur.refreshToken }),
  });
  if (!res.ok) throw new Error(`managed refresh failed: ${res.status}`);
  const data = await res.json() as StoredAuth;
  const next: StoredAuth = { jwt: data.jwt, refreshToken: data.refreshToken, expiresAt: data.expiresAt };
  await saveAuth(next);
  return next.jwt;
}

/** 返回一个有效 JWT：临近过期则先刷新。 */
export async function getValidJwt(): Promise<string> {
  const cur = await getStoredAuth();
  if (!cur) throw new Error("managed: not logged in");
  if (isExpiringSoon(cur.expiresAt)) return refreshJwt();
  return cur.jwt;
}

export async function fetchEntitlement(): Promise<Entitlement> {
  const jwt = await getValidJwt();
  const res = await fetch(`${base()}/me/entitlement`, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new Error(`managed entitlement failed: ${res.status}`);
  const ent = await res.json() as Entitlement;
  await chrome.storage.local.set({ [ENT_KEY]: ent });
  return ent;
}
export async function getCachedEntitlement(): Promise<Entitlement | null> {
  const r = await chrome.storage.local.get(ENT_KEY);
  return (r[ENT_KEY] as Entitlement) ?? null;
}

/** 拉起 OAuth，换取 JWT，落盘 auth + entitlement，返回 entitlement。 */
export async function loginWithOAuth(): Promise<Entitlement> {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = `${base()}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
  const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!redirected) throw new Error("managed login: no redirect URL returned");
  // Supabase 隐式流把 session 放在 URL fragment（#access_token=...）；PKCE 才用 ?code=。
  // 兼容两者：优先取 fragment 的 access_token，回退到 query 的 code。后端 /auth/exchange 用它做 getUser()。
  const u = new URL(redirected);
  const frag = new URLSearchParams(u.hash.replace(/^#/, ""));
  const oauthError = frag.get("error_description") ?? frag.get("error") ?? u.searchParams.get("error");
  if (oauthError) throw new Error(`managed login: ${oauthError}`);
  const code = frag.get("access_token") ?? u.searchParams.get("code");
  if (!code) throw new Error("managed login: no token in redirect");

  const res = await fetch(`${base()}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!res.ok) throw new Error(`managed exchange failed: ${res.status}`);
  const data = await res.json() as StoredAuth & { entitlement: Entitlement };
  await saveAuth({ jwt: data.jwt, refreshToken: data.refreshToken, expiresAt: data.expiresAt });
  await chrome.storage.local.set({ [ENT_KEY]: data.entitlement });
  return data.entitlement;
}

export async function logout(): Promise<void> {
  await clearAuth();
}
