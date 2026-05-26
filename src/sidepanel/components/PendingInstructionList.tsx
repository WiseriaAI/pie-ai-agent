import { useT } from "@/lib/i18n";

export interface PendingItem {
  chatMessageId: string;
  content: string;
}

export function PendingInstructionList({
  items,
  onCancel,
}: {
  items: PendingItem[];
  onCancel: (chatMessageId: string) => void;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
        <div className="h-1.5 w-1.5 rounded-full bg-[#C9A268]" />
        <span className="text-[#C9A268]">
          {t("chat.pending.captionPrefix")} · {items.length}{" "}
          {t("chat.pending.captionSuffix")}
        </span>
        <div className="flex-1" />
        <span className="text-fg-3">{t("chat.pending.hint")}</span>
      </div>
      {items.map((item) => (
        <div
          key={item.chatMessageId}
          className="group flex items-start gap-2.5 rounded-lg border border-[#1F242C] bg-[#14181E] px-3 py-2.5 transition-colors hover:border-[#2A3038] hover:bg-[#181D24]"
        >
          <div className="mt-1 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            <div className="h-1.5 w-1.5 rounded-full bg-[#C9A268]" />
          </div>
          <div className="flex-1 text-[13px] leading-[18px] text-[#C2C7CF]">
            {item.content}
          </div>
          <button
            type="button"
            aria-label={t("chat.pending.cancel")}
            title={t("chat.pending.cancel")}
            onClick={() => onCancel(item.chatMessageId)}
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-fg-3 opacity-0 transition-opacity hover:text-fg-1 group-hover:opacity-100"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
