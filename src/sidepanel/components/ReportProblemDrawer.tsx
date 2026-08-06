// Per-message "Report problem" drawer.
//
// Unlike the Settings feedback form (free text + optional console logs), this
// one ships the conversation itself — prompts, tool calls, tool results — so a
// broken session can be diagnosed after the fact.
//
// PRIVACY: the transcript carries raw page content the agent read. That is a
// bigger disclosure than anything else in the extension, so the drawer states
// it in plain language above the send button and never sends without a click.

import { useEffect, useState } from "react";
import { useT, getLocale } from "@/lib/i18n";
import { listInstances } from "@/lib/instances";
import { buildTranscript, type FeedbackEnv } from "@/lib/feedback";
import { submitFeedback } from "@/lib/managed-account";
import type { DisplayMessage } from "@/types/messages";
import { Drawer } from "./ui/Drawer";

export function ReportProblemDrawer({
  open,
  onClose,
  messages,
  messageIndex,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  messages: readonly DisplayMessage[];
  /** Index of the message whose report button was clicked. */
  messageIndex: number | null;
  sessionId: string | null;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  // Reset per open so a previous send's state doesn't leak into a new report.
  useEffect(() => {
    if (open) {
      setNote("");
      setStatus("idle");
    }
  }, [open]);

  async function onSend() {
    if (status === "sending") return;
    setStatus("sending");
    try {
      const instances = await listInstances();
      const active = instances[0];
      const env: FeedbackEnv = {
        version: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        providerModel: active ? active.provider : "(no config)",
        locale: getLocale(),
      };
      await submitFeedback({
        // The note is optional — an empty report is still useful because the
        // transcript is the payload that matters.
        message: note.trim() || "(no description)",
        env,
        transcript: buildTranscript(messages, messageIndex ?? undefined),
        ...(sessionId ? { sessionId } : {}),
        ...(messageIndex !== null ? { messageIndex } : {}),
        ...(instances.find((i) => i.provider === "managed")?.apiKey
          ? { apiKey: instances.find((i) => i.provider === "managed")!.apiKey }
          : {}),
      });
      setStatus("sent");
      window.setTimeout(onClose, 1200);
    } catch {
      setStatus("error");
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      ariaLabel={t("chat.report.title")}
      side="right"
      width={320}
      backdropTestId="report-backdrop"
      panelStyle={{
        background: "var(--c-surface-deep)",
        borderLeft: "1px solid var(--c-line)",
      }}
    >
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {t("chat.report.title")}
        </div>
        <p className="text-[12px] leading-[18px] text-fg-2">{t("chat.report.hint")}</p>
        <textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (status !== "idle") setStatus("idle");
          }}
          placeholder={t("chat.report.placeholder")}
          rows={5}
          className="w-full resize-y rounded-control border border-line bg-field px-2.5 py-2 text-[13px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
        />
        <p className="text-[11px] leading-[16px] text-fg-3">{t("chat.report.privacy")}</p>
        <div className="mt-auto flex items-center justify-between gap-3">
          {status === "sent" && (
            <span className="text-[12px] text-success">{t("chat.report.sent")}</span>
          )}
          {status === "error" && (
            <span className="text-[12px] text-warning">{t("chat.report.error")}</span>
          )}
          <button
            onClick={onSend}
            disabled={status === "sending" || status === "sent"}
            className="ml-auto shrink-0 rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
          >
            {status === "sending" ? t("chat.report.sending") : t("chat.report.send")}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
