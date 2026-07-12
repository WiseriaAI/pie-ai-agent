import type { ReactNode, ButtonHTMLAttributes } from "react";
import { m, DURATION, EASE_STANDARD } from "../ui/motion";

export type HitlRegister = "local" | "browser";

// 双色语义分档（spec §2）：local=触及本机执行(warning 珊瑚)，browser=浏览器域(accent 冷蓝灰)。
// 主按钮是整卡唯一浓色块；卡体保持中性 surface。
const REGISTER: Record<HitlRegister, { caps: string; primary: string }> = {
  local: {
    caps: "text-warning",
    primary: "bg-warning text-surface border border-warning-line",
  },
  browser: {
    caps: "text-accent",
    primary: "bg-accent-strong text-surface border border-accent-line",
  },
};

export interface HitlCardShellProps {
  register: HitlRegister;
  /** 14px stroke 语义图标，色随 register（父级 span 提供 currentColor） */
  icon: ReactNode;
  capsLabel: string;
  title: string;
  description?: string;
  children?: ReactNode;
  actions: ReactNode;
}

/**
 * HITL 卡统一骨架（#270）：与 ScheduleDraftCard 同款中性卡 + m.div 进出场。
 * AnimatePresence wrapper 由消费方（HitlInlineCards）提供，exit 才有动画。
 * 卡头只有图标 + caps 标签——不显示内部工具名。
 */
export function HitlCardShell({
  register,
  icon,
  capsLabel,
  title,
  description,
  children,
  actions,
}: HitlCardShellProps) {
  const r = REGISTER[register];
  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
      className="rounded-control border border-line bg-surface p-3.5 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className={`flex ${r.caps}`}>{icon}</span>
        <span className={`caps ${r.caps}`}>{capsLabel}</span>
      </div>
      <div className="flex flex-col gap-[3px]">
        <div className="text-[15px] font-semibold leading-[22px] tracking-[-0.005em] text-fg-1">
          {title}
        </div>
        {description && (
          <div className="text-[12px] leading-[18px] text-fg-2">{description}</div>
        )}
      </div>
      {children}
      <div className="flex items-center justify-end gap-2 pt-0.5">{actions}</div>
    </m.div>
  );
}

/** 主按钮：尺寸对齐 ScheduleDraftCard（px-4 py-2 text-[13px] font-semibold） */
export function HitlPrimaryButton({
  register,
  className = "",
  ...rest
}: { register: HitlRegister } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`${REGISTER[register].primary} rounded-lg px-4 py-2 text-[13px] font-semibold ${className}`}
      {...rest}
    />
  );
}

export function HitlSecondaryButton({
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`border border-line rounded-lg px-4 py-2 text-fg-2 text-[13px] font-medium ${className}`}
      {...rest}
    />
  );
}

/** 结构化明细容器：surface-deep 内嵌块 */
export function HitlDetailBlock({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-deep px-3 py-2.5 flex flex-col gap-2.5">
      {children}
    </div>
  );
}

/** 明细分组：caps 微标签 + 值行 */
export function HitlDetailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="caps text-fg-3">{label}</span>
      {children}
    </div>
  );
}
