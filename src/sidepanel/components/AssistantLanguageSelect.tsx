import { useEffect, useRef, useState } from "react";
import {
  getAssistantLanguageSetting,
  setAssistantLanguageSetting,
  useT,
  type AssistantLanguageSetting,
  type DictKey,
} from "@/lib/i18n";
import { LOCALE_REGISTRY, SUPPORTED_LOCALES } from "@/lib/i18n/locales";
import { Popover } from "./ui/Popover";
import { useAnchorRect } from "./ui/useAnchorRect";
import { computePopoverCoords } from "./ModelPicker";

const OPTIONS: { value: AssistantLanguageSetting; label?: string; labelKey?: DictKey }[] = [
  { value: "auto-follow-ui", labelKey: "settings.language.assistantFollowUi" },
  { value: "auto-detect-user-message", labelKey: "settings.language.assistantDetectMessage" },
  ...SUPPORTED_LOCALES.map((locale) => ({
    value: locale,
    label: LOCALE_REGISTRY[locale].nativeLabel,
  })),
];

export default function AssistantLanguageSelect() {
  const t = useT();
  const [value, setValue] = useState<AssistantLanguageSetting>("auto-follow-ui");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // 下拉 portal 到 body（设置根页分组容器 overflow-hidden 会裁掉组件内 absolute
  // 面板）；useAnchorRect 量测 + computePopoverCoords 钳位，与 ModelPicker 同款。
  const triggerRect = useAnchorRect(triggerRef, open);
  const coords = triggerRect
    ? computePopoverCoords(triggerRect, window.innerWidth, window.innerHeight)
    : null;

  useEffect(() => {
    getAssistantLanguageSetting().then(setValue);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      // 面板已 portal 到 body，外点判定要同时看触发器与面板两边。
      if (!ref.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = (next: AssistantLanguageSetting) => {
    setValue(next);
    setOpen(false);
    void setAssistantLanguageSetting(next);
  };
  const labelFor = (option: (typeof OPTIONS)[number]) => option.labelKey ? t(option.labelKey) : option.label ?? "";
  const currentLabel = labelFor(OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-[10px] border border-line bg-field px-3 py-2.5 text-[13px] text-fg-1"
      >
        <span>{open ? t("settings.language.assistantLabel") : currentLabel}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="text-fg-3">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <Popover
        open={open && !!coords}
        popoverRef={popoverRef}
        role="listbox"
        placement={coords?.bottom != null ? "above" : "below"}
        style={{ left: coords?.left, top: coords?.top, bottom: coords?.bottom }}
        className="fixed z-[100] flex w-[300px] max-w-[calc(100vw-1.5rem)] flex-col gap-0.5 rounded-[9px] border border-line bg-surface p-1 shadow-pop"
      >
        {OPTIONS.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => choose(option.value)}
              className={`flex items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] ${
                active ? "bg-accent-tint font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"
              }`}
            >
              <span>{labelFor(option)}</span>
              {active && (
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-accent">
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
      </Popover>
    </div>
  );
}
