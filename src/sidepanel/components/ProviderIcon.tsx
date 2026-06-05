import type { CSSProperties } from "react";
import type { ProviderRef, BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";

interface Props {
  provider: ProviderRef;
  /** 方块边长 px */
  size: number;
  /** 当前选中态可传 accent 色（如 "text-accent"）；默认 text-fg-2 */
  className?: string;
}

/**
 * 内置 provider 图标；缺图标 / custom provider 回退到首字母 monogram。
 * 单色 svg 通过 CSS mask + `background-color: currentColor` 着色，由 `color`
 * （className / 继承）控制主题色 —— 深色主题给浅色 logo，浅色主题给深色 logo。
 */
export default function ProviderIcon({ provider, size, className }: Props) {
  const isCustom = provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustom ? undefined : getProviderMeta(provider as BuiltinProvider);
  const box = Math.round(size);
  const wrap: CSSProperties = {
    width: box,
    height: box,
    borderRadius: Math.max(4, Math.round(box * 0.27)),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  if (meta?.iconAsset) {
    const url = chrome.runtime.getURL(meta.iconAsset);
    const inner = Math.round(box * 0.62);
    return (
      <span style={wrap} className={`bg-field border border-line ${className ?? "text-fg-2"}`}>
        <span
          data-testid="provider-icon-img"
          data-icon-url={url}
          aria-hidden
          style={{
            width: inner,
            height: inner,
            backgroundColor: "currentColor",
            WebkitMaskImage: `url(${url})`,
            maskImage: `url(${url})`,
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskPosition: "center",
            maskPosition: "center",
          }}
        />
      </span>
    );
  }

  return (
    <span style={wrap} className={`bg-field border border-line ${className ?? "text-fg-2"}`}>
      <span className="font-semibold leading-none" style={{ fontSize: Math.round(box * 0.5) }}>
        {monogram(provider, meta?.name)}
      </span>
    </span>
  );
}

/** 首字母 / 首汉字（英文大写）。custom provider 用其 id 段。 */
function monogram(provider: ProviderRef, name?: string): string {
  const src = (name ?? provider.replace(CUSTOM_PREFIX, "")).trim();
  if (!src) return "?";
  const ch = Array.from(src)[0]!;
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}
