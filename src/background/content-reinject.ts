// Re-inject manifest content scripts into all already-open tabs.
// Used after extension update/reload so previously-opened tabs whose
// content script became "orphaned" (Extension context invalidated)
// get a live instance again — without the user having to refresh.

import { isWebStoreUrl } from "@/lib/web-store-urls";

const SKIP_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "brave://",
  "about:",
  "view-source:",
  "file://",
];

export function shouldSkipUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (SKIP_URL_PREFIXES.some((p) => url.startsWith(p))) return true;
  // Web Store host check sourced from the shared blocklist (single source of
  // truth — also used by src/lib/schedules/url-guard.ts).
  if (isWebStoreUrl(url)) return true;
  return false;
}

export interface ReinjectDeps {
  tabs?: Pick<typeof chrome.tabs, "query">;
  scripting?: Pick<typeof chrome.scripting, "executeScript">;
  getManifest?: () => chrome.runtime.Manifest;
}

export interface ReinjectResult {
  injected: number;
  skipped: number;
  failed: number;
}

export async function reinjectAllTabs(deps?: ReinjectDeps): Promise<ReinjectResult> {
  const tabs = deps?.tabs ?? chrome.tabs;
  const scripting = deps?.scripting ?? chrome.scripting;
  const getManifest = deps?.getManifest ?? (() => chrome.runtime.getManifest());

  const manifest = getManifest();
  const files = manifest.content_scripts?.[0]?.js ?? [];
  if (files.length === 0) return { injected: 0, skipped: 0, failed: 0 };

  let injected = 0;
  let skipped = 0;
  let failed = 0;

  const allTabs = await tabs.query({});
  for (const tab of allTabs) {
    if (typeof tab.id !== "number" || shouldSkipUrl(tab.url)) {
      skipped++;
      continue;
    }
    try {
      await scripting.executeScript({
        target: { tabId: tab.id },
        files,
      });
      injected++;
    } catch {
      failed++;
    }
  }

  return { injected, skipped, failed };
}
