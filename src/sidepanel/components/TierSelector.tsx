import { useState } from "react";

export interface TierOption { tierId: string; displayName: string; }
interface Props { tiers: TierOption[]; value: string; onChange: (tierId: string) => void; }

export function TierSelector({ tiers, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = tiers.find((t) => t.tierId === value) ?? tiers[0];
  const single = tiers.length <= 1;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !single && setOpen(!open)}
        className="flex w-full items-center gap-2 rounded border border-line bg-field px-3 py-2 text-left text-[12px] text-fg-1 hover:border-fg-3"
      >
        <span>{current?.displayName ?? "标准"}</span>
        {!single && <span className="ml-auto text-fg-3">{open ? "▴" : "▾"}</span>}
      </button>
      {open && !single && (
        <div className="absolute z-10 mt-1 w-full rounded border border-line bg-field shadow">
          {tiers.map((t) => (
            <button
              key={t.tierId}
              type="button"
              onClick={() => { onChange(t.tierId); setOpen(false); }}
              className="flex w-full items-center px-3 py-1.5 text-[12px] text-fg-1 hover:bg-surface"
            >
              {t.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
