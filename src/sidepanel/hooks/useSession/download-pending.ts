// Pending output_file download requests, keyed by artifactId. The panel
// registers a resolver when it sends download-output to the SW; the
// file-output-result port message resolves it.
export interface DownloadResult { status: "ok" | "expired" | "error"; }

const pending = new Map<string, (r: DownloadResult) => void>();

export function registerDownload(artifactId: string, resolve: (r: DownloadResult) => void): void {
  // If a prior request for the same artifact is still pending, resolve it as
  // error so its promise doesn't leak, then replace.
  const existing = pending.get(artifactId);
  if (existing) existing({ status: "error" });
  pending.set(artifactId, resolve);
}

export function resolveDownload(artifactId: string, r: DownloadResult): void {
  const fn = pending.get(artifactId);
  if (fn) { pending.delete(artifactId); fn(r); }
}

export function _clearPendingForTests(): void { pending.clear(); }
