# Pie IP 状态动画植入 Side Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把定稿 Pie IP（同心深框 + 白饼 + 眼睛表情）作为状态化形象植入 side panel Chat：空态唤醒/聆听、streaming 思考/执行、完成庆祝、历史静止脸。

**Architecture:** 一个无状态展示组件 `PieFace`（纯 CSS keyframes，直译设计稿）+ 一个瞬态 hook `useCelebrate`；全部状态由 Chat.tsx 现有信号（`streaming` / `streamingThinking` / `streamingText` / `messages` / `input`）derive，不新增全局状态、协议或存储。

**Tech Stack:** React 19 + TS、TailwindCSS v4（keyframes 进 `index.css`）、vitest + happy-dom + @testing-library/react。

**Spec:** `docs/specs/2026-07-11-ip-animate-sidepanel.md`（含全部动画参数直译表，本 plan 代码即其实现）。

## Global Constraints

- 品牌固有色写死：深框/眼睛 `#14181D`、白饼 `#FAFBFC`，**不随主题反转**；accent 元素一律 `var(--c-accent)`。
- keyframes 前缀 `pie-`，缓动 `cubic-bezier(0.32, 0.72, 0, 1)`（= 现有 `--ease-standard`）。
- 活跃动画同屏只有一个；历史消息头一律 `state="static"`。
- `greeting` 状态与「反向退场」**不实现**（YAGNI，spec 已裁定）。
- i18n 字典 6 语言键强制 parity（en / zh-CN / zh-TW / ja / es-419 / pt-BR），加 key 必须全字典同步。
- `prefers-reduced-motion` 由 `index.css` 现有全局规则兜底，组件内不做任何处理。
- 每个 task 收尾跑 `pnpm test`（相关文件）；最终 task 跑全量 `pnpm test` + `pnpm typecheck` + `pnpm build`。
- 提交信息用中文或英文均可，格式 `feat|test|docs: ...`。

---

### Task 1: PieFace 组件 + keyframes

**Files:**
- Modify: `src/sidepanel/index.css`（Motion 区块末尾，`drawer-down` 之后）
- Create: `src/sidepanel/components/PieFace.tsx`
- Test: `src/sidepanel/components/PieFace.test.tsx`

**Interfaces:**
- Produces: `export type PieFaceState = "wake" | "idle" | "listening" | "thinking" | "working" | "success" | "static"`；`export default function PieFace(props: { state: PieFaceState; size: number; onWakeEnd?: () => void }): JSX.Element`。后续所有 task 以 `import PieFace from "./PieFace"`（同目录）消费。
- 根元素带 `data-pie-state={state}` 与 `aria-hidden="true"`（纯装饰，语义由旁边文字承载）。

- [ ] **Step 1: 写失败测试**

`src/sidepanel/components/PieFace.test.tsx`：

