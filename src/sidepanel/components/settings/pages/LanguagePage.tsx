import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  useT,
  setLocale,
  getAssistantLanguageSetting,
  setAssistantLanguageSetting,
  STORAGE_KEY_UI_LOCALE,
  type LocaleSetting,
  type AssistantLanguageSetting,
  type DictKey,
} from "@/lib/i18n";
import { getConfig } from "@/lib/idb/config-store";
import { LOCALE_REGISTRY, SUPPORTED_LOCALES } from "@/lib/i18n/locales";

// 界面语言 / 助手语言二级页：分组单选列表（取代旧的下拉组件）。选中即持久化，
// 停留在本页打勾确认，返回走顶栏 back。

type Option<V extends string> = { value: V; label?: string; labelKey?: DictKey };

const LOCALE_OPTIONS = SUPPORTED_LOCALES.map((locale) => ({
  value: locale,
  label: LOCALE_REGISTRY[locale].nativeLabel,
}));

const UI_OPTIONS: Option<LocaleSetting>[] = [
  { value: "auto", labelKey: "settings.language.optionAuto" },
  ...LOCALE_OPTIONS,
];

const ASSISTANT_OPTIONS: Option<AssistantLanguageSetting>[] = [
  { value: "auto-follow-ui", labelKey: "settings.language.assistantFollowUi" },
  { value: "auto-detect-user-message", labelKey: "settings.language.assistantDetectMessage" },
  ...LOCALE_OPTIONS,
];

function OptionList<V extends string>({
  options,
  value,
  onSelect,
}: {
  options: Option<V>[];
  value: V;
  onSelect: (v: V) => void;
}) {
  const t = useT();
  return (
    <div role="radiogroup" className="overflow-hidden rounded-card border border-line bg-surface">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(o.value)}
            className="flex h-[46px] w-full items-center gap-3 border-t border-line px-3.5 text-left first:border-t-0 hover:bg-field"
          >
            <span className={`flex-1 text-[13px] ${active ? "font-medium text-fg-1" : "text-fg-2"}`}>
              {o.labelKey ? t(o.labelKey) : o.label}
            </span>
            {active && <Check size={16} strokeWidth={2} className="shrink-0 text-accent" />}
          </button>
        );
      })}
    </div>
  );
}

export function UiLanguagePage() {
  const [value, setValue] = useState<LocaleSetting>("auto");
  useEffect(() => {
    getConfig<string>(STORAGE_KEY_UI_LOCALE).then((v) => {
      if (UI_OPTIONS.some((o) => o.value === v)) setValue(v as LocaleSetting);
    });
  }, []);
  return (
    <OptionList
      options={UI_OPTIONS}
      value={value}
      onSelect={(v) => {
        setValue(v);
        void setLocale(v);
      }}
    />
  );
}

export function AssistantLanguagePage() {
  const [value, setValue] = useState<AssistantLanguageSetting>("auto-follow-ui");
  useEffect(() => {
    getAssistantLanguageSetting().then(setValue);
  }, []);
  return (
    <OptionList
      options={ASSISTANT_OPTIONS}
      value={value}
      onSelect={(v) => {
        setValue(v);
        void setAssistantLanguageSetting(v);
      }}
    />
  );
}
