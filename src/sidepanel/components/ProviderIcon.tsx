import type { CSSProperties } from "react";
import type { ProviderRef, BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";

interface Props {
  provider: ProviderRef;
  /** 图标边长 px */
  size: number;
  /** 颜色（如 "text-accent"）；默认 text-fg-2。单色 svg 随之着色。 */
  className?: string;
}

/**
 * 内置 provider 图标（无外框，直接显示在名字旁）；缺图标 / custom provider 回退
 * 到首字母 monogram。单色 svg 通过 CSS mask + currentColor 着色，由 `color`
 * （className / 继承）控制主题色。
 */
export default function ProviderIcon({ provider, size, className }: Props) {
  const isCustom = provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustom ? undefined : getProviderMeta(provider as BuiltinProvider);
  const box = Math.round(size);
  const wrap: CSSProperties = {
    width: box,
    height: box,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  if (meta?.iconColorAsset) {
    // 全彩品牌徽标（自带底色/多色）：按原色 <img> 渲染，不走 mask（mask 会压成实心块）。
    const url = chrome.runtime.getURL(meta.iconColorAsset);
    return (
      <span style={wrap} className={className}>
        <img
          src={url}
          alt=""
          aria-hidden
          width={box}
          height={box}
          style={{ width: box, height: box, borderRadius: Math.round(box * 0.22), display: "block" }}
        />
      </span>
    );
  }

  if (meta?.iconAsset) {
    const url = chrome.runtime.getURL(meta.iconAsset);
    return (
      <span style={wrap} className={className ?? "text-fg-2"}>
        <span
          data-testid="provider-icon-img"
          data-icon-url={url}
          aria-hidden
          style={{
            width: box,
            height: box,
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
    <span style={wrap} className={className ?? "text-fg-2"}>
      <span className="font-semibold leading-none" style={{ fontSize: Math.round(box * 0.7) }}>
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