```tsx
import { render, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import PieFace from "./PieFace";
import type { PieFaceState } from "./PieFace";

afterEach(() => {
  cleanup();
});

/** 渲染并返回 innerHTML，供 keyframe 名断言（happy-dom 不真跑 CSS 动画，
 *  断言 inline style 里的 animation 名即可）。 */
const html = (state: PieFaceState, size = 40) =>
  render(<PieFace state={state} size={size} />).container.innerHTML;

const ALL_KEYFRAMES = [
  "pie-breathe", "pie-blink", "pie-tilt", "pie-dotjump", "pie-thirdin",
  "pie-vibrate", "pie-spin", "pie-listen", "pie-pulse", "pie-hop",
  "pie-pop", "pie-wake-in",
];

describe("PieFace", () => {
  it("static: 无任何 pie-* 动画", () => {
    const h = html("static");
    for (const name of ALL_KEYFRAMES) expect(h).not.toContain(name);
  });

  it("idle: 呼吸 + 眨眼", () => {
    const h = html("idle");
    expect(h).toContain("pie-breathe");
    expect(h).toContain("pie-blink");
  });

  it("listening: 身体 listen + 眨眼 + 两圈 accent 声波", () => {
    const h = html("listening");
    expect(h).toContain("pie-listen");
    expect(h).toContain("pie-blink");
    expect((h.match(/pie-pulse/g) ?? []).length).toBe(2);
    expect(h).toContain("var(--c-accent)");
  });

  it("thinking: 歪头 + 三点跳动 + 第三点入场，无眨眼", () => {
    const h = html("thinking");
    expect(h).toContain("pie-tilt");
    expect((h.match(/pie-dotjump/g) ?? []).length).toBe(3);
    expect(h).toContain("pie-thirdin");
    expect(h).not.toContain("pie-blink");
  });

  it("working: 震动 + 旋转扫描环（SVG stroke 用 accent）", () => {
    const { container } = render(<PieFace state="working" size={40} />);
    const h = container.innerHTML;
    expect(h).toContain("pie-vibrate");
    expect(h).toContain("pie-spin");
    const circle = container.querySelector("circle")!;
    expect(circle.getAttribute("stroke")).toBe("var(--c-accent)");
    expect(circle.getAttribute("stroke-linecap")).toBe("round");
  });

  it("success: 弹跳 + 光环", () => {
    const h = html("success");
    expect(h).toContain("pie-hop");
    expect(h).toContain("pie-pop");
  });

  it("wake: 双眼滑入 morph，animationend(pie-wake-in) 触发 onWakeEnd", () => {
    const onWakeEnd = vi.fn();
    const { container } = render(
      <PieFace state="wake" size={140} onWakeEnd={onWakeEnd} />,
    );
    const root = container.querySelector('[data-pie-state="wake"]')!;
    expect(container.innerHTML).toContain("pie-wake-in");
    // 无关动画结束（如 pie-breathe）不触发
    fireEvent.animationEnd(root, { animationName: "pie-breathe" });
    expect(onWakeEnd).not.toHaveBeenCalled();
    fireEvent.animationEnd(root, { animationName: "pie-wake-in" });
    expect(onWakeEnd).toHaveBeenCalledTimes(1);
  });

  it("根元素 aria-hidden 且带 data-pie-state", () => {
    const { container } = render(<PieFace state="idle" size={16} />);
    const root = container.querySelector('[data-pie-state="idle"]')!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test PieFace`
Expected: FAIL（找不到模块 `./PieFace`）

- [ ] **Step 3: 加 keyframes 到 index.css**

在 `src/sidepanel/index.css` 的 Motion 区块末尾（`.drawer-down { ... }` 之后）追加：

```css
/* Pie IP face (PieFace.tsx) — keyframes 直译定稿设计稿（docs/specs/
   2026-07-11-ip-animate-sidepanel.md）。几何在组件内，全局只放 keyframes。
   prefers-reduced-motion 由上方全局规则统一塌缩，此处不重复处理。 */
@keyframes pie-breathe { 0%,100%{transform:scale(1)} 50%{transform:scale(1.035)} }
@keyframes pie-tilt { 0%,100%{transform:rotate(-5deg)} 50%{transform:rotate(5deg)} }
@keyframes pie-vibrate { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-1.6%)} 75%{transform:translateX(1.6%)} }
@keyframes pie-hop { 0%,100%{transform:translateY(0) scale(1,1)} 14%{transform:translateY(0) scale(1.09,.9)} 44%{transform:translateY(-17%) scale(.95,1.07)} 72%{transform:translateY(0) scale(1.05,.95)} }
@keyframes pie-listen { 0%,100%{transform:scale(1)} 50%{transform:scale(1.025)} }
@keyframes pie-blink { 0%,91%,100%{transform:scaleY(1)} 95.5%{transform:scaleY(.1)} }
@keyframes pie-spin { to{transform:rotate(360deg)} }
@keyframes pie-pulse { 0%{transform:scale(.55);opacity:.5} 100%{transform:scale(2);opacity:0} }
@keyframes pie-pop { 0%{transform:scale(.4);opacity:.55} 78%,100%{transform:scale(1.7);opacity:0} }
@keyframes pie-dotjump { 0%,55%,100%{transform:translateY(0)} 27%{transform:translateY(-42%)} }
@keyframes pie-thirdin { 0%{opacity:0;transform:translateX(-95%) scale(.35)} 100%{opacity:1;transform:translateX(0) scale(1)} }
@keyframes pie-wake-in {
  from { transform: translate(var(--pie-bx), var(--pie-by)) scale(3.33); }
  to   { transform: translate(0, 0) scale(1); }
}
```

