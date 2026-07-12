import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { isCdpInputEnabled, setCdpInputEnabled } from "@/lib/cdp-input-enabled";
import { Switch } from "../../ui/Switch";

function CdpInputSection({
  state,
  onSet,
}: {
  state: boolean | undefined;
  onSet: (next: boolean) => void;
}) {
  const t = useT();
  const enabled = state === true;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <div className="text-[13px] font-medium text-fg-1">{t("settings.cdpInput.title")}</div>
            <p className="text-[12px] leading-[18px] text-fg-2">
              {t("settings.cdpInput.description")}
            </p>
            <p className="text-[11px] text-fg-3 mt-0.5">
              {state === undefined
                ? t("settings.cdpInput.statusNotAsked")
                : enabled
                ? t("settings.cdpInput.statusEnabled")
                : t("settings.cdpInput.statusDisabled")}
            </p>
          </div>
          <Switch checked={enabled} onChange={onSet} />
        </div>
        {enabled && (
          <div className="flex flex-col gap-1.5 rounded-chip border border-warning-line bg-warning-tint px-3 py-2 text-[11px] leading-[16px] text-warning">
            <span className="font-medium">{t("settings.cdpInput.warningTitle")}</span>
            <ul className="flex flex-col gap-1 pl-3 text-warning/90">
              <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning1")}</li>
              <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning2")}</li>
              <li className="list-['—__'] pl-0">{t("settings.cdpInput.warning3")}</li>
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export default function CdpPage() {
  const [cdpInput, setCdpInput] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    isCdpInputEnabled().then(setCdpInput);
  }, []);

  return (
    <CdpInputSection
      state={cdpInput}
      onSet={async (next) => {
        setCdpInput(next);
        await setCdpInputEnabled(next);
      }}
    />
  );
}
