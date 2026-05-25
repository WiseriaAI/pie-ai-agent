export interface FrameVersionEntry {
  version: number;
}

const registry = new Map<number /* tabId */, Map<number /* frameId */, FrameVersionEntry>>();

export function recordFrameVersion(tabId: number, frameId: number, version: number): void {
  let tabMap = registry.get(tabId);
  if (!tabMap) {
    tabMap = new Map();
    registry.set(tabId, tabMap);
  }
  tabMap.set(frameId, { version });
}

export function getFrameVersion(tabId: number, frameId: number): FrameVersionEntry | undefined {
  return registry.get(tabId)?.get(frameId);
}

export function clearFrame(tabId: number, frameId: number): void {
  registry.get(tabId)?.delete(frameId);
}

export function clearTab(tabId: number): void {
  registry.delete(tabId);
}

// Test-only helper. Production code should not call this.
export function resetRegistry(): void {
  registry.clear();
}

/**
 * Apply a version value received from a content-script bump message.
 * If frame not yet registered, creates entry.
 */
export function setVersionFromBump(tabId: number, frameId: number, version: number): void {
  let tabMap = registry.get(tabId);
  if (!tabMap) { tabMap = new Map(); registry.set(tabId, tabMap); }
  const cur = tabMap.get(frameId);
  if (cur) { cur.version = version; }
  else { tabMap.set(frameId, { version }); }
}
