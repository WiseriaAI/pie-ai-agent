import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import {
  getCustomRules,
  setCustomRules,
  CUSTOM_RULES_MAX_LENGTH,
} from "@/lib/custom-rules";

// #344 — Custom rules二级页。用户配置一段全局自由文本规则，task start 时快照拼进
// agent system prompt（trusted 用户偏好块）。textarea + 字符计数 + 保存反馈；空串
// 保存即关闭功能。上限 4000 字符由 textarea maxLength + 保存校验 + prompt 层 slice
// 三处共同兜底。

export default function CustomRulesPage() {
  const t = useT();
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    let alive = true;
    void getCustomRules().then((v) => {
      if (alive) {
        setValue(v);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  async function onSave() {
    if (status === "saving") return;
    setStatus("saving");
    // Defensive clamp mirrors the storage layer + prompt-builder slice.
    await setCustomRules(value.slice(0, CUSTOM_RULES_MAX_LENGTH));
    setStatus("saved");
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-[12px] leading-[18px] text-fg-2">
        {t("settings.customRules.description")}
      </p>

      <textarea
        data-testid="custom-rules-textarea"
        value={value}
        disabled={!loaded}
        maxLength={CUSTOM_RULES_MAX_LENGTH}
        onChange={(e) => {
          setValue(e.target.value);
          if (status !== "idle") setStatus("idle");
        }}
        placeholder={t("settings.customRules.placeholder")}
        rows={10}
        className="w-full resize-y rounded-control border border-line bg-field px-2.5 py-2 text-[13px] leading-[19px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
      />

      <div className="flex items-center justify-between gap-3">
        <span
          data-testid="custom-rules-count"
          className={`text-[12px] tabular-nums ${
            value.length >= CUSTOM_RULES_MAX_LENGTH ? "text-warning" : "text-fg-3"
          }`}
        >
          {t("settings.customRules.charCount", {
            count: String(value.length),
            max: String(CUSTOM_RULES_MAX_LENGTH),
          })}
        </span>
        <div className="flex items-center gap-3">
          {status === "saved" && (
            <span className="text-[12px] text-success">
              {t("settings.customRules.saved")}
            </span>
          )}
          <button
            type="button"
            data-testid="custom-rules-save"
            onClick={() => void onSave()}
            disabled={!loaded || status === "saving"}
            className="shrink-0 rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
          >
            {t("settings.customRules.save")}
          </button>
        </div>
      </div>

      <p className="text-[11px] leading-[16px] text-fg-3">
        {t("settings.customRules.safetyNote")}
      </p>
    </section>
  );
}
