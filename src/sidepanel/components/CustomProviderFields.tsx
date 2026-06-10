import { useT } from "@/lib/i18n";

interface Props {
  name: string;
  baseUrl: string;
  onNameChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onTest: () => void;
  testing?: boolean;
  testError?: string | null;
  showTestButton?: boolean;
  /** When editing an existing provider, show "shared by N config(s)" notice (N>0). */
  dependentCount?: number;
  /** When editing an existing provider, render a "Delete this provider" button; omit for create. */
  onDelete?: () => void;
  deleteDisabled?: boolean;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
          {label}
        </span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export default function CustomProviderFields(props: Props) {
  const t = useT();

  const showHttpWarning = (() => {
    const url = props.baseUrl;
    if (!url.startsWith("http://")) return false;
    try {
      const u = new URL(url);
      const h = u.hostname;
      if (
        h === "localhost" ||
        h === "127.0.0.1" ||
        h.startsWith("10.") ||
        h.startsWith("172.") ||
        h.startsWith("192.")
      )
        return false;
    } catch {
      return false;
    }
    return true;
  })();

  const testDisabled =
    props.testing || !/^https?:\/\//.test(props.baseUrl);

  return (
    <div className="flex flex-col gap-4">
      <Field label={t("customProvider.name")} hint={`${props.name.length}/40`}>
        <input
          value={props.name}
          onChange={(e) => props.onNameChange(e.target.value)}
          maxLength={40}
          placeholder={t("customProvider.namePlaceholder")}
          className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
        />
      </Field>

      <Field label={t("customProvider.baseUrl")}>
        <input
          value={props.baseUrl}
          onChange={(e) => props.onBaseUrlChange(e.target.value)}
          placeholder={t("customProvider.baseUrlPlaceholder")}
          className="w-full rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-accent-line"
        />
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] text-fg-2">
            ⓘ {t("customProvider.baseUrlHint")}
          </span>
          <span className="font-mono text-[10px] text-fg-3">
            ⓘ {t("customProvider.baseUrlWarning")}
          </span>
          {showHttpWarning && (
            <span className="font-mono text-[10px] text-warning">
              ⚠ {t("customProvider.baseUrlWarningHttp")}
            </span>
          )}
        </div>
      </Field>

      {props.showTestButton !== false && (
        <div className="flex flex-col gap-1.5">
          <button
            onClick={props.onTest}
            disabled={testDisabled}
            className="flex items-center gap-1.5 self-start rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
          >
            {props.testing && (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  stroke="currentColor"
                  strokeWidth="2"
                  opacity="0.3"
                />
                <path
                  d="M14 8A6 6 0 1 1 2 8"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {props.testing
              ? t("customProvider.testing")
              : t("customProvider.testConnection")}
          </button>
        </div>
      )}

      {props.testError && (
        <div className="font-mono text-[11px] text-warning">
          ✗ Error: {props.testError}
        </div>
      )}

      {props.onDelete !== undefined && (
        <div className="flex flex-col gap-1.5">
          {props.dependentCount !== undefined && props.dependentCount > 0 && (
            <div className="rounded border border-warning-line bg-warning-tint px-2.5 py-1.5 text-[11px] text-warning">
              {t("customProvider.sharedBy", { count: props.dependentCount })}
            </div>
          )}
          <button
            onClick={() => {
              if (!props.deleteDisabled) props.onDelete!();
            }}
            disabled={props.deleteDisabled}
            aria-label={t("customProvider.deleteThisProvider")}
            className="self-start rounded border border-warning-line bg-transparent px-3 py-1.5 text-[11px] text-warning hover:bg-warning-tint disabled:opacity-30"
          >
            {t("customProvider.deleteThisProvider")}
          </button>
        </div>
      )}
    </div>
  );
}
