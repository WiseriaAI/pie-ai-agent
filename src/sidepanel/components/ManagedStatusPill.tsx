export type StatusTone = "success" | "warning" | "neutral";

export function ManagedStatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  const box = {
    success: "bg-success-tint text-success",
    warning: "bg-warning-tint text-warning",
    neutral: "bg-field text-fg-2",
  }[tone];
  const dot = { success: "bg-success", warning: "bg-warning", neutral: "bg-fg-3" }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${box}`}>
      <span className={`h-[5px] w-[5px] rounded-full ${dot}`} />
      {label}
    </span>
  );
}
