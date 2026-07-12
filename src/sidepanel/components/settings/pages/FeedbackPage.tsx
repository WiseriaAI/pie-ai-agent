import { useEffect, useState } from "react";
import { listInstances, type DecryptedInstance } from "@/lib/instances";
import { useT, getLocale } from "@/lib/i18n";
import { buildGithubNewIssueUrl, buildFeedbackMailto, type FeedbackEnv } from "@/lib/feedback";
import { submitFeedback } from "@/lib/managed-account";
import { readRecentLogs } from "@/lib/log-buffer";
import { capLogBytes } from "@/lib/log-cap";

const MAX_LOG_CHARS = 100_000;
// 留足 message≤4000 + env + JSON 转义开销，安全落在 256KB 请求体 bodyLimit 内。
const MAX_LOG_BYTES = 150_000;

export function FeedbackSection({ instances }: { instances: DecryptedInstance[] }) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [includeLogs, setIncludeLogs] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const active = instances[0];
  const env: FeedbackEnv = {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    providerModel: active ? active.provider : "(no config)",
    locale: getLocale(),
  };
  const managedApiKey = instances.find((i) => i.provider === "managed")?.apiKey;

  async function onSend() {
    const trimmed = message.trim();
    if (!trimmed || status === "sending") return;
    setStatus("sending");
    try {
      const logs = includeLogs
        ? capLogBytes((await readRecentLogs(Date.now())).slice(0, MAX_LOG_CHARS), MAX_LOG_BYTES)
        : undefined;
      await submitFeedback({ message: trimmed, env, ...(logs ? { logs } : {}), ...(managedApiKey ? { apiKey: managedApiKey } : {}) });
      setMessage("");
      setIncludeLogs(false);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.feedback.sectionTitle")}</div>
      <p className="text-[12px] leading-[18px] text-fg-2">{t("settings.feedback.formHint")}</p>
      <textarea
        value={message}
        onChange={(e) => { setMessage(e.target.value); if (status !== "idle") setStatus("idle"); }}
        placeholder={t("settings.feedback.placeholder")}
        rows={3}
        className="w-full resize-y rounded-control border border-line bg-field px-2.5 py-2 text-[13px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
      />
      <div className="flex items-center justify-between gap-3 pt-0.5">
        <label className="flex items-center gap-2 text-[12px] text-fg-2">
          <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} />
          {t("settings.feedback.includeLogs")}
        </label>
        <div className="flex items-center gap-3">
          {status === "sent" && <span className="text-[12px] text-success">{t("settings.feedback.sent")}</span>}
          {status === "error" && <span className="text-[12px] text-warning">{t("settings.feedback.sendError")}</span>}
          <button
            onClick={onSend}
            disabled={!message.trim() || status === "sending"}
            className="shrink-0 rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
          >
            {status === "sending" ? t("settings.feedback.sending") : t("settings.feedback.send")}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4 pt-0.5">
        <a href={buildGithubNewIssueUrl(env)} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-accent hover:underline">{t("settings.feedback.githubButton")} ↗</a>
        <a href={buildFeedbackMailto(env)} className="text-[13px] text-fg-2 hover:text-fg-1">{t("settings.feedback.emailButton")} ↗</a>
      </div>
    </section>
  );
}

export default function FeedbackPage() {
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  useEffect(() => {
    let alive = true;
    void listInstances().then((l) => {
      if (alive) setInstances(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  return <FeedbackSection instances={instances} />;
}
