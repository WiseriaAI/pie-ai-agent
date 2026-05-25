export interface FrameVersionEntry {
  version: number;
  observerAlive: boolean;
}

const registry = new Map<number /* tabId */, Map<number /* frameId */, FrameVersionEntry>>();

export function recordFrameVersion(tabId: number, frameId: number, version: number): void {
  let tabMap = registry.get(tabId);
  if (!tabMap) {
    tabMap = new Map();
    registry.set(tabId, tabMap);
  }
  tabMap.set(frameId, { version, observerAlive: true });
}

export function getFrameVersion(tabId: number, frameId: number): FrameVersionEntry | undefined {
  return registry.get(tabId)?.get(frameId);
}

export function markObserverDead(tabId: number, frameId: number): void {
  const entry = registry.get(tabId)?.get(frameId);
  if (entry) entry.observerAlive = false;
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
