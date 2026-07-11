/**
 * PieFace — Pie IP 形象（同心深框 + 白饼 + 眼睛表情），直译定稿设计稿。
 * 全部参数见 docs/specs/2026-07-11-ip-animate-sidepanel.md。
 *
 * 品牌固有色（深框/白饼/眼睛）与 app icon 同理，不随主题反转；
 * 只有点睛元素（扫描环/声波/光环）走 var(--c-accent)。
 *
 * 纯展示组件，无内部 state：`wake` 是单次 morph，播完通过 onWakeEnd
 * 通知父层切换（通常切到 "idle"）。
 */
import type { CSSProperties, ReactElement } from "react";

export type PieFaceState =
  | "wake"
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "success"
  | "static";

interface PieFaceProps {
  state: PieFaceState;
  /** 正方形边长 px。 */
  size: number;
  /** 单次 wake morph 播完时触发（仅 state="wake"）。 */
  onWakeEnd?: () => void;
}

const SHELL = "#14181D";
const DISC = "#FAFBFC";
const FEAT = "#14181D";
const EE = "cubic-bezier(0.32, 0.72, 0, 1)";

export default function PieFace({ state, size, onWakeEnd }: PieFaceProps) {
  const disc = size * 0.84;
  const dOff = (size - disc) / 2;

  const shellStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    background: SHELL,
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,.05)",
  };

  // ── wake：图标缺口 → 双眼滑入（单次，both fill），身体同步呼吸 ──
  if (state === "wake") {
    const eyeW = disc * 0.15;
    const ecy = dOff + disc * 0.45;
    const eye = (cx: number, bx: number): CSSProperties => ({
      position: "absolute",
      width: eyeW,
      height: eyeW,
      left: cx - eyeW / 2,
      top: ecy - eyeW / 2,
      borderRadius: "50%",
      background: FEAT,
      transformOrigin: "center",
      ["--pie-bx" as string]: `${bx}px`,
      ["--pie-by" as string]: `${-disc * 0.366}px`,
      animation: `pie-wake-in 1.2s ${EE} both`,
    });
    return (
      <div
        style={{ position: "relative", width: size, height: size }}
        data-pie-state="wake"
        aria-hidden="true"
        onAnimationEnd={(e) => {
          // 两只眼的 animationend 都会冒泡到这里；父层切 state 后组件即
          // 重渲染为其它分支，重复调用无害。
          if (e.animationName === "pie-wake-in") onWakeEnd?.();
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "50% 64%",
            animation: `pie-breathe 3.4s ${EE} infinite`,
          }}
        >
          <div style={shellStyle} />
          {/* 圆形 clip：滑入过程眼睛不出框 */}
          <div style={{ position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden" }}>
            <div
              style={{
                position: "absolute",
                width: disc,
                height: disc,
                left: dOff,
                top: dOff,
                borderRadius: "50%",
                background: DISC,
              }}
            />
            {/* 左右眼同源自图标缺口（右上大黑点）分裂滑入 */}
            <div style={eye(size / 2 - disc * 0.16, disc * 0.546)} />
            <div style={eye(size / 2 + disc * 0.16, disc * 0.226)} />
          </div>
        </div>
      </div>
    );
  }

  // ── 其余状态：身体动画 + 状态眼型 + 点睛元素 ──
  const bodyAnim: Partial<Record<PieFaceState, string>> = {
    idle: `pie-breathe 3.4s ${EE} infinite`,
    thinking: "pie-tilt 2.8s ease-in-out infinite",
    working: "pie-vibrate 0.85s ease-in-out infinite",
    success: `pie-hop 1.15s ${EE} infinite`,
    listening: "pie-listen 2.0s ease-in-out infinite",
  };

  const eyeStyle: CSSProperties = (() => {
    const base: CSSProperties = { background: FEAT, flex: "0 0 auto" };
    if (state === "working")
      return { ...base, width: disc * 0.2, height: disc * 0.075, borderRadius: disc * 0.045 };
    if (state === "success")
      return { ...base, width: disc * 0.185, height: disc * 0.11, borderRadius: `${disc}px ${disc}px 0 0` };
    if (state === "listening")
      return { ...base, width: disc * 0.175, height: disc * 0.175, borderRadius: "50%" };
    return { ...base, width: disc * 0.15, height: disc * 0.15, borderRadius: "50%" };
  })();

  const blink = state === "idle" || state === "listening";
  let eyesContent = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: disc * 0.17,
        transformOrigin: "center",
        animation: blink ? `pie-blink 4.6s ${EE} infinite` : "none",
      }}
    >
      <div style={eyeStyle} />
      <div style={eyeStyle} />
    </div>
  );

  if (state === "thinking") {
    const dd = disc * 0.13;
    const dot: CSSProperties = {
      background: FEAT,
      width: dd,
      height: dd,
      borderRadius: "50%",
      flex: "0 0 auto",
    };
    const jump = (i: number) =>
      `pie-dotjump 1.05s ease-in-out ${(i * 0.15).toFixed(2)}s infinite`;
    eyesContent = (
      <div style={{ display: "flex", alignItems: "center", gap: disc * 0.11 }}>
        <div style={{ ...dot, animation: jump(0) }} />
        <div style={{ ...dot, animation: jump(1) }} />
        <div style={{ animation: `pie-thirdin 0.5s ${EE} both`, display: "flex" }}>
          <div style={{ ...dot, animation: jump(2) }} />
        </div>
      </div>
    );
  }

  const extras: ReactElement[] = [];
  if (state === "working") {
    const rs = size * 0.98;
    const r = rs / 2 - 3;
    const C = 2 * Math.PI * r;
    extras.push(
      <div
        key="ring"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: rs,
          height: rs,
          marginLeft: -rs / 2,
          marginTop: -rs / 2,
          animation: "pie-spin 1.1s linear infinite",
        }}
      >
        <svg width={rs} height={rs} viewBox={`0 0 ${rs} ${rs}`}>
          <circle
            cx={rs / 2}
            cy={rs / 2}
            r={r}
            fill="none"
            stroke="var(--c-accent)"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray={`${C * 0.26} ${C}`}
          />
        </svg>
      </div>,
    );
  }
  if (state === "listening") {
    for (const i of [0, 1]) {
      extras.push(
        <div
          key={`pulse-${i}`}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: disc,
            height: disc,
            marginLeft: -disc / 2,
            marginTop: -disc / 2,
            borderRadius: "50%",
            border: "2px solid var(--c-accent)",
            animation: "pie-pulse 1.9s ease-out infinite",
            animationDelay: `${i * 0.95}s`,
          }}
        />,
      );
    }
  }
  if (state === "success") {
    extras.push(
      <div
        key="pop"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: disc,
          height: disc,
          marginLeft: -disc / 2,
          marginTop: -disc / 2,
          borderRadius: "50%",
          border: "2.4px solid var(--c-accent)",
          animation: `pie-pop 1.15s ${EE} infinite`,
        }}
      />,
    );
  }

  return (
    <div
      style={{ position: "relative", width: size, height: size }}
      data-pie-state={state}
      aria-hidden="true"
    >
      {extras}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "50% 64%",
          animation: bodyAnim[state] ?? "none",
        }}
      >
        <div style={shellStyle} />
        <div
          style={{
            position: "absolute",
            width: disc,
            height: disc,
            left: dOff,
            top: dOff,
            borderRadius: "50%",
            background: DISC,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: state === "thinking" ? "48%" : "45%",
              transform: "translate(-50%,-50%)",
            }}
          >
            {eyesContent}
          </div>
        </div>
      </div>
    </div>
  );
}