- [ ] **Step 4: 写 PieFace.tsx**

`src/sidepanel/components/PieFace.tsx` 完整内容：

```tsx
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test PieFace`
Expected: PASS（8 个用例全绿）

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/PieFace.tsx src/sidepanel/components/PieFace.test.tsx src/sidepanel/index.css
git commit -m "feat: PieFace 组件 — Pie IP 七态动画直译（含 static）"
```

---

### Task 2: useCelebrate hook（完成态瞬态信号）

**Files:**
- Create: `src/sidepanel/hooks/useCelebrate.ts`
- Test: `src/sidepanel/hooks/useCelebrate.test.ts`

**Interfaces:**
- Consumes: `DisplayMessage`（`@/types`）。
- Produces: `export function useCelebrate(args: { streaming: boolean; error: string | null; messages: readonly DisplayMessage[]; sessionId: string | null }): boolean`。Task 6 在 Chat.tsx 中消费。
- 语义：streaming `true → false` 边沿、无 error、末尾消息是 `agent-summary(success=true)` 或 `assistant`（chat-done 自然完成；abort 走 agent-done-task 会以 `success:false` 的 agent-summary 收尾，天然不触发）→ 返回 true 持续 2500ms。新 streaming 开始或 sessionId 变更立即复位。不持久化。

- [ ] **Step 1: 写失败测试**

`src/sidepanel/hooks/useCelebrate.test.ts`：

```tsx
import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCelebrate } from "./useCelebrate";
import type { DisplayMessage } from "@/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers();
});

const assistantMsg: DisplayMessage = { role: "assistant", content: "done" };
const okSummary: DisplayMessage = {
  role: "agent-summary",
  success: true,
  summary: "did it",
  stepCount: 3,
};
const failSummary: DisplayMessage = { ...okSummary, success: false };

function setup(initial?: Partial<Parameters<typeof useCelebrate>[0]>) {
  const base = {
    streaming: false,
    error: null as string | null,
    messages: [] as DisplayMessage[],
    sessionId: "s1" as string | null,
  };
  return renderHook((props) => useCelebrate(props), {
    initialProps: { ...base, ...initial },
  });
}

