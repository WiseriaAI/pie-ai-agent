import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n";
import { REQUEST_TIMEOUT_MS } from "@/lib/local-file-request";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./hitl/HitlCardShell";

interface Props {
  onChoose: () => void;
  onCancel: () => void;
}

const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
    <path d="M14 3v5h5" />
  </svg>
);

/**
 * request_local_file 卡（#270 迁 HitlCardShell，browser/accent 档）。
 * "选择文件"是打开 file picker 的用户手势（经 Chat.tsx 隐藏 input 路由）。
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <HitlCardShell
      register="browser"
      icon={<FileIcon />}
      capsLabel={t("hitl.caps.localFile")}
      title={t("chat.files.requestTitle")}
      description={t("chat.files.requestBody")}
      actions={
        <>
          <HitlSecondaryButton onClick={onCancel}>
            {seconds > 0
              ? `${t("chat.files.requestCancel")} (${seconds}s)`
              : t("chat.files.requestCancel")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="browser" onClick={onChoose}>
            {t("chat.files.requestChoose")}…
          </HitlPrimaryButton>
        </>
      }
    />
  );
}
