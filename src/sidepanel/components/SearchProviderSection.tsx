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
  }

  async function handleForget() {
    if (!confirm(t("settings.searchProvider.forgetConfirm"))) return;
    await clearSearchProviderKey(ACTIVE_SEARCH_PROVIDER);
    setTestResult(null);
    await reload();
  }

  async function handleReTest() {
    const provider = getSearchProvider(ACTIVE_SEARCH_PROVIDER);
    const plain = await getSearchProviderKey(ACTIVE_SEARCH_PROVIDER);
    if (!plain) return;
    const r = await provider.test(plain);
    if (r.ok) await markVerified(ACTIVE_SEARCH_PROVIDER);
    setTestResult(r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Unknown" });
    await reload();
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
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="caps text-fg-3">{t("settings.searchProvider.caps")}</span>
          {capsRight}
        </div>
        <div className="flex items-baseline gap-2.5">
          <span className="text-[18px] font-semibold tracking-[-0.01em] text-fg-1">
            {t("settings.searchProvider.titleProvider")}
          </span>
          <span className="text-[13px] text-fg-2">
            {t("settings.searchProvider.subtitle")}
          </span>
        </div>
      </div>

      {/* Card */}
      <div className="flex flex-col gap-3.5 rounded-[9px] border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <span className="caps text-fg-3">{t("settings.searchProvider.apiKeyLabel")}</span>
          <span className="caps text-fg-3">{t("settings.searchProvider.storageMeta")}</span>
        </div>

        {mode === "empty" && (
          <>
            <div className="rounded-[7px] border border-line bg-field px-3.5 py-3">
              <span className="font-mono text-[13px] text-fg-3">
                tvly-···································
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMode("editing")}
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-field px-3.5 py-2 text-[13px] font-medium text-fg-1"
              >
                <span>+</span>
                {t("settings.searchProvider.addKey")}
              </button>
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
              ) : (
                <span className="text-accent">
                  ✓ {t("settings.searchProvider.verified")}
                </span>
              )}
              <span className="text-fg-3">·</span>
              <span className="text-fg-2">
                {status.lastVerifiedAt ? formatRelative(status.lastVerifiedAt) : "—"}
              </span>
              <div className="flex-1" />
              <button
                onClick={handleReTest}
                className="text-fg-2 underline decoration-line underline-offset-[3px]"
              >
                {t("settings.searchProvider.reTest")}
              </button>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => {
                  setMode("editing");
                  setDraft("");
                }}
                className="inline-flex items-center rounded-[6px] border border-line bg-field px-3.5 py-2 text-[13px] font-medium text-fg-1"
              >
                {t("settings.searchProvider.replaceKey")}
              </button>
              <button
                onClick={handleForget}
                className="inline-flex items-center rounded-[6px] border border-warning bg-transparent px-3.5 py-2 text-[13px] font-medium text-warning"
              >
                {t("settings.searchProvider.forget")}
              </button>
            </div>
          </>
        )}

        {mode === "editing" && (
          <>
            <div className="flex items-center gap-2 rounded-[7px] border border-accent bg-field px-3.5 py-3">
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
                {reveal ? "🙈" : "👁"}
              </button>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-fg-2">
              <span>🔒</span>
              <span>{t("settings.searchProvider.encryptedHint")}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleSaveAndTest}
                disabled={!draft.trim()}
                className="inline-flex items-center rounded-[6px] border border-accent bg-accent px-4 py-2 text-[13px] font-semibold text-bg disabled:opacity-50"
              >
                {t("settings.searchProvider.saveAndTest")}
              </button>
              <button
                onClick={() => {
                  setMode(status.configured ? "configured" : "empty");
                  setDraft("");
                }}
                className="inline-flex items-center rounded-[6px] border border-line bg-transparent px-3.5 py-2 text-[13px] font-medium text-fg-2"
              >
                {t("settings.searchProvider.cancel")}
              </button>
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