describe("useCelebrate", () => {
  it("streaming true→false 且末尾 assistant → true，2.5s 后自动复位", () => {
    const { result, rerender } = setup({ streaming: true });
    expect(result.current).toBe(false);
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).toBe(false);
  });

  it("末尾 agent-summary success=true → true", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg, okSummary], sessionId: "s1" });
    expect(result.current).toBe(true);
  });

  it("agent-summary success=false（失败/abort/discard）→ 不庆祝", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [failSummary], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("chat-error（error 非空）→ 不庆祝", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: "boom", messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("非边沿（一直 false）→ 不庆祝", () => {
    const { result, rerender } = setup();
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("庆祝期间新任务开始 → 立即复位", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    rerender({ streaming: true, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(false);
  });

  it("庆祝期间 messages 变化不打断计时（2.5s 后照常复位）", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    rerender({ streaming: false, error: null, messages: [assistantMsg, okSummary], sessionId: "s1" });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).toBe(false);
  });

  it("sessionId 变更 → 立即复位", () => {
    const { result, rerender } = setup({ streaming: true });
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s1" });
    expect(result.current).toBe(true);
    rerender({ streaming: false, error: null, messages: [assistantMsg], sessionId: "s2" });
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test useCelebrate`
Expected: FAIL（找不到模块 `./useCelebrate`）

- [ ] **Step 3: 写实现**

`src/sidepanel/hooks/useCelebrate.ts`：

```ts
import { useEffect, useRef, useState } from "react";
import type { DisplayMessage } from "@/types";

const CELEBRATE_MS = 2500; // ≈ 2 个 success 循环（pie-hop 1.15s）

/**
 * Pie IP 完成态瞬态信号：streaming 成功收尾后为 true 持续 2.5s。
 * 纯 UI state，不持久化 —— 切会话 / 重开 panel / 恢复历史都不重播。
 *
 * 成功判定：streaming true→false 边沿、无 error、末尾消息是
 * agent-summary(success=true) 或 assistant（chat-done 自然完成）。
 * abort / discard 以 success:false 的 agent-summary 收尾，天然不触发。
 */
export function useCelebrate({
  streaming,
  error,
  messages,
  sessionId,
}: {
  streaming: boolean;
  error: string | null;
  messages: readonly DisplayMessage[];
  sessionId: string | null;
}): boolean {
  const [celebrating, setCelebrating] = useState(false);
  const prevStreamingRef = useRef(streaming);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (streaming) {
      // 新任务开始：取消进行中的庆祝。
      clearTimer();
      setCelebrating(false);
      return;
    }
    if (!was || error) return; // 非 true→false 边沿，或错误收尾
    const last = messages[messages.length - 1];
    const ok =
      (last?.role === "agent-summary" && last.success) ||
      last?.role === "assistant";
    if (!ok) return;
    setCelebrating(true);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCelebrating(false);
    }, CELEBRATE_MS);
    // 注意：不在此 effect 返回 cleanup —— messages 后续变化会重跑 effect，
    // 若返回 cleanup 会把计时器清掉导致 celebrating 永远卡 true。
  }, [streaming, error, messages]);

  // 切会话立即复位；卸载时清计时器。
  useEffect(() => {
    clearTimer();
    setCelebrating(false);
  }, [sessionId]);
  useEffect(() => clearTimer, []);

  return celebrating;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test useCelebrate`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useCelebrate.ts src/sidepanel/hooks/useCelebrate.test.ts
git commit -m "feat: useCelebrate — 任务成功收尾的 2.5s 瞬态庆祝信号"
```

---

### Task 3: i18n `chat.thinking` + WorkingIndicator 升级

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`（chat 区块 `working:` 之后，约 line 221）
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts` / `zh-TW.ts` / `ja.ts` / `es-419.ts` / `pt-BR.ts`（同位置）
- Modify: `src/sidepanel/components/Chat.tsx`（`WorkingIndicator` 函数，约 line 2025-2041；调用点约 line 1386）
- Test: `src/sidepanel/components/Chat.test.tsx`（新增 describe）

**Interfaces:**
- Consumes: Task 1 的 `PieFace`。
- Produces: `WorkingIndicator({ thinking }: { thinking: boolean })`（Chat.tsx 内部函数，非导出）；i18n key `chat.thinking`。

- [ ] **Step 1: 写失败测试**

在 `src/sidepanel/components/Chat.test.tsx` 末尾新增。该文件的基建是 `makeSession(overrides?: Partial<UseSession>)`（line ~109）+ 直接 `render(<Chat session={...} onOpenSettings={() => {}} providerLabel={null} />)`——streaming 状态全由 session prop 直推，无需 port 注入。en locale 无需 I18nProvider（useT 回退英文，见文件内 greeting 用例注释）：

```tsx
describe("WorkingIndicator Pie face", () => {
  it("thinking 流期间显示 THINKING + thinking 态脸", async () => {
    render(
      <Chat
        session={makeSession({
          streaming: true,
          streamingThinking: "hmm",
          streamingText: "",
        })}
        onOpenSettings={() => {}}
        providerLabel={null}
      />,
    );
    expect(await screen.findByText("THINKING")).toBeTruthy();
    expect(document.querySelector('[data-pie-state="thinking"]')).toBeTruthy();
  });

  it("正文流出后切换 WORKING + working 态脸", async () => {
    render(
      <Chat
        session={makeSession({
          streaming: true,
          streamingThinking: "",
          streamingText: "Hello",
        })}
        onOpenSettings={() => {}}
        providerLabel={null}
      />,
    );
    expect(await screen.findByText("WORKING")).toBeTruthy();
    expect(document.querySelector('[data-pie-state="working"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test Chat.test`
Expected: 新增用例 FAIL（`chat.thinking` 不存在 / data-pie-state 无匹配）

- [ ] **Step 3: 全部 6 本字典加 key**

`en.ts`（`working: "WORKING",` 之后）：

```ts
    thinking: "THINKING",
```

同位置：`zh-CN.ts` `thinking: "思考中",`；`zh-TW.ts` `thinking: "思考中",`；`ja.ts` `thinking: "思考中",`；`es-419.ts` `thinking: "PENSANDO",`；`pt-BR.ts` `thinking: "PENSANDO",`。

- [ ] **Step 4: 升级 WorkingIndicator**

`src/sidepanel/components/Chat.tsx`：顶部 import 区加 `import PieFace from "./PieFace";`。替换 `WorkingIndicator` 函数（原 line 2025-2041）：

```tsx
function WorkingIndicator({ thinking }: { thinking: boolean }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("chat.agentWorking")}
      className="flex items-center gap-2 px-1 py-0.5"
    >
      <PieFace state={thinking ? "thinking" : "working"} size={22} />
      <span className="caps text-fg-3">
        {thinking ? t("chat.thinking") : t("chat.working")}
      </span>
    </div>
  );
}
```

调用点（原 line 1386）改为：

```tsx
{streaming && panelRequest?.kind !== "schedule-model" && (
  <WorkingIndicator thinking={!!streamingThinking && !streamingText} />
)}
```

- [ ] **Step 5: 跑测试确认通过（含 i18n parity 套件）**

Run: `pnpm test Chat.test && pnpm test i18n`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/dictionaries src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat: streaming 指示行升级为 Pie 脸 — thinking/working 双态 + chat.thinking i18n"
```

---

### Task 4: EmptyState 大 IP（唤醒 → 待命，输入时聆听）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（`EmptyState` 函数，约 line 1734-1761；调用点约 line 1284）
- Test: `src/sidepanel/components/Chat.test.tsx`（扩展现有 "EmptyState centered greeting" describe）

**Interfaces:**
- Consumes: Task 1 的 `PieFace`（含 `onWakeEnd`）。
- Produces: `EmptyState({ listening }: { listening: boolean })`（Chat.tsx 内部函数）。

- [ ] **Step 1: 写失败测试**

在 Chat.test.tsx 现有 `describe("EmptyState centered greeting")` 内追加（同文件基建：`makeSession` + 直接 render；`fireEvent`/`screen`/`waitFor` 已 import）：

```tsx
it("空态挂载播 wake，onAnimationEnd 后转 idle", async () => {
  render(
    <Chat session={makeSession()} onOpenSettings={() => {}} providerLabel={null} />,
  );
  await waitFor(() => {
    expect(document.querySelector('[data-pie-state="wake"]')).toBeTruthy();
  });
  const wake = document.querySelector('[data-pie-state="wake"]')!;
  fireEvent.animationEnd(wake, { animationName: "pie-wake-in" });
  expect(document.querySelector('[data-pie-state="idle"]')).toBeTruthy();
});

it("composer 输入非空时切 listening，清空后回 idle（不重播 wake）", async () => {
  render(
    <Chat session={makeSession()} onOpenSettings={() => {}} providerLabel={null} />,
  );
  // composer 的 textarea 是页面唯一 textbox（附件 input 非 textbox role）
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: "hi" } });
  expect(document.querySelector('[data-pie-state="listening"]')).toBeTruthy();
  fireEvent.change(textarea, { target: { value: "" } });
  expect(document.querySelector('[data-pie-state="idle"]')).toBeTruthy();
});
```

（第二个用例同时覆盖「输入即视为已唤醒」：清空后必须是 idle 而非 wake。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test Chat.test`
Expected: 新增两用例 FAIL

