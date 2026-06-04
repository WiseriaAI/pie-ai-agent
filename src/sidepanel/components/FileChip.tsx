import type { FileAttachment } from "@/lib/files/types";
import { useT } from "@/lib/i18n";
import { FileGlyph, PdfFileGlyph, TextFileGlyph } from "./icons";

function fileKind(att: FileAttachment): "pdf" | "text" | "other" {
  if (att.mime === "application/pdf") return "pdf";
  if (att.mime.startsWith("text/") || att.mime === "application/json") return "text";
  return "other";
}

export function FileChip({ attachment, onRemove }: { attachment: FileAttachment; onRemove?: (id: string) => void }) {
  const t = useT();
  const kind = fileKind(attachment);
  const Glyph = kind === "pdf" ? PdfFileGlyph : kind === "text" ? TextFileGlyph : FileGlyph;
  return (
    <div className="flex items-center gap-2 rounded-[10px] bg-accent-tint py-1 pl-1 pr-2.5 text-[12px] text-fg-1">
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-canvas ${
          kind === "pdf" ? "bg-warning" : "bg-accent"
        }`}
      >
        <Glyph />
      </span>
      <span className="max-w-[150px] truncate">{attachment.name}</span>
      {attachment.truncated && (
        <span className="shrink-0 text-[10px] text-fg-3">{t("chat.files.truncated")}</span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={t("chat.files.remove")}
          onClick={() => onRemove(attachment.id)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[13px] leading-none text-fg-3 hover:text-fg-1"
        >
          ×
        </button>
      )}
    </div>
  );
}
