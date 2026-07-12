import { ArrowUpRight } from "lucide-react";
import { useT, type DictKey } from "@/lib/i18n";

// 「关于」子页：hero（大图标 + 版本徽章 + tagline）+ 外链分组。取代设置根页的
// About footer；链接全部新开 tab。

const REPO = "https://github.com/WiseriaAI/pie-ai-agent";

const LINKS: { key: DictKey; href: string; trailing?: string }[] = [
  { key: "settings.about.website", href: "https://www.pie.chat/" },
  { key: "settings.about.changelog", href: `${REPO}/releases` },
  { key: "settings.about.github", href: REPO },
  { key: "settings.about.privacy", href: `${REPO}/blob/main/PRIVACY.md` },
  { key: "settings.about.license", href: `${REPO}/blob/main/LICENSE`, trailing: "Apache-2.0" },
];

export default function AboutPage() {
  const t = useT();
  const version = chrome.runtime.getManifest().version;
  return (
    <div className="flex flex-col gap-6">
      {/* Hero */}
      <div className="flex flex-col items-center gap-2.5 pt-4">
        <img
          src={chrome.runtime.getURL("icons/icon-128.png")}
          alt="Pie"
          className="h-16 w-16 rounded-[18px]"
        />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[17px] font-semibold tracking-[-0.01em] text-fg-1">Pie</span>
          <span className="rounded-full border border-line bg-field px-2.5 py-0.5 font-mono text-[11px] text-fg-2">
            v{version}
          </span>
        </div>
        <span className="text-[12px] text-fg-3">{t("settings.about.tagline")}</span>
      </div>

      {/* Links */}
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {LINKS.map((l) => (
          <a
            key={l.key}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-[46px] items-center gap-3 border-t border-line px-3.5 first:border-t-0 hover:bg-field"
          >
            <span className="flex-1 text-[13px] font-medium text-fg-1">{t(l.key)}</span>
            {l.trailing && <span className="font-mono text-[11px] text-fg-3">{l.trailing}</span>}
            <ArrowUpRight size={14} strokeWidth={1.75} className="shrink-0 text-fg-3" />
          </a>
        ))}
      </div>
    </div>
  );
}