- [ ] **Step 3: 改 EmptyState**

替换 `EmptyState` 函数（原 line 1734-1761）——`useState`/`useEffect` 已在 Chat.tsx 顶部 import：

```tsx
function EmptyState({ listening }: { listening: boolean }) {
  const t = useT();
  // wake 是单次开场 morph；播完（或用户直接开始输入）即视为已唤醒。
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (listening) setAwake(true);
  }, [listening]);
  const greetingKey = useMemo(() => {
    const keys = [
      "greeting1",
      "greeting2",
      "greeting3",
      "greeting4",
      "greeting5",
      "greeting6",
      "greeting7",
    ] as const;
    return keys[Math.floor(Math.random() * keys.length)];
  }, []);
  const greeting = t(`chat.${greetingKey}`);
  const face = listening ? "listening" : awake ? "idle" : "wake";
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex max-w-[280px] flex-col items-center gap-3">
        <div className="mb-2">
          <PieFace state={face} size={140} onWakeEnd={() => setAwake(true)} />
        </div>
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.015em] text-fg-1">
          {greeting}
        </h1>
        <p className="text-[13px] leading-5 text-fg-2">
          {t("chat.readyDescription")}
        </p>
      </div>
    </div>
  );
}
```

调用点（原 line 1284）改为：

