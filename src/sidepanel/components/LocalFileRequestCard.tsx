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
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] leading-[18px] text-warning">
      <div className="text-[13px] font-medium text-warning">
        Pie wants to read a local file
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
          Choose file…
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-warning-line/50 bg-transparent px-2.5 py-1 text-[11px] text-warning/70 hover:text-warning"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
