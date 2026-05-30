import type { FileAttachment } from "@/lib/files/types";
import { useT } from "@/lib/i18n";

export function FileChip({ attachment, onRemove }: { attachment: FileAttachment; onRemove?: (id: string) => void }) {
  const t = useT();
  const icon = attachment.mime === "application/pdf" ? "📄" : "📝";
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-line bg-field px-2 py-1 text-[12px] text-fg-1">
      <span aria-hidden="true">{icon}</span>
      <span className="max-w-[160px] truncate">{attachment.name}</span>
      {attachment.truncated && <span className="text-fg-3">({t("chat.files.truncated")})</span>}
      {onRemove && (
        <button
          type="button"
          aria-label={t("chat.files.remove")}
          onClick={() => onRemove(attachment.id)}
          className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-canvas text-fg-2 hover:text-fg-1"
        >
          ×
        </button>
      )}
    </div>
  );
}