```tsx
<EmptyState listening={input.length > 0} />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test Chat.test`
Expected: PASS（含原 greeting 用例不回归）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat: 空态大 Pie IP — 唤醒 morph → 待命呼吸，输入时聆听"
```

---

### Task 5: 历史消息头静止脸（MessageBubble + AgentSummary）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（`MessageBubble` assistant 分支头部，约 line 1966-1971；props 约 line 1778-1790）
- Modify: `src/sidepanel/components/AgentSummary.tsx`
- Test: `src/sidepanel/components/AgentSummary.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `PieFace`。
- Produces: `MessageBubble` 新增可选 prop `celebrating?: boolean`（默认 false）；`AgentSummaryProps` 新增 `celebrating?: boolean`（默认 false）。Task 6 传值。

- [ ] **Step 1: 写失败测试**

`src/sidepanel/components/AgentSummary.test.tsx`（新建；AgentSummary 用 `useT`，沿用仓库其他组件测试对 i18n 的处理方式——en 默认无需 Provider，参照 Chat.test.tsx greeting 用例）：

```tsx
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AgentSummary from "./AgentSummary";

afterEach(() => {
  cleanup();
});

describe("AgentSummary Pie face", () => {
  it("默认渲染静止脸（无动画）", () => {
    const { container } = render(
      <AgentSummary success={true} summary="done" stepCount={2} />,
    );
    expect(container.querySelector('[data-pie-state="static"]')).toBeTruthy();
    expect(container.innerHTML).not.toContain("pie-hop");
  });

  it("celebrating + success → success 态脸", () => {
    const { container } = render(
      <AgentSummary success={true} summary="done" stepCount={2} celebrating />,
    );
    expect(container.querySelector('[data-pie-state="success"]')).toBeTruthy();
  });

  it("celebrating 但 success=false → 仍静止（失败不庆祝），warning 文字保留", () => {
    const { container } = render(
      <AgentSummary success={false} summary="failed" stepCount={2} celebrating />,
    );
    expect(container.querySelector('[data-pie-state="static"]')).toBeTruthy();
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test AgentSummary`
Expected: FAIL（无 data-pie-state 元素）

