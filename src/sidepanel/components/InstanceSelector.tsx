import { useState, useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import type { DecryptedInstance } from "@/lib/instances";

interface Props {
  instances: DecryptedInstance[];
  currentId: string | null;
  locked: boolean;
  onChange: (id: string) => void;
  onManage: () => void;
}

function shortModel(modelId: string): string {
  // drop OpenRouter "vendor/" prefix
  if (modelId.includes("/")) return modelId.split("/").pop()!;
  // drop common "claude-" prefix
  if (modelId.startsWith("claude-")) return modelId.slice("claude-".length);
  return modelId;
}

export default function InstanceSelector(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = props.instances.find((i) => i.id === props.currentId);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => !props.locked && setOpen(!open)}
        disabled={props.locked}
        className="flex items-center gap-1 px-1.5 py-1 text-[12px] text-fg-1 disabled:opacity-50"
        aria-label={current ? `${current.nickname} ${current.model}` : t("instanceSelector.selectConfig")}
      >
        <span>
          {current ? `${current.nickname} · ${shortModel(current.model)}` : t("instanceSelector.none")}
        </span>
        {props.locked ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="text-fg-3">
            <path d="M3 5V3.5C3 2.4 3.9 1.5 5 1.5C6.1 1.5 7 2.4 7 3.5V5M2.5 5H7.5V8.5H2.5V5Z" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className="text-fg-2"
            style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
          >
            <path d="M3.5 5.5L7 9L10.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute bottom-full left-0 mb-2 w-[280px] rounded-lg border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        >
          <div className="flex items-baseline justify-between px-3.5 pt-2.5 pb-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-3">{t("instanceSelector.switchConfig")}</span>
            <span className="font-mono text-[10px] text-fg-3">{props.instances.length} {t("settings.myConfigs.countSuffix")}</span>
          </div>
          <div className="flex flex-col">
            {props.instances.map((inst) => {
              const isCurrent = inst.id === props.currentId;
              return (
                <button
                  key={inst.id}
                  onClick={() => { props.onChange(inst.id); setOpen(false); }}
                  className={`flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-field ${isCurrent ? "bg-field" : ""}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isCurrent ? "bg-accent" : "bg-fg-3"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-fg-1">
                      {inst.nickname}
                      <span className="ml-1 text-[11px] font-normal text-fg-3">· {inst.provider}</span>
                    </div>
                    <div className="font-mono text-[10px] text-fg-2">{shortModel(inst.model)}</div>
                  </div>
                  {isCurrent && <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-accent">{t("instanceSelector.active")}</span>}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => { setOpen(false); props.onManage(); }}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2 text-left text-[11px] text-fg-2 hover:bg-field"
          >
            <span>{t("instanceSelector.newConfigOrManage")}</span>
            <span className="ml-auto font-mono text-[10px] text-fg-3">⌘,</span>
          </button>
        </div>
      )}
    </div>
  );
}
