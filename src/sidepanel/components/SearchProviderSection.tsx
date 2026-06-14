import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVE_SEARCH_PROVIDER,
  clearSearchProviderKey,
  getSearchProvider,
  getSearchProviderKey,
  getSearchProviderStatus,
  markVerified,
  setSearchProviderKey,
} from "@/lib/search-provider";
import { useT } from "@/lib/i18n";
import { Button } from "./ui/Button";

type Mode = "empty" | "configured" | "editing";

interface Status {
  configured: boolean;
  lastVerifiedAt?: number;
  maskedKey?: string;
}

export default function SearchProviderSection() {
  const t = useT();
  const [status, setStatus] = useState<Status>({ configured: false });
  const [mode, setMode] = useState<Mode>("empty");
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [testResult, setTestResult] = useState<
    null | { ok: true } | { ok: false; reason: string }
  >(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const s = await getSearchProviderStatus(ACTIVE_SEARCH_PROVIDER);
    setStatus(s);
    setMode(s.configured ? "configured" : "empty");
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (mode === "editing") inputRef.current?.focus();
  }, [mode]);

  async function handleSaveAndTest() {
    const k = draft.trim();
    if (!k) return;
    try {
      setBusy(true);
      await setSearchProviderKey(ACTIVE_SEARCH_PROVIDER, k);
      const provider = getSearchProvider(ACTIVE_SEARCH_PROVIDER);
      const r = await provider.test(k);
      if (r.ok) {
        await markVerified(ACTIVE_SEARCH_PROVIDER);
        setTestResult({ ok: true });
      } else {
        setTestResult({ ok: false, reason: r.reason ?? "Unknown" });
      }
      setDraft("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleForget() {
    if (!confirm(t("settings.searchProvider.forgetConfirm"))) return;
    await clearSearchProviderKey(ACTIVE_SEARCH_PROVIDER);
    setTestResult(null);
    await reload();
  }

  async function handleReTest() {
    try {
      setBusy(true);
      const provider = getSearchProvider(ACTIVE_SEARCH_PROVIDER);
      const plain = await getSearchProviderKey(ACTIVE_SEARCH_PROVIDER);
      if (!plain) return;
      const r = await provider.test(plain);
      if (r.ok) await markVerified(ACTIVE_SEARCH_PROVIDER);
      setTestResult(r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Unknown" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // ---------- Caps + Title (shared) ----------
  const capsRight =
    mode === "editing" ? (
      <span className="caps text-fg-2">{t("settings.searchProvider.statusEditing")}</span>
    ) : mode === "configured" ? (
      <span className="flex items-center gap-1.5 caps text-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        {t("settings.searchProvider.statusActive")}
      </span>
    ) : (
      <span className="caps text-fg-3">{t("settings.searchProvider.statusNotSet")}</span>
    );

  return (
    <section className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">
            {t("settings.searchProvider.caps")}
          </span>
          {capsRight}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] text-fg-2">
            {t("settings.searchProvider.titleProvider")}
          </span>
          <span className="text-[12px] text-fg-2">
            {t("settings.searchProvider.subtitle")}
          </span>
        </div>
      </div>

      {/* Card — no border */}
      <div className="flex flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <span className="caps text-fg-3">{t("settings.searchProvider.apiKeyLabel")}</span>
          <span className="caps text-fg-3">{t("settings.searchProvider.storageMeta")}</span>
        </div>

        {mode === "empty" && (
          <>
            <div className="rounded-[10px] border border-line bg-field px-3.5 py-3">
              <span className="font-mono text-[13px] text-fg-3">
                tvly-···································
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                iconLeft={<span>+</span>}
                onClick={() => setMode("editing")}
              >
                {t("settings.searchProvider.addKey")}
              </Button>
            </div>
          </>
        )}

        {mode === "configured" && (
          <>
            <div className="font-mono text-[13px] text-fg-1">{status.maskedKey ?? ""}</div>
            <div className="flex items-center gap-2 text-[12px]">
              {testResult?.ok === false ? (
                <span className="text-warning">
                  ✗ {t("settings.searchProvider.rejected")}
                </span>
              ) : status.lastVerifiedAt ? (
                <span className="text-accent">
                  ✓ {t("settings.searchProvider.verified")}
                </span>
              ) : (
                <span className="text-fg-3">
                  — {t("settings.searchProvider.statusNotSet")}
                </span>
              )}
              <span className="text-fg-3">·</span>
              <span className="text-fg-2">
                {status.lastVerifiedAt ? formatRelative(status.lastVerifiedAt) : t("settings.searchProvider.statusNotSet")}
              </span>
              <div className="flex-1" />
              <Button variant="secondary" size="md" disabled={busy} onClick={handleReTest}>
                {t("settings.searchProvider.reTest")}
              </Button>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => {
                  setMode("editing");
                  setDraft("");
                }}
              >
                {t("settings.searchProvider.replaceKey")}
              </Button>
              <Button variant="danger" size="md" disabled={busy} onClick={handleForget}>
                {t("settings.searchProvider.forget")}
              </Button>
            </div>
          </>
        )}

        {mode === "editing" && (
          <>
            <div className="flex items-center gap-2 rounded-[10px] border border-accent-line bg-field px-3.5 py-3">
              <input
                ref={inputRef}
                type={reveal ? "text" : "password"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="tvly-..."
                className="flex-1 bg-transparent font-mono text-[13px] text-fg-1 outline-none placeholder:text-fg-3"
              />
              <button
                onClick={() => setReveal((v) => !v)}
                aria-label="reveal"
                className="text-fg-2"
              >
                {reveal ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-fg-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>{t("settings.searchProvider.encryptedHint")}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="primary"
                size="md"
                disabled={!draft.trim() || busy}
                onClick={handleSaveAndTest}
              >
                {t("settings.searchProvider.saveAndTest")}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setMode(status.configured ? "configured" : "empty");
                  setDraft("");
                }}
              >
                {t("settings.searchProvider.cancel")}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Footer only when empty */}
      {mode === "empty" && (
        <div className="flex flex-col gap-2.5 px-0.5">
          <p className="text-[13px] leading-[20px] text-fg-2">
            {t("settings.searchProvider.emptyBlurb")}
          </p>
          <a
            href="https://tavily.com/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent"
          >
            {t("settings.searchProvider.getKeyLink")}
          </a>
        </div>
      )}
    </section>
  );
}

function formatRelative(ts: number): string {
  const secs = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