- [ ] **Step 3: 改 AgentSummary.tsx**

完整替换文件内容：

```tsx
import { useT } from "@/lib/i18n";
import MarkdownContent from "./Markdown";
import PieFace from "./PieFace";

interface AgentSummaryProps {
  success: boolean;
  summary: string;
  stepCount: number;
  /** Pie IP 完成庆祝（仅 success 时生效）；由 Chat 只对最后一行传 true。 */
  celebrating?: boolean;
}

export default function AgentSummary({
  success,
  summary,
  stepCount,
  celebrating = false,
}: AgentSummaryProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2.5 pt-2">
      <div className="flex items-center gap-2">
        <PieFace
          state={celebrating && success ? "success" : "static"}
          size={16}
        />
        <span
          className={`caps ${success ? "text-fg-2" : "text-warning"}`}
        >
          {success
            ? t("agentSummary.doneSteps", { count: stepCount })
            : t("agentSummary.failedAtStep", { step: stepCount })}
        </span>
      </div>
      <div className="text-[13px] leading-5 text-fg-1">
        <MarkdownContent content={summary} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 改 MessageBubble assistant 头**

`src/sidepanel/components/Chat.tsx`：`MessageBubble` 的 props 解构与类型（原 line 1778-1790 附近）加 `celebrating`：

```tsx
function MessageBubble({
  message,
  thinkingStreaming = false,
  streaming = false,
  celebrating = false,
  onRewind,
}: {
  message: Extract<DisplayMessage, { role: "user" | "assistant" }>;
  thinkingStreaming?: boolean;
  streaming?: boolean;
  /** Pie IP 完成庆祝 —— Chat 只对最后一条 agent 行传 true。 */
  celebrating?: boolean;
  onRewind?: (editedContent?: string) => void;
}) {
```

assistant 分支头部（原 line 1966-1971）替换：

```tsx
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <PieFace state={celebrating ? "success" : "static"} size={16} />
        <span className="caps text-fg-2">{t("chat.agent")}</span>
      </div>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test AgentSummary && pnpm test Chat.test`
Expected: PASS（Chat.test 既有 assistant 渲染用例不回归）

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/AgentSummary.tsx src/sidepanel/components/AgentSummary.test.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat: assistant/summary 消息头圆点换 Pie 静止脸，预留 celebrating"
```

---

### Task 6: Chat 完成态接线（useCelebrate → 最后一行）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（组件顶部 state 区 + segments map，约 line 1291-1338）
- Test: `src/sidepanel/components/Chat.test.tsx`（新增 describe）

**Interfaces:**
- Consumes: Task 2 `useCelebrate`、Task 5 的 `celebrating` props。
- Produces: 无新接口（纯接线）。

- [ ] **Step 1: 写失败测试**

Chat.test.tsx 新增。streaming true→false 边沿用同一实例 `rerender` 驱动（模拟 agent-done-task 落库后的 props 变化）；fake timers 只包本用例：

```tsx
describe("celebrate on completion", () => {
  it("任务成功收尾后最后一行播 success，2.5s 后归静止", () => {
    vi.useFakeTimers();
    try {
      const doneMessages: DisplayMessage[] = [
        { role: "user", content: "do it" },
        { role: "assistant", content: "first reply" },
        { role: "agent-summary", success: true, summary: "done", stepCount: 2 },
      ];
      const { rerender } = render(
        <Chat
          session={makeSession({
            streaming: true,
            messages: [{ role: "user", content: "do it" }],
          })}
          onOpenSettings={() => {}}
          providerLabel={null}
        />,
      );
      rerender(
        <Chat
          session={makeSession({ streaming: false, messages: doneMessages })}
          onOpenSettings={() => {}}
          providerLabel={null}
        />,
      );
      // 只有最后一行（agent-summary）庆祝；上面的 assistant 行保持 static
      expect(
        document.querySelectorAll('[data-pie-state="success"]').length,
      ).toBe(1);
      expect(
        document.querySelectorAll('[data-pie-state="static"]').length,
      ).toBeGreaterThan(0);
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(document.querySelector('[data-pie-state="success"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test Chat.test`
Expected: 新用例 FAIL（无 success 脸）

- [ ] **Step 3: 接线**

`src/sidepanel/components/Chat.tsx`：

1. import 区加：`import { useCelebrate } from "@/sidepanel/hooks/useCelebrate";`
2. 组件内（`streaming` / `messages` / `error` / `sessionId` 已从 useSession 解构可得；若 `error`/`sessionId` 未解构，补上）加：

```tsx
// Pie IP — 完成庆祝只落在最后一条 agent 行（assistant 或 agent-summary）。
const celebrating = useCelebrate({ streaming, error, messages, sessionId });
const lastAgentRowIndex = (() => {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (
      seg.kind === "msg" &&
      (seg.msg.role === "assistant" || seg.msg.role === "agent-summary")
    )
      return i;
  }
  return -1;
})();
```

（放在 `segments` 计算之后。）

3. segments map（原 line 1291）改带 index：`segments.map((seg, segIndex) => {`
4. assistant 分支的 `<MessageBubble>` 加 prop：

```tsx
<MessageBubble
  message={msg}
  celebrating={celebrating && segIndex === lastAgentRowIndex}
  {...(msg.role === "user" && !streaming
    ? { onRewind: (editedContent?: string) => handleRewind(rewindMsg, editedContent) }
    : {})}
/>
```

5. agent-summary 分支的 `<AgentSummary>` 加 prop：

```tsx
<AgentSummary
  success={msg.success}
  summary={msg.summary}
  stepCount={msg.stepCount}
  celebrating={celebrating && segIndex === lastAgentRowIndex}
/>
```

6. 流式气泡（原 line 1372-1376 `{streaming && (streamingText || streamingThinking) && ...}`）**不**传 celebrating——streaming 期间永不庆祝，其头部为静止脸（Task 5 默认值已保证）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test Chat.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat: 任务成功收尾时最后一行 Pie 脸播 success 2.5s"
```

---

### Task 7: 全量验证

**Files:** 无新改动（只跑门禁；发现回归就地修）。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（含 i18n parity、Chat 既有套件）

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 0 错（CLAUDE.md：任何新报错都是真实回归，必须修）

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 成功（build-time invariants 通过）

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A && git commit -m "fix: ip-animate 门禁回归修复"
```

（无修复则跳过。）

---

## 真机回归清单（merge 前人工）

1. 新会话打开 side panel → 大 IP 播唤醒 morph（双眼从缺口滑入）→ 转呼吸+眨眼
2. composer 输入文字 → 大 IP 睁大眼 + 双圈声波；清空 → 回呼吸（不重播唤醒）
3. 发任务：thinking 模型（如 deepseek-reasoner / claude thinking）思考期间底部指示行显示思考三点 + THINKING
4. 正文流出 / 工具调用期间 → 底部指示行眯眼震动 + 扫描环 + WORKING
5. 任务成功结束 → 最后一行（summary 或回复）头部弯月眼弹跳 + 光环 ~2.5s → 归静止；同屏其余脸全静止
6. 点停止（abort）→ 不播庆祝
7. 历史会话恢复 → 所有消息头静止脸，不重播庆祝
8. light / dark 两主题下脸均为深框白饼（不反转），accent 环两主题颜色正确
9. 系统开启「减弱动态效果」→ 全部脸静止（不崩、不闪）
