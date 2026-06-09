import { useState, useEffect, useRef } from "react";
import { useT, setLocale, type LocaleSetting, type DictKey } from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";

const OPTIONS: { value: LocaleSetting; labelKey: DictKey }[] = [
  { value: "auto", labelKey: "settings.language.optionAuto" },
  { value: "en", labelKey: "settings.language.optionEn" },
  { value: "zh-CN", labelKey: "settings.language.optionZhCN" },
];

export default function LanguageSelect() {
  const t = useT();
  const [value, setValue] = useState<LocaleSetting>("auto");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getConfig<string>("ui_locale").then((v) => {
      if (v === "auto" || v === "en" || v === "zh-CN") setValue(v);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = (v: LocaleSetting) => {
    setValue(v);
    setOpen(false);
    void setLocale(v);
  };
  const currentLabel = t(OPTIONS.find((o) => o.value === value)!.labelKey);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-[10px] bg-field px-3 py-2.5 text-[13px] text-fg-1"
      >
        <span>{currentLabel}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-fg-3">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute z-10 mt-1 flex w-full flex-col gap-0.5 rounded-[9px] border border-line bg-surface p-1"
        >
          {OPTIONS.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => choose(o.value)}
                className={`flex items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] ${
                  active ? "bg-accent-tint font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"
                }`}
              >
                <span>{t(o.labelKey)}</span>
                {active && (
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="text-accent">
                    <path
                      d="M2.5 7.5L5.5 10.5L11.5 4"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
