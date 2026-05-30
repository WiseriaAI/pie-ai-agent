import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n";
import { REQUEST_TIMEOUT_MS } from "@/lib/local-file-request";

interface Props {
  onChoose: () => void;
  onCancel: () => void;
}

/**
 * Shown when the agent calls `request_local_file`. "Choose file" is the user
 * gesture that opens the file picker (routed through a dedicated hidden input
 * in Chat.tsx). Mirrors CdpOnboardingCard's styling.
 */
export function LocalFileRequestCard({ onChoose, onCancel }: Props) {
  const t = useT();
  const [seconds, setSeconds] = useState(Math.round(REQUEST_TIMEOUT_MS / 1000));

  useEffect(() => {
    if (seconds <= 0) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        const next = s - 1;
        if (next <= 0) {
          clearInterval(id);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">
        {t("chat.files.requestTitle")}
      </div>
      <p className="text-warning/90">
        The agent asked for a file. Choose a text/code file or a PDF to share its
        contents. For images, attach them via the + menu instead.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onChoose}
          className="rounded border border-warning-line bg-warning-tint px-2.5 py-1 text-[11px] font-medium text-warning hover:bg-warning-line/30"
        >
          {t("chat.files.requestChoose")}…
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          {seconds > 0
            ? `${t("chat.files.requestCancel")} (${seconds}s)`
            : t("chat.files.requestCancel")}
        </button>
      </div>
    </div>
  );
}
