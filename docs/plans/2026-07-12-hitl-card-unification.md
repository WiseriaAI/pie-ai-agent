# HITL 卡片体系统一 + 本地打通设置区精修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 五张 HITL 卡（cdp-consent / local-file / run-local-agent / handoff-to-agent / skill-grant）迁入消息流内联并统一到共享卡骨架（双色语义分档），设置「本地打通」收敛为已启用列表 + 卡内管理子视图（品牌图标），grants 控制迁入 skill 列表行。

**Architecture:** 纯 panel 渲染层工程 + 一个 wire 加法字段。新增 `HitlCardShell`（中性卡 + caps 头 + 双 register 强调色）与 `AgentBrandIcon`（id 前缀键控 inline SVG），五卡改造为 shell 填充；Chat.tsx 尾部经新组件 `HitlInlineCards` 统一渲染全部 panel-request kind（含既有 schedule-model），固定槽位 HITL 分支删除。`hitl-panel-request` 原语（SW 挂起→卡裁决→resolve）零改动。

**Tech Stack:** React 19 + TypeScript、TailwindCSS v4（house token 类）、motion 原语（`ui/motion` 的 m/AnimatePresence/DURATION/EASE_STANDARD）、vitest + happy-dom + @testing-library/react、daemon 侧 bun test。

**权威 spec:** `docs/specs/2026-07-12-hitl-card-unification.md`（决策表 §2、组件设计 §4、参考代码附录 A0–A8）。

## Global Constraints

- 一律用 token 类（`bg-surface` / `border-line` / `text-fg-1/2/3` / `text-warning` / `text-accent` / `bg-warning-tint` / `border-warning-line` / `bg-accent-tint` / `border-accent-line` / `bg-surface-deep` / `bg-field` / `bg-success` / `rounded-control`(10px) / `rounded-chip`(6px) / `.caps`），**禁止**硬编码主题 hex（唯一例外：Claude brand 色 `#D97757` 与 `var(--c-fg-4)`，见 spec A0）
- 双色语义分档：`local` register（skill-grant / run-local-agent / handoff）强调色 = warning；`browser` register（local-file / cdp-consent）强调色 = accent；主按钮是整卡唯一浓色块
- 卡头**不显示**内部工具名（`run_skill_script` 等字符串不得出现在卡 UI）
- 主/次按钮尺寸对齐 ScheduleDraftCard 代码事实标准：`rounded-lg px-4 py-2 text-[13px]`，主 `font-semibold`、次 `font-medium`
- i18n 六字典 parity（en / zh-CN / zh-TW / ja / es-419 / pt-BR，`src/lib/i18n/dictionaries/`），每个改 key 的 task 必须六份一起改，否则 `pnpm typecheck` 红
- wire 只做加法：`ListAgentsResult.agents[]` 补 `kind?: "app" | "terminal"`；PROTOCOL_VERSION=1 不动；旧 daemon 缺 kind 时 panel 回退整串 label 单行
- 决议瞬态不留痕：无新 message role、无持久化改动
- 每个 task 结束跑该 task 的测试文件；Task 9 末尾跑全量 `pnpm test` / `pnpm typecheck` / `pnpm build` + daemon `cd daemon && bun test`
- Commit message 末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: HitlCardShell 骨架原语 + hitl.caps.* i18n keys

**Files:**
- Create: `src/sidepanel/components/hitl/HitlCardShell.tsx`
- Test: `src/sidepanel/components/hitl/HitlCardShell.test.tsx`
- Modify: `src/lib/i18n/dictionaries/en.ts`、`zh-CN.ts`、`zh-TW.ts`、`ja.ts`、`es-419.ts`、`pt-BR.ts`（各加顶层 `hitl` 段）

**Interfaces:**
- Consumes: `m, DURATION, EASE_STANDARD` from `../ui/motion`
- Produces（Task 3/4/5/6 依赖，签名逐字）:
  - `export type HitlRegister = "local" | "browser"`
  - `export interface HitlCardShellProps { register: HitlRegister; icon: ReactNode; capsLabel: string; title: string; description?: string; children?: ReactNode; actions: ReactNode }`
  - `export function HitlCardShell(props: HitlCardShellProps): JSX.Element`
  - `export function HitlPrimaryButton({ register, ...rest }: { register: HitlRegister } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element`
  - `export function HitlSecondaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element`
  - `export function HitlDetailBlock({ children }: { children: ReactNode }): JSX.Element`
  - `export function HitlDetailGroup({ label, children }: { label: string; children: ReactNode }): JSX.Element`
  - i18n keys：`hitl.caps.skillGrant` / `.runLocalAgent` / `.handoff` / `.localFile` / `.cdp`

- [ ] **Step 1: Write the failing test**

```tsx
// src/sidepanel/components/hitl/HitlCardShell.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./HitlCardShell";

afterEach(() => cleanup());

function renderShell(register: "local" | "browser") {
  return render(
    <HitlCardShell
      register={register}
      icon={<svg data-testid="hitl-icon" />}
      capsLabel="CAPS LABEL"
      title="Card title"
      description="Card description"
      actions={
        <>
          <HitlSecondaryButton onClick={() => {}}>No</HitlSecondaryButton>
          <HitlPrimaryButton register={register} onClick={() => {}}>Yes</HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label="Group label">
          <span>group value</span>
        </HitlDetailGroup>
      </HitlDetailBlock>
    </HitlCardShell>,
  );
}

describe("HitlCardShell", () => {
  it("renders caps label, title, description, children and actions", () => {
    renderShell("local");
    expect(screen.getByText("CAPS LABEL")).toBeTruthy();
    expect(screen.getByText("Card title")).toBeTruthy();
    expect(screen.getByText("Card description")).toBeTruthy();
    expect(screen.getByText("Group label")).toBeTruthy();
    expect(screen.getByText("group value")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("local register → warning caps + warning primary; browser → accent", () => {
    const { unmount } = renderShell("local");
    expect(screen.getByText("CAPS LABEL").className).toContain("text-warning");
    expect(screen.getByText("Yes").className).toContain("bg-warning");
    unmount();
    renderShell("browser");
    expect(screen.getByText("CAPS LABEL").className).toContain("text-accent");
    expect(screen.getByText("Yes").className).toContain("bg-accent-strong");
  });

  it("neutral card surface — the shell root has no warning tint/border", () => {
    const { container } = renderShell("local");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("bg-surface");
    expect(root.className).toContain("border-line");
    expect(root.className).not.toContain("bg-warning-tint");
  });

  it("buttons fire onClick", () => {
    const onYes = vi.fn();
    render(
      <HitlCardShell
        register="browser"
        icon={<svg />}
        capsLabel="L"
        title="T"
        actions={<HitlPrimaryButton register="browser" onClick={onYes}>Go</HitlPrimaryButton>}
      />,
    );
    fireEvent.click(screen.getByText("Go"));
    expect(onYes).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/sidepanel/components/hitl/HitlCardShell.test.tsx`
Expected: FAIL — `Cannot find module './HitlCardShell'`

- [ ] **Step 3: Write the implementation**

```tsx
// src/sidepanel/components/hitl/HitlCardShell.tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/sidepanel/components/hitl/HitlCardShell.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Add `hitl.caps.*` keys to all six dictionaries**

在每份字典顶层（与 `cdpOnboarding` 同级，建议插在 `cdpOnboarding` 之前）加 `hitl` 段。`.caps` CSS 自带 uppercase，值写正常大小写即可：

```ts
// en.ts
hitl: {
  caps: {
    skillGrant: "Skill authorization",
    runLocalAgent: "Local agent",
    handoff: "Hand-off",
    localFile: "Local file",
    cdp: "Input simulation",
  },
},
// zh-CN.ts
hitl: {
  caps: { skillGrant: "SKILL 授权", runLocalAgent: "本地 AGENT", handoff: "交棒授权", localFile: "本地文件", cdp: "输入模拟" },
},
// zh-TW.ts
hitl: {
  caps: { skillGrant: "SKILL 授權", runLocalAgent: "本地 AGENT", handoff: "交棒授權", localFile: "本機檔案", cdp: "輸入模擬" },
},
// ja.ts
hitl: {
  caps: { skillGrant: "スキル承認", runLocalAgent: "ローカルエージェント", handoff: "ハンドオフ", localFile: "ローカルファイル", cdp: "入力シミュレーション" },
},
// es-419.ts
hitl: {
  caps: { skillGrant: "Autorización de skill", runLocalAgent: "Agente local", handoff: "Traspaso", localFile: "Archivo local", cdp: "Simulación de entrada" },
},
// pt-BR.ts
hitl: {
  caps: { skillGrant: "Autorização de skill", runLocalAgent: "Agente local", handoff: "Transferência", localFile: "Arquivo local", cdp: "Simulação de entrada" },
},
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: 0 errors（六字典 parity 满足）

```bash
git add src/sidepanel/components/hitl/ src/lib/i18n/dictionaries/
git commit -m "feat(panel): HitlCardShell 骨架原语 + 双 register 强调 + hitl.caps i18n（#270 Task 1）"
```

---

### Task 2: AgentBrandIcon 品牌图标映射

**Files:**
- Create: `src/sidepanel/components/hitl/agent-brand-icons.tsx`
- Test: `src/sidepanel/components/hitl/agent-brand-icons.test.tsx`

**Interfaces:**
- Produces（Task 4/8 依赖）: `export function AgentBrandIcon({ agentId, size }: { agentId: string; size?: number }): JSX.Element`
- 键控规则：`agentId.startsWith("claude")` → Claude 星芒（stroke 固定 brand 色 `#D97757`）；`startsWith("codex")` → Codex 六边形（`currentColor`）；其余 → 通用终端图标（`currentColor`）。与 daemon `AGENT_CANDIDATES` id（`claude-app` / `claude-terminal` / `codex-terminal`）前缀对齐，#269 新增 agent 时按前缀扩展。

- [ ] **Step 1: Write the failing test**

```tsx
// src/sidepanel/components/hitl/agent-brand-icons.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AgentBrandIcon } from "./agent-brand-icons";

afterEach(() => cleanup());

function svgOf(agentId: string): SVGSVGElement {
  const { container } = render(<AgentBrandIcon agentId={agentId} />);
  return container.querySelector("svg") as SVGSVGElement;
}

describe("AgentBrandIcon", () => {
  it("claude-* → Claude mark with brand stroke", () => {
    for (const id of ["claude-app", "claude-terminal"]) {
      const svg = svgOf(id);
      expect(svg.getAttribute("data-brand")).toBe("claude");
      expect(svg.getAttribute("stroke")).toBe("#D97757");
    }
  });

  it("codex-* → Codex mark with currentColor stroke", () => {
    const svg = svgOf("codex-terminal");
    expect(svg.getAttribute("data-brand")).toBe("codex");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it("unknown id → generic terminal fallback", () => {
    const svg = svgOf("hermes-terminal");
    expect(svg.getAttribute("data-brand")).toBe("generic");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it("size prop controls width/height (default 14)", () => {
    expect(svgOf("claude-app").getAttribute("width")).toBe("14");
    const { container } = render(<AgentBrandIcon agentId="claude-app" size={16} />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("16");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/sidepanel/components/hitl/agent-brand-icons.test.tsx`
Expected: FAIL — `Cannot find module './agent-brand-icons'`

- [ ] **Step 3: Write the implementation**

```tsx
// src/sidepanel/components/hitl/agent-brand-icons.tsx

/**
 * 本地 Agent 品牌图标（#270）：inline SVG（MV3 CSP 禁外链），按 daemon
 * AGENT_CANDIDATES id 前缀键控。Claude 用 brand 色（不随主题翻转，故硬编码）；
 * Codex/通用随 currentColor。path 为 simplified 近似 mark；如替换为官方
 * simplified 资产，保持单 path、viewBox 24 与 data-brand 标注不变。
 */
export function AgentBrandIcon({ agentId, size = 14 }: { agentId: string; size?: number }) {
  if (agentId.startsWith("claude")) {
    return (
      <svg
        data-brand="claude"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#D97757"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M12 3v18" />
        <path d="M3 12h18" />
        <path d="M5.6 5.6l12.8 12.8" />
        <path d="M18.4 5.6L5.6 18.4" />
      </svg>
    );
  }
  if (agentId.startsWith("codex")) {
    return (
      <svg
        data-brand="codex"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z" />
        <path d="M12 7.2l4.1 2.4v4.8L12 16.8l-4.1-2.4V9.6L12 7.2z" />
      </svg>
    );
  }
  return (
    <svg
      data-brand="generic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/sidepanel/components/hitl/agent-brand-icons.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/hitl/agent-brand-icons.tsx src/sidepanel/components/hitl/agent-brand-icons.test.tsx
git commit -m "feat(panel): AgentBrandIcon 品牌图标（claude/codex 前缀键控 + 通用回退）（#270 Task 2）"
```

---

### Task 3: SkillGrantCard + RunLocalAgentCard 迁 shell（warning 档）

**Files:**
- Modify: `src/sidepanel/components/SkillGrantCard.tsx`（整文件重写）
- Modify: `src/sidepanel/components/RunLocalAgentCard.tsx`（整文件重写）
- Modify: `src/sidepanel/components/SkillGrantCard.test.tsx`、`RunLocalAgentCard.test.tsx`
- Modify: 六字典——`skillGrant.title`（改 `{name}` 模板）、`skillGrant.allow`、`runLocalAgent.allow`

**Interfaces:**
- Consumes: Task 1 全部导出；`SkillGrantRequest` from `@/lib/agent/tools/skill-script`（不动）
- Produces: 组件对外 props 签名**不变**（`SkillGrantCard({ payload, onDecision })` / `RunLocalAgentCard({ payload, onDecision })`）——Task 6 直接复用

- [ ] **Step 1: 更新六字典 key**

```ts
// en.ts   skillGrant 段：
title: "{name} asks to run scripts on your computer",
allow: "Allow & run",
//      runLocalAgent 段：
allow: "Allow & run",

// zh-CN.ts skillGrant: title: "{name} 请求在你的电脑上运行脚本", allow: "允许运行"
//          runLocalAgent: allow: "允许运行"
// zh-TW.ts skillGrant: title: "{name} 請求在你的電腦上執行腳本", allow: "允許執行"
//          runLocalAgent: allow: "允許執行"
// ja.ts    skillGrant: title: "{name} がスクリプトの実行を求めています", allow: "許可して実行"
//          runLocalAgent: allow: "許可して実行"
// es-419.ts skillGrant: title: "{name} solicita ejecutar scripts en tu computadora", allow: "Permitir y ejecutar"
//           runLocalAgent: allow: "Permitir y ejecutar"
// pt-BR.ts skillGrant: title: "{name} solicita executar scripts no seu computador", allow: "Permitir e executar"
//          runLocalAgent: allow: "Permitir e executar"
```

其余 key（scriptsLabel / networkLabel / networkNone / writeLabel / disclosure / deny、runLocalAgent.semanticsNote / cwdLabel / taskLabel / deny）**不动**。

- [ ] **Step 2: Write the failing tests**

`SkillGrantCard.test.tsx` 整文件替换：

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SkillGrantCard } from "./SkillGrantCard";

afterEach(() => cleanup());

const PAYLOAD = {
  skillName: "fetch-report",
  description: "Fetches the weekly report",
  scripts: ["fetch.ts", "clean.ts"],
  network: ["api.example.com"],
  write: [],
};

describe("SkillGrantCard", () => {
  it("renders name-in-title, description, scripts and declared domains", () => {
    render(<SkillGrantCard payload={PAYLOAD} onDecision={() => {}} />);
    // title 模板 "{name} asks to run scripts on your computer"
    expect(screen.getByText(/fetch-report asks to run scripts/)).toBeTruthy();
    expect(screen.getByText("Fetches the weekly report")).toBeTruthy();
    expect(screen.getByText("fetch.ts")).toBeTruthy();
    expect(screen.getByText("api.example.com")).toBeTruthy();
  });

  it("shows displayName in the title when present", () => {
    render(
      <SkillGrantCard payload={{ ...PAYLOAD, displayName: "周报抓取" }} onDecision={() => {}} />,
    );
    expect(screen.getByText(/周报抓取 asks to run scripts/)).toBeTruthy();
    expect(screen.queryByText(/fetch-report asks/)).toBeFalsy();
  });

  it("empty network shows the sandbox-blocked line; empty write hides the write block", () => {
    render(<SkillGrantCard payload={{ ...PAYLOAD, network: [] }} onDecision={() => {}} />);
    expect(screen.getByText("None — network is blocked by the default sandbox")).toBeTruthy();
    expect(screen.queryByText("Extra write locations (outside its workspace)")).toBeFalsy();
  });

  it("non-empty write shows the write block", () => {
    render(<SkillGrantCard payload={{ ...PAYLOAD, write: ["/tmp/out"] }} onDecision={() => {}} />);
    expect(screen.getByText("Extra write locations (outside its workspace)")).toBeTruthy();
    expect(screen.getByText("/tmp/out")).toBeTruthy();
  });

  it("allow → onDecision(true), deny → onDecision(false)", () => {
    const onDecision = vi.fn();
    render(<SkillGrantCard payload={PAYLOAD} onDecision={onDecision} />);
    fireEvent.click(screen.getByText("Allow & run"));
    expect(onDecision).toHaveBeenCalledWith(true);
    onDecision.mockClear();
    fireEvent.click(screen.getByText("Deny"));
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("warning register: caps label styled text-warning; no tool name in the card", () => {
    const { container } = render(<SkillGrantCard payload={PAYLOAD} onDecision={() => {}} />);
    expect(screen.getByText("Skill authorization").className).toContain("text-warning");
    expect(container.textContent).not.toContain("run_skill_script");
  });
});
```

`RunLocalAgentCard.test.tsx`：把对 `"Allow"` 的断言改为 `"Allow & run"`，其余保留；追加一条 register 断言：

```tsx
it("warning register: caps label styled text-warning; no tool name in the card", () => {
  const { container } = render(
    <RunLocalAgentCard payload={{ prompt: "do x", cwd: "/tmp/w" }} onDecision={() => {}} />,
  );
  expect(screen.getByText("Local agent").className).toContain("text-warning");
  expect(container.textContent).not.toContain("run_local_agent");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/sidepanel/components/SkillGrantCard.test.tsx src/sidepanel/components/RunLocalAgentCard.test.tsx`
Expected: FAIL（旧卡无模板 title / 无 "Allow & run" / 无 caps 标签）

- [ ] **Step 4: Rewrite SkillGrantCard**

```tsx
// src/sidepanel/components/SkillGrantCard.tsx
import { useT } from "@/lib/i18n";
import type { SkillGrantRequest } from "@/lib/agent/tools/skill-script";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";

interface Props {
  payload: SkillGrantRequest;
  onDecision: (approved: boolean) => void;
}

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
  </svg>
);

/**
 * skill 信封授权卡（#270 迁 HitlCardShell，warning 档）：展示 daemon 权威的
 * 能力信封原文（脚本 + 域名 + 工作区外写路径），内容不经 LLM 转述。批准后
 * 该 skill 免卡直到信封变化。
 */
export function SkillGrantCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="local"
      icon={<ShieldIcon />}
      capsLabel={t("hitl.caps.skillGrant")}
      title={t("skillGrant.title", { name: payload.displayName ?? payload.skillName })}
      description={payload.description}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("skillGrant.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>
            {t("skillGrant.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("skillGrant.scriptsLabel")}>
          {payload.scripts.map((s) => (
            <span key={s} className="font-mono text-[12px] leading-[18px] text-fg-1">{s}</span>
          ))}
        </HitlDetailGroup>
        <HitlDetailGroup label={t("skillGrant.networkLabel")}>
          {payload.network.length > 0 ? (
            payload.network.map((d) => (
              <span key={d} className="font-mono text-[12px] leading-[18px] text-fg-1">{d}</span>
            ))
          ) : (
            <span className="text-[12px] leading-[18px] text-fg-3">{t("skillGrant.networkNone")}</span>
          )}
        </HitlDetailGroup>
        {payload.write.length > 0 && (
          <HitlDetailGroup label={t("skillGrant.writeLabel")}>
            {payload.write.map((w) => (
              <span key={w} className="font-mono text-[12px] leading-[18px] text-fg-1">{w}</span>
            ))}
          </HitlDetailGroup>
        )}
      </HitlDetailBlock>
      <div className="text-[11px] leading-[17px] text-fg-2">{t("skillGrant.disclosure")}</div>
    </HitlCardShell>
  );
}
```

注意：`skillGrant.title` 现在是 `{name}` 模板——确认 `useT` 的 t() 第二参插值签名与库内现有用法一致（参照 `skills.toggleAria.enable` 的 `{ name }` 用法）。

- [ ] **Step 5: Rewrite RunLocalAgentCard**

```tsx
// src/sidepanel/components/RunLocalAgentCard.tsx
import { useT } from "@/lib/i18n";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";

interface Props {
  payload: { prompt: string; cwd: string };
  onDecision: (ok: boolean) => void;
}

const TerminalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3" />
    <path d="M13 15h4" />
  </svg>
);

/**
 * run_local_agent 授权卡（#270 迁 HitlCardShell，warning 档）。prompt + cwd
 * 原文展示（不经转述）；与 handoff 卡的语义区分：结果会回到本对话。
 */
export function RunLocalAgentCard({ payload, onDecision }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="local"
      icon={<TerminalIcon />}
      capsLabel={t("hitl.caps.runLocalAgent")}
      title={t("runLocalAgent.title")}
      description={t("runLocalAgent.semanticsNote")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(false)}>
            {t("runLocalAgent.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(true)}>
            {t("runLocalAgent.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <HitlDetailBlock>
        <HitlDetailGroup label={t("runLocalAgent.cwdLabel")}>
          <span className="font-mono text-[12px] leading-[18px] text-fg-1 break-all">{payload.cwd}</span>
        </HitlDetailGroup>
        <HitlDetailGroup label={t("runLocalAgent.taskLabel")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-[18px] text-fg-1">
            {payload.prompt}
          </pre>
        </HitlDetailGroup>
      </HitlDetailBlock>
    </HitlCardShell>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/sidepanel/components/SkillGrantCard.test.tsx src/sidepanel/components/RunLocalAgentCard.test.tsx`
Expected: PASS

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` — Expected: 0 errors

```bash
git add src/sidepanel/components/SkillGrantCard.tsx src/sidepanel/components/RunLocalAgentCard.tsx src/sidepanel/components/SkillGrantCard.test.tsx src/sidepanel/components/RunLocalAgentCard.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): SkillGrant/RunLocalAgent 卡迁 HitlCardShell（warning 档 + title 模板）（#270 Task 3）"
```

---

### Task 4: HandoffCard 迁 shell（warning 档 + 品牌图标收件人）

**Files:**
- Modify: `src/sidepanel/components/HandoffCard.tsx`（整文件重写）
- Modify: `src/sidepanel/components/HandoffCard.test.tsx`
- Modify: 六字典——`handoff.targetLabel`

**Interfaces:**
- Consumes: Task 1 shell 导出 + Task 2 `AgentBrandIcon`
- Produces: props 签名不变（`HandoffCard({ payload, onDecision })`，`onDecision(target: string | null)`）

- [ ] **Step 1: 更新六字典 `handoff.targetLabel`**

en: `"Recipient"`；zh-CN: `"收件人"`；zh-TW: `"收件人"`；ja: `"宛先"`；es-419: `"Destinatario"`；pt-BR: `"Destinatário"`。

- [ ] **Step 2: Update the test**

在现有 `HandoffCard.test.tsx` 基础上：保留全部行为断言（预选第一项、切换选择、allow→onDecision(selected)、deny→onDecision(null)、context 原文渲染、fileCount 行）；对涉及 `"Local agent"` 标签的断言改为 `"Recipient"`；追加：

```tsx
it("recipient rows carry brand icons keyed by agent id", () => {
  render(<HandoffCard payload={PAYLOAD} onDecision={() => {}} />);
  expect(document.querySelector('svg[data-brand="claude"]')).toBeTruthy();
  expect(document.querySelector('svg[data-brand="codex"]')).toBeTruthy();
});

it("warning register: caps label text-warning; no tool name in the card", () => {
  const { container } = render(<HandoffCard payload={PAYLOAD} onDecision={() => {}} />);
  expect(screen.getByText("Hand-off").className).toContain("text-warning");
  expect(container.textContent).not.toContain("handoff_to_agent");
});
```

（`PAYLOAD.agents` 用 `[{ id: "claude-app", label: "Claude Code (App)" }, { id: "codex-terminal", label: "Codex (Terminal)" }]`，与现测试数据对齐；如现文件字段不同，以现文件为底只做上述增改。）

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/sidepanel/components/HandoffCard.test.tsx`
Expected: FAIL（无 data-brand svg / 无 Recipient / 无 caps 标签）

- [ ] **Step 4: Rewrite HandoffCard**

```tsx
// src/sidepanel/components/HandoffCard.tsx
import { useState } from "react";
import { useT } from "@/lib/i18n";
import {
  HitlCardShell,
  HitlPrimaryButton,
  HitlSecondaryButton,
  HitlDetailBlock,
  HitlDetailGroup,
} from "./hitl/HitlCardShell";
import { AgentBrandIcon } from "./hitl/agent-brand-icons";

interface AgentOption {
  id: string;
  label: string;
}
interface Props {
  payload: { context: string; fileCount: number; agents: AgentOption[] };
  onDecision: (target: string | null) => void;
}

const HandoffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    <path d="m15 4 5 5-5 5" />
  </svg>
);

/**
 * 交棒授权卡（#270 迁 HitlCardShell，warning 档）：用户在此选收件人（LLM 不能选
 * ——收件人选择与授权是同一步）。context 原文渲染，让用户看到将写入 context.md
 * 的内容。与 run_local_agent 卡的语义区分：任务移交出去，结果不回来。
 */
export function HandoffCard({ payload, onDecision }: Props) {
  const t = useT();
  const [selected, setSelected] = useState(payload.agents[0]?.id ?? "");
  return (
    <HitlCardShell
      register="local"
      icon={<HandoffIcon />}
      capsLabel={t("hitl.caps.handoff")}
      title={t("handoff.title")}
      description={t("handoff.semanticsNote")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onDecision(null)}>
            {t("handoff.deny")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="local" onClick={() => onDecision(selected)}>
            {t("handoff.allow")}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="caps text-fg-3">{t("handoff.targetLabel")}</span>
        {payload.agents.map((a) => {
          const isSel = a.id === selected;
          return (
            <label
              key={a.id}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 ${
                isSel ? "border-accent-line bg-accent-tint" : "border-line"
              }`}
            >
              <input
                type="radio"
                name="handoff-target"
                className="sr-only"
                checked={isSel}
                onChange={() => setSelected(a.id)}
              />
              <AgentBrandIcon agentId={a.id} size={16} />
              <span className={`text-[13px] ${isSel ? "text-fg-1" : "text-fg-2"}`}>{a.label}</span>
              <span
                aria-hidden
                className={`ml-auto h-3.5 w-3.5 shrink-0 rounded-full border ${
                  isSel ? "border-[4px] border-accent" : "border-[1.5px] border-[var(--c-fg-4)]"
                }`}
              />
            </label>
          );
        })}
      </div>
      <HitlDetailBlock>
        <HitlDetailGroup label={t("handoff.contextLabel")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-fg-2">
            {payload.context}
          </pre>
        </HitlDetailGroup>
        {payload.fileCount > 0 && (
          <span className="text-[11px] text-fg-3">
            {t("handoff.filesLabel")}: {payload.fileCount}
          </span>
        )}
      </HitlDetailBlock>
    </HitlCardShell>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/sidepanel/components/HandoffCard.test.tsx`
Expected: PASS

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/sidepanel/components/HandoffCard.tsx src/sidepanel/components/HandoffCard.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): HandoffCard 迁 HitlCardShell——品牌图标收件人 radio + Recipient 文案（#270 Task 4）"
```

---

### Task 5: LocalFileRequestCard + CdpOnboardingCard 迁 shell（accent 档）

**Files:**
- Modify: `src/sidepanel/components/LocalFileRequestCard.tsx`（整文件重写）
- Modify: `src/sidepanel/components/CdpOnboardingCard.tsx`（整文件重写）
- Create: `src/sidepanel/components/LocalFileRequestCard.test.tsx`（此前无测试）
- Modify: `src/sidepanel/components/CdpOnboardingCard.test.tsx`

**Interfaces:**
- Consumes: Task 1 shell 导出
- Produces: props 签名不变（`LocalFileRequestCard({ onChoose, onCancel })` / `CdpOnboardingCard({ onAnswer })`）
- i18n 零改动（复用 `chat.files.request*` 与 `cdpOnboarding.*` 现有 key）

- [ ] **Step 1: Write the failing tests**

```tsx
// src/sidepanel/components/LocalFileRequestCard.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocalFileRequestCard } from "./LocalFileRequestCard";

afterEach(() => cleanup());

describe("LocalFileRequestCard", () => {
  it("renders title/body; choose → onChoose, cancel → onCancel", () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    render(<LocalFileRequestCard onChoose={onChoose} onCancel={onCancel} />);
    expect(screen.getByText(/wants to read a local text or PDF file/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Choose file/));
    expect(onChoose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/Cancel/));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancel button shows a countdown suffix initially", () => {
    render(<LocalFileRequestCard onChoose={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Cancel \(\d+s\)/)).toBeTruthy();
  });

  it("browser register: caps label text-accent (not warning)", () => {
    render(<LocalFileRequestCard onChoose={() => {}} onCancel={() => {}} />);
    const caps = screen.getByText("Local file");
    expect(caps.className).toContain("text-accent");
    expect(caps.className).not.toContain("text-warning");
  });
});
```

`CdpOnboardingCard.test.tsx`：保留现有行为断言（enable→onAnswer(true)、decline→onAnswer(false)、title/body 渲染——若现文件断言的具体类名/结构失效则同步到新结构），追加：

```tsx
it("browser register: caps label text-accent; body2 rendered as fine-print note", () => {
  render(<CdpOnboardingCard onAnswer={() => {}} />);
  expect(screen.getByText("Input simulation").className).toContain("text-accent");
  expect(screen.getByText(/yellow bar/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sidepanel/components/LocalFileRequestCard.test.tsx src/sidepanel/components/CdpOnboardingCard.test.tsx`
Expected: FAIL（无 caps 标签 / 新断言不满足）

- [ ] **Step 3: Rewrite LocalFileRequestCard**

```tsx
// src/sidepanel/components/LocalFileRequestCard.tsx
import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n";
import { REQUEST_TIMEOUT_MS } from "@/lib/local-file-request";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./hitl/HitlCardShell";

interface Props {
  onChoose: () => void;
  onCancel: () => void;
}

const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
    <path d="M14 3v5h5" />
  </svg>
);

/**
 * request_local_file 卡（#270 迁 HitlCardShell，browser/accent 档）。
 * "选择文件"是打开 file picker 的用户手势（经 Chat.tsx 隐藏 input 路由）。
 */
export function LocalFileRequestCard({ onChoose, onCancel }: Props) {
  const t = useT();
  const [seconds, setSeconds] = useState(Math.round(REQUEST_TIMEOUT_MS / 1000));

  useEffect(() => {
    if (seconds <= 0) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        const next = s - 1;
        if (next <= 0) {
          clearInterval(id);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <HitlCardShell
      register="browser"
      icon={<FileIcon />}
      capsLabel={t("hitl.caps.localFile")}
      title={t("chat.files.requestTitle")}
      description={t("chat.files.requestBody")}
      actions={
        <>
          <HitlSecondaryButton onClick={onCancel}>
            {seconds > 0
              ? `${t("chat.files.requestCancel")} (${seconds}s)`
              : t("chat.files.requestCancel")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="browser" onClick={onChoose}>
            {t("chat.files.requestChoose")}…
          </HitlPrimaryButton>
        </>
      }
    />
  );
}
```

- [ ] **Step 4: Rewrite CdpOnboardingCard**

```tsx
// src/sidepanel/components/CdpOnboardingCard.tsx
import { useT } from "@/lib/i18n/use-t";
import { HitlCardShell, HitlPrimaryButton, HitlSecondaryButton } from "./hitl/HitlCardShell";

interface Props {
  onAnswer: (enabled: boolean) => void;
}

const CursorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 4l7 17 2.5-7L21 11 4 4z" />
  </svg>
);

/** CDP 输入模拟授权卡（#270 迁 HitlCardShell，browser/accent 档）。 */
export function CdpOnboardingCard({ onAnswer }: Props) {
  const t = useT();
  return (
    <HitlCardShell
      register="browser"
      icon={<CursorIcon />}
      capsLabel={t("hitl.caps.cdp")}
      title={t("cdpOnboarding.title")}
      description={t("cdpOnboarding.body1")}
      actions={
        <>
          <HitlSecondaryButton onClick={() => onAnswer(false)}>
            {t("cdpOnboarding.decline")}
          </HitlSecondaryButton>
          <HitlPrimaryButton register="browser" onClick={() => onAnswer(true)}>
            {t("cdpOnboarding.enable")}
          </HitlPrimaryButton>
        </>
      }
    >
      <div className="text-[11px] leading-[17px] text-fg-2">{t("cdpOnboarding.body2")}</div>
    </HitlCardShell>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/sidepanel/components/LocalFileRequestCard.test.tsx src/sidepanel/components/CdpOnboardingCard.test.tsx`
Expected: PASS

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/sidepanel/components/LocalFileRequestCard.tsx src/sidepanel/components/CdpOnboardingCard.tsx src/sidepanel/components/LocalFileRequestCard.test.tsx src/sidepanel/components/CdpOnboardingCard.test.tsx
git commit -m "feat(panel): LocalFile/CdpOnboarding 卡迁 HitlCardShell（accent 档）（#270 Task 5）"
```

---

### Task 6: HitlInlineCards + Chat.tsx 接线（内联迁移，删固定槽位）

**Files:**
- Create: `src/sidepanel/components/hitl/HitlInlineCards.tsx`
- Test: `src/sidepanel/components/hitl/HitlInlineCards.test.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`

**Interfaces:**
- Consumes: 五卡组件（Task 3/4/5 后签名不变）、`ScheduleDraftCard`、`ActivePanelRequest, PanelResponseBody` from `../../hooks/usePanelRequest`、`DecryptedInstance` from `@/lib/instances`
- Produces（Chat.tsx 消费）:
  - `export interface HitlInlineCardsProps { request: ActivePanelRequest | null; respond: (requestId: string, body: PanelResponseBody) => void; instances: DecryptedInstance[]; onChooseLocalFile: () => void }`
  - `export function HitlInlineCards(props: HitlInlineCardsProps): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
// src/sidepanel/components/hitl/HitlInlineCards.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HitlInlineCards } from "./HitlInlineCards";

afterEach(() => cleanup());

const base = { instances: [], onChooseLocalFile: vi.fn() };

describe("HitlInlineCards", () => {
  it("renders nothing when request is null", () => {
    const { container } = render(<HitlInlineCards request={null} respond={vi.fn()} {...base} />);
    expect(container.textContent).toBe("");
  });

  it("skill-grant kind renders SkillGrantCard and resolves via respond", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{
          requestId: "r1",
          kind: "skill-grant",
          payload: { skillName: "s1", description: "d", scripts: ["a.ts"], network: [], write: [] },
        }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Allow & run"));
    expect(respond).toHaveBeenCalledWith("r1", { ok: true, data: true });
  });

  it("run-local-agent kind resolves ok:true data:false on deny", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{ requestId: "r2", kind: "run-local-agent", payload: { prompt: "p", cwd: "/w" } }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Deny"));
    expect(respond).toHaveBeenCalledWith("r2", { ok: true, data: false });
  });

  it("handoff kind resolves with the picked agent id", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{
          requestId: "r3",
          kind: "handoff-to-agent",
          payload: { context: "ctx", fileCount: 0, agents: [{ id: "claude-app", label: "Claude Code (App)" }] },
        }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Hand off"));
    expect(respond).toHaveBeenCalledWith("r3", { ok: true, data: "claude-app" });
  });

  it("local-file kind: choose routes to onChooseLocalFile; cancel resolves ok:false", () => {
    const respond = vi.fn();
    const onChooseLocalFile = vi.fn();
    render(
      <HitlInlineCards
        request={{ requestId: "r4", kind: "local-file", payload: undefined }}
        respond={respond}
        instances={[]}
        onChooseLocalFile={onChooseLocalFile}
      />,
    );
    fireEvent.click(screen.getByText(/Choose file/));
    expect(onChooseLocalFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/Cancel/));
    expect(respond).toHaveBeenCalledWith("r4", { ok: false, reason: "cancelled by user" });
  });

  it("cdp-consent kind resolves ok:true data:true on enable", () => {
    const respond = vi.fn();
    render(
      <HitlInlineCards
        request={{ requestId: "r5", kind: "cdp-consent", payload: undefined }}
        respond={respond}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText("Enable"));
    expect(respond).toHaveBeenCalledWith("r5", { ok: true, data: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/sidepanel/components/hitl/HitlInlineCards.test.tsx`
Expected: FAIL — `Cannot find module './HitlInlineCards'`

- [ ] **Step 3: Write HitlInlineCards**

```tsx
// src/sidepanel/components/hitl/HitlInlineCards.tsx
import { AnimatePresence } from "../ui/motion";
import type { ActivePanelRequest, PanelResponseBody } from "../../hooks/usePanelRequest";
import type { DecryptedInstance } from "@/lib/instances";
import { ScheduleDraftCard } from "../ScheduleDraftCard";
import { SkillGrantCard } from "../SkillGrantCard";
import { RunLocalAgentCard } from "../RunLocalAgentCard";
import { HandoffCard } from "../HandoffCard";
import { LocalFileRequestCard } from "../LocalFileRequestCard";
import { CdpOnboardingCard } from "../CdpOnboardingCard";

export interface HitlInlineCardsProps {
  request: ActivePanelRequest | null;
  respond: (requestId: string, body: PanelResponseBody) => void;
  instances: DecryptedInstance[];
  /** local-file 卡的"选择文件"手势 → Chat.tsx 隐藏 input 的 click() */
  onChooseLocalFile: () => void;
}

/**
 * #270 — 全部 panel-request kind 的内联渲染点（消息流尾部，#184 范式）。
 * AnimatePresence 在此包裹，卡组件（m.div 根）unmount 时 exit 动画生效。
 * key=requestId：换请求时强制重挂载，内部 state（倒计时/选择）不串台。
 */
export function HitlInlineCards({ request, respond, instances, onChooseLocalFile }: HitlInlineCardsProps) {
  return (
    <AnimatePresence>
      {request?.kind === "schedule-model" && (
        <ScheduleDraftCard
          key={request.requestId}
          payload={request.payload as import("@/lib/agent/tools/schedule-meta").ScheduleDraftPayload}
          instances={instances}
          onSubmit={(instanceId, model) =>
            respond(request.requestId, { ok: true, data: { instanceId, model } })
          }
          onCancel={() => respond(request.requestId, { ok: false, reason: "cancelled by user" })}
        />
      )}
      {request?.kind === "skill-grant" && (
        <SkillGrantCard
          key={request.requestId}
          payload={request.payload as import("@/lib/agent/tools/skill-script").SkillGrantRequest}
          onDecision={(approved) => respond(request.requestId, { ok: true, data: approved })}
        />
      )}
      {request?.kind === "run-local-agent" && (
        <RunLocalAgentCard
          key={request.requestId}
          payload={request.payload as { prompt: string; cwd: string }}
          onDecision={(ok) => respond(request.requestId, { ok: true, data: ok })}
        />
      )}
      {request?.kind === "handoff-to-agent" && (
        <HandoffCard
          key={request.requestId}
          payload={
            request.payload as {
              context: string;
              fileCount: number;
              agents: { id: string; label: string }[];
            }
          }
          onDecision={(target) => respond(request.requestId, { ok: true, data: target })}
        />
      )}
      {request?.kind === "local-file" && (
        <LocalFileRequestCard
          key={request.requestId}
          onChoose={onChooseLocalFile}
          onCancel={() => respond(request.requestId, { ok: false, reason: "cancelled by user" })}
        />
      )}
      {request?.kind === "cdp-consent" && (
        <CdpOnboardingCard
          key={request.requestId}
          onAnswer={(enabled) => respond(request.requestId, { ok: true, data: enabled })}
        />
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/sidepanel/components/hitl/HitlInlineCards.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Rewire Chat.tsx**

四处修改（行号以 Task 6 开工时为准，语义定位）：

1. **尾部渲染**（现 `{streaming && panelRequest?.kind !== "schedule-model" && <WorkingIndicator />}` 与其后 `<AnimatePresence>…schedule-model…</AnimatePresence>` 一段，约 L1387–1402）整体替换为：

```tsx
{streaming && !panelRequest && <WorkingIndicator />}
<HitlInlineCards
  request={panelRequest}
  respond={respondPanel}
  instances={instances}
  onChooseLocalFile={() => localFileRequestInputRef.current?.click()}
/>
```

2. **固定槽位**（约 L1638–1672，`panelRequest?.kind === "cdp-consent" | "local-file" | "run-local-agent" | "handoff-to-agent" | "skill-grant"` 五个分支）整体删除。**保留** `showFileAccess && <FileAccessCard …>` 与 `pendingRecording` chip。

3. **自动滚动**（约 L431–435）依赖数组加 panelRequest：

```tsx
useEffect(() => {
  if (!atBottomRef.current) return;
  const c = scrollContainerRef.current;
  if (c) c.scrollTop = c.scrollHeight;
}, [messages, streamingText, panelRequest?.requestId]);
```

4. **imports**：删除 Chat.tsx 中不再使用的 `CdpOnboardingCard` / `LocalFileRequestCard` / `RunLocalAgentCard` / `HandoffCard` / `SkillGrantCard` / `ScheduleDraftCard` import；若 `AnimatePresence` 在 Chat.tsx 其他处不再使用也一并移除（以 `pnpm typecheck` 的 unused 报错为准）；新增 `import { HitlInlineCards } from "./hitl/HitlInlineCards";`。

- [ ] **Step 6: Run full panel test suite + typecheck**

Run: `pnpm vitest run src/sidepanel && pnpm typecheck`
Expected: PASS / 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/hitl/HitlInlineCards.tsx src/sidepanel/components/hitl/HitlInlineCards.test.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat(panel): 五张 HITL 卡内联进消息流（HitlInlineCards），固定槽位分支删除（#270 Task 6）"
```

---

### Task 7: wire 加法 `ListAgentsResult.kind` + 透传链

**Files:**
- Modify: `src/types/local-bridge.ts:43-45`（ListAgentsResult）
- Modify: `daemon/src/daemon.ts:57-70`（list_agents case）
- Modify: `daemon/test/daemon.test.ts:105-120`（既有 shape 测试扩展）
- Modify: `src/background/local-bridge.ts:173`（requestListAgents 返回类型）
- Modify: `src/sidepanel/components/Settings.tsx:563`（PanelAgent 类型）

**Interfaces:**
- Produces（Task 8 依赖）: `PanelAgent = { id: string; label: string; installed: boolean; enabled: boolean; kind?: "app" | "terminal" }`
- 兼容不变量：`kind` optional；旧 daemon 缺字段 → panel 回退整串 `label` 单行显示（Task 8 落实）

- [ ] **Step 1: Extend the daemon test（先红）**

`daemon/test/daemon.test.ts` 的 `list_agents returns ALL candidates…` 测试 for 循环里追加一行：

```ts
for (const a of out.result.agents) {
  expect(typeof a.label).toBe("string");
  expect(typeof a.installed).toBe("boolean");
  expect(["app", "terminal"]).toContain(a.kind); // #270: wire 加法字段
}
```

Run: `cd daemon && bun test test/daemon.test.ts`
Expected: FAIL（`a.kind` undefined）

- [ ] **Step 2: Wire type + daemon implementation**

`src/types/local-bridge.ts`：

```ts
export interface ListAgentsResult {
  agents: { id: string; label: string; installed: boolean; kind?: "app" | "terminal" }[];
}
```

`daemon/src/daemon.ts` list_agents case：

```ts
const result: ListAgentsResult = {
  agents: AGENT_CANDIDATES.map(({ id, label, kind }) => ({
    id,
    label,
    kind,
    installed: detected.has(id),
  })),
};
```

Run: `cd daemon && bun test test/daemon.test.ts` — Expected: PASS

- [ ] **Step 3: SW + panel 类型透传**

`src/background/local-bridge.ts:173`：

```ts
export async function requestListAgents(): Promise<
  { id: string; label: string; installed: boolean; kind?: "app" | "terminal" }[]
> {
```

（`src/background/index.ts` 的 `local-agents:list` handler 用 `...a` spread，kind 自动透传，零改动。）

`src/sidepanel/components/Settings.tsx:563`：

```ts
type PanelAgent = {
  id: string;
  label: string;
  installed: boolean;
  enabled: boolean;
  kind?: "app" | "terminal";
};
```

- [ ] **Step 4: 全量 daemon 测试 + 扩展 typecheck**

Run: `cd daemon && bun test && cd .. && pnpm typecheck`
Expected: 全绿 / 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/types/local-bridge.ts daemon/src/daemon.ts daemon/test/daemon.test.ts src/background/local-bridge.ts src/sidepanel/components/Settings.tsx
git commit -m "feat(bridge): ListAgentsResult 加法补 kind 字段，daemon→SW→panel 透传（#270 Task 7）"
```

---

### Task 8: LocalBridgeSection 重构（已启用列表 + Agent 管理子视图，删 grants/audit）

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`（`LocalBridgeSection` 函数 + 顶部 `queryGrants`/`queryAudit` 删除；`GrantRecord, AuditEntry` import 删除）
- Modify: `src/sidepanel/components/Settings.localbridge.test.tsx`（整文件重写）
- Modify: 六字典——settings.localBridge 增删 key

**Interfaces:**
- Consumes: Task 2 `AgentBrandIcon`、Task 7 `PanelAgent.kind`、`Collapse` from `./ui/Collapse`（可选高度过渡）
- Produces: `LocalBridgeSection` 对外签名不变（无 props）
- Task 9 前置：本 task 删除 Settings 里的 grants UI；grants 的新家在 Task 9 落地（中间态没有 grants 入口，可接受——同一 PR 内合并）

- [ ] **Step 1: 更新六字典 settings.localBridge key**

新增：

```ts
// en.ts
agentsEnabledTitle: "Local agents · Enabled",
manageAgents: "Manage agents",
// zh-CN: agentsEnabledTitle: "本地 Agent · 已启用", manageAgents: "Agent 管理"
// zh-TW: agentsEnabledTitle: "本地 Agent · 已啟用", manageAgents: "Agent 管理"
// ja:    agentsEnabledTitle: "ローカルエージェント · 有効", manageAgents: "エージェント管理"
// es-419: agentsEnabledTitle: "Agentes locales · Habilitados", manageAgents: "Gestionar agentes"
// pt-BR: agentsEnabledTitle: "Agentes locais · Habilitados", manageAgents: "Gerenciar agentes"
```

删除（六份同删）：`agentsTitle`、`grantsTitle`、`revoke`、`auditTitle`、`auditOk`、`auditFailed`。保留：`agentNotInstalled`、`agentEnableFailed` 及其余。

- [ ] **Step 2: Rewrite the test（先红）**

`Settings.localbridge.test.tsx` 整文件替换（沿用文件头的 `mockSendMessage` helper 与 `chromeMock`，AGENTS fixture 含 kind）：

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocalBridgeSection } from "./Settings";
import { chromeMock } from "@/test/setup";

const AGENTS = [
  { id: "claude-app", label: "Claude Code (App)", installed: true, enabled: true, kind: "app" },
  { id: "claude-terminal", label: "Claude Code (Terminal)", installed: true, enabled: false, kind: "terminal" },
  { id: "codex-terminal", label: "Codex (Terminal)", installed: false, enabled: false, kind: "terminal" },
];

type Handler = (message: Record<string, unknown>) => unknown;

function mockSendMessage(handlers: Record<string, Handler>): string[] {
  const seen: string[] = [];
  chromeMock.runtime.sendMessage.mockImplementation(((
    message: Record<string, unknown>,
    cb?: (res: unknown) => void,
  ) => {
    seen.push(message.type as string);
    const handler = handlers[message.type as string];
    const res = handler ? handler(message) : undefined;
    if (cb) cb(res);
    return Promise.resolve(res);
  }) as typeof chromeMock.runtime.sendMessage);
  return seen;
}

afterEach(() => cleanup());

const READY = { "local-bridge:status": () => ({ hasPermission: true, ready: true }) };

describe("LocalBridgeSection — enabled-only main view + manage subview", () => {
  it("main view lists ONLY enabled agents, without switches", async () => {
    mockSendMessage({ ...READY, "local-agents:list": () => ({ agents: AGENTS }) });
    render(<LocalBridgeSection />);
    // 已启用：claude-app（两行文案：名称 + kind 副标）
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("App")).toBeTruthy();
    // 未启用/未安装的不出现在主视图
    expect(screen.queryByText("Codex")).toBeFalsy();
    // 主视图无开关（唯一的 switch 是本地打通总开关）
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("manage link opens the in-card subview with ALL agents + toggles; back returns", async () => {
    mockSendMessage({ ...READY, "local-agents:list": () => ({ agents: AGENTS }) });
    render(<LocalBridgeSection />);
    fireEvent.click(await screen.findByText("Manage agents"));
    // 子视图：全量三行（含未安装 Codex），出现 agent 开关
    expect(await screen.findByText("Codex")).toBeTruthy();
    expect(screen.getByText(/Not installed/)).toBeTruthy();
    expect(screen.getAllByRole("switch").length).toBeGreaterThan(1);
    // 返回
    fireEvent.click(screen.getByLabelText("Back"));
    await waitFor(() => expect(screen.queryByText("Codex")).toBeFalsy());
  });

  it("toggling an agent in the subview sends local-agents:toggle", async () => {
    mockSendMessage({
      ...READY,
      "local-agents:list": () => ({ agents: AGENTS }),
      "local-agents:toggle": () => ({ ok: true }),
    });
    render(<LocalBridgeSection />);
    fireEvent.click(await screen.findByText("Manage agents"));
    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[1]); // 第一个 agent 行开关（index 0 是总开关）
    await waitFor(() => {
      expect(
        chromeMock.runtime.sendMessage.mock.calls.some(
          (c) => (c[0] as { type?: string }).type === "local-agents:toggle",
        ),
      ).toBe(true);
    });
  });

  it("bridge drop while in subview forces back to main", async () => {
    let ready = true;
    mockSendMessage({
      "local-bridge:status": () => ({ hasPermission: true, ready }),
      "local-agents:list": () => ({ agents: AGENTS }),
    });
    render(<LocalBridgeSection />);
    fireEvent.click(await screen.findByText("Manage agents"));
    expect(await screen.findByText("Codex")).toBeTruthy();
    ready = false; // 下一个 1.5s 轮询读到 not-ready → effect 强制回主视图
    await waitFor(() => expect(screen.queryByText("Codex")).toBeFalsy(), { timeout: 4000 });
  });

  it("never queries grants or audit", async () => {
    const seen = mockSendMessage({ ...READY, "local-agents:list": () => ({ agents: AGENTS }) });
    render(<LocalBridgeSection />);
    await screen.findByText("Claude Code");
    expect(seen).not.toContain("local-grants:list");
    expect(seen).not.toContain("local-audit:list");
  });

  it("falls back to single-line label when kind is missing (old daemon)", async () => {
    mockSendMessage({
      ...READY,
      "local-agents:list": () => ({
        agents: [{ id: "claude-app", label: "Claude Code (App)", installed: true, enabled: true }],
      }),
    });
    render(<LocalBridgeSection />);
    expect(await screen.findByText("Claude Code (App)")).toBeTruthy();
  });
});
```

Run: `pnpm vitest run src/sidepanel/components/Settings.localbridge.test.tsx`
Expected: FAIL（现实现是全量列表 + grants/audit 查询）

- [ ] **Step 3: Rewrite LocalBridgeSection**

替换 `LocalBridgeSection`（并删除文件顶部的 `queryGrants` / `queryAudit` 两个函数与 `import type { GrantRecord, AuditEntry }`——若 Task 9 之前 `GrantRecord` 别处不用）：

```tsx
// Settings.tsx — LocalBridgeSection 整体替换
import { AgentBrandIcon } from "./hitl/agent-brand-icons"; // 文件顶部补 import

/** agent 名称/kind 拆分：有 kind 时剥掉 label 里的 "(App)"/"(Terminal)" 尾缀显示两行；
 *  旧 daemon 无 kind → 整串 label 单行回退。 */
function splitAgentLabel(a: PanelAgent): { name: string; sub: string | null } {
  if (!a.kind) return { name: a.label, sub: null };
  const name = a.label.replace(/\s*\((App|Terminal)\)\s*$/i, "");
  const sub = a.kind === "app" ? "App" : "Terminal";
  return { name, sub };
}

export function LocalBridgeSection() {
  const t = useT();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [agents, setAgents] = useState<PanelAgent[]>([]);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [view, setView] = useState<"main" | "agents">("main");

  useEffect(() => {
    queryBridgeStatus(setStatus);
    const id = setInterval(() => queryBridgeStatus(setStatus), 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status?.ready) queryLocalAgents(setAgents);
    else {
      setAgents([]);
      setView("main"); // 桥断开 → 管理子视图失去意义，强制回主视图
    }
  }, [status?.ready]);

  const enabled = status?.hasPermission ?? false;
  const onToggle = async (next: boolean) => {
    try {
      if (next) await chrome.permissions.request({ permissions: ["nativeMessaging"] });
      else await chrome.permissions.remove({ permissions: ["nativeMessaging"] });
    } catch {
      /* 用户取消了权限弹窗 */
    }
    queryBridgeStatus(setStatus);
  };

  const onAgentToggle = (id: string, next: boolean) => {
    setFailedId(null);
    try {
      chrome.runtime.sendMessage({ type: "local-agents:toggle", id, next }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.ok) queryLocalAgents(setAgents);
        else setFailedId(id);
      });
    } catch {
      /* noop */
    }
  };

  const statusText =
    status == null
      ? ""
      : !status.hasPermission
        ? t("settings.localBridge.statusOff")
        : status.ready
          ? t("settings.localBridge.statusConnected")
          : t("settings.localBridge.statusEnabledNotConnected");

  const enabledAgents = agents.filter((a) => a.enabled);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">
          {t("settings.localBridge.sectionTitle")}
        </span>
      </div>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
        {view === "main" ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.title")}</div>
                <div className="text-[12px] leading-relaxed text-fg-3">{t("settings.localBridge.description")}</div>
                {statusText && (
                  <div className="flex items-center gap-1.5">
                    {status?.ready && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
                    <span className={`text-[12px] ${status?.ready ? "text-fg-1" : "text-fg-3"}`}>{statusText}</span>
                  </div>
                )}
              </div>
              <Switch checked={enabled} onChange={onToggle} />
            </div>
            {status?.ready && agents.length > 0 && (
              <div className="flex flex-col gap-2.5 border-t border-line pt-3">
                {enabledAgents.length > 0 && (
                  <>
                    <span className="caps text-fg-3">{t("settings.localBridge.agentsEnabledTitle")}</span>
                    {enabledAgents.map((a) => {
                      const { name, sub } = splitAgentLabel(a);
                      return (
                        <div key={a.id} className="flex items-center gap-2.5">
                          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field text-fg-2">
                            <AgentBrandIcon agentId={a.id} size={14} />
                          </span>
                          <span className="text-[13px] text-fg-1">{name}</span>
                          {sub && <span className="text-[11px] text-fg-3">{sub}</span>}
                        </div>
                      );
                    })}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setView("agents")}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-[7px] text-[12px] font-medium text-fg-2 hover:text-fg-1"
                >
                  {t("settings.localBridge.manageAgents")}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Back"
                onClick={() => setView("main")}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-2 hover:text-fg-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <span className="text-[13px] font-medium text-fg-1">{t("settings.localBridge.manageAgents")}</span>
            </div>
            {agents.map((a) => {
              const { name, sub } = splitAgentLabel(a);
              const subLine = [sub, a.installed ? null : t("settings.localBridge.agentNotInstalled")]
                .filter(Boolean)
                .join(" · ");
              return (
                <div key={a.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-chip bg-field ${a.installed ? "text-fg-2" : "text-fg-3"}`}
                    >
                      <AgentBrandIcon agentId={a.id} size={14} />
                    </span>
                    <div className="flex grow flex-col">
                      <span className={`text-[13px] ${a.installed ? "text-fg-1" : "text-fg-2"}`}>{name}</span>
                      {subLine && <span className="text-[11px] text-fg-3">{subLine}</span>}
                    </div>
                    <Switch checked={a.enabled} onChange={(next) => onAgentToggle(a.id, next)} />
                  </div>
                  {failedId === a.id && (
                    <div className="text-[11px] text-fg-3">{t("settings.localBridge.agentEnableFailed")}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
```

注：`Switch` 组件（Settings.tsx 底部）已带 `role="switch"` + `aria-checked`，测试的 `getAllByRole("switch")` 直接可用，无需改 Switch。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/sidepanel/components/Settings.localbridge.test.tsx && pnpm typecheck`
Expected: PASS / 0 errors（若 typecheck 报 `GrantRecord` 等 unused import，删之）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/Settings.localbridge.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): 本地打通设置区重构——已启用列表 + Agent 管理子视图 + 品牌图标，grants/audit 展示移除（#270 Task 8）"
```

---

### Task 9: local-grants 助手 + SkillsList 授权行（pill + 撤销）+ 全量门禁

**Files:**
- Create: `src/lib/local-grants.ts`
- Test: `src/lib/local-grants.test.ts`
- Modify: `src/sidepanel/components/SkillsList.tsx`
- Create: `src/sidepanel/components/SkillsList.grants.test.tsx`
- Modify: 六字典——`skills.grant.*`

**Interfaces:**
- Consumes: `GrantRecord` from `@/types/local-bridge`；SW 既有消息 `local-grants:list` / `local-grants:revoke`（零改动，daemon-off 时 SW 回空/false）
- Produces:
  - `export function queryGrants(): Promise<GrantRecord[]>`（异常/无桥 → `[]`）
  - `export function revokeGrant(key: string): Promise<boolean>`

- [ ] **Step 1: 更新六字典 skills.grant.* key**

在每份字典 `skills` 段内加 `grant` 子段：

```ts
// en.ts    grant: { granted: "Scripts authorized", revoke: "Revoke" },
// zh-CN.ts grant: { granted: "脚本已授权", revoke: "撤销授权" },
// zh-TW.ts grant: { granted: "腳本已授權", revoke: "撤銷授權" },
// ja.ts    grant: { granted: "スクリプト承認済み", revoke: "承認を取り消す" },
// es-419.ts grant: { granted: "Scripts autorizados", revoke: "Revocar" },
// pt-BR.ts grant: { granted: "Scripts autorizados", revoke: "Revogar" },
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/local-grants.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { queryGrants, revokeGrant } from "./local-grants";
import { chromeMock } from "@/test/setup";

const GRANT = {
  key: "skill:s:abc",
  skillName: "fetch-report",
  envelope: { allowedDomains: [], extraWrites: [], runnableScripts: ["fetch.ts"] },
  grantedAt: 1700000000000,
};

afterEach(() => chromeMock.runtime.sendMessage.mockReset());

describe("local-grants helpers", () => {
  it("queryGrants resolves the grants array", async () => {
    chromeMock.runtime.sendMessage.mockImplementation(((_m: unknown, cb?: (r: unknown) => void) => {
      cb?.({ grants: [GRANT] });
      return Promise.resolve();
    }) as typeof chromeMock.runtime.sendMessage);
    expect(await queryGrants()).toEqual([GRANT]);
  });

  it("queryGrants resolves [] on error / malformed response", async () => {
    chromeMock.runtime.sendMessage.mockImplementation((() => {
      throw new Error("no SW");
    }) as typeof chromeMock.runtime.sendMessage);
    expect(await queryGrants()).toEqual([]);
  });

  it("revokeGrant sends key and resolves ok", async () => {
    let sent: Record<string, unknown> | null = null;
    chromeMock.runtime.sendMessage.mockImplementation(((m: Record<string, unknown>, cb?: (r: unknown) => void) => {
      sent = m;
      cb?.({ ok: true });
      return Promise.resolve();
    }) as typeof chromeMock.runtime.sendMessage);
    expect(await revokeGrant("skill:s:abc")).toBe(true);
    expect(sent).toEqual({ type: "local-grants:revoke", key: "skill:s:abc" });
  });
});
```

```tsx
// src/sidepanel/components/SkillsList.grants.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import SkillsList from "./SkillsList";

const DISK_SKILL = {
  id: "gh-dashboard",
  name: "gh-dashboard",
  description: "Pulls repo metrics",
  builtIn: false,
  origin: "disk" as const,
  files: ["SKILL.md"],
  runnableScripts: ["fetch.ts"],
  createdAt: 2,
};

const GRANT = {
  key: "skill:gh-dashboard:abc",
  skillName: "gh-dashboard",
  envelope: { allowedDomains: [], extraWrites: [], runnableScripts: ["fetch.ts"] },
  grantedAt: 1700000000000,
};

vi.mock("@/lib/skills/panel-actions", () => ({
  listSkillEntries: vi.fn(async () => ({ ok: true, skills: [DISK_SKILL] })),
  readSkillFileRpc: vi.fn(async () => ({ ok: false, error: "nope" })),
  writeSkillRpc: vi.fn(async () => ({ ok: true })),
  deleteSkillRpc: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/skills", () => ({
  getEnabledSkillIds: vi.fn(async () => []),
  setSkillEnabled: vi.fn(async () => {}),
  generateUserSkillId: vi.fn(() => "u1"),
}));
vi.mock("@/lib/local-grants", () => ({
  queryGrants: vi.fn(async () => [GRANT]),
  revokeGrant: vi.fn(async () => true),
}));

import { queryGrants, revokeGrant } from "@/lib/local-grants";

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(queryGrants).mockResolvedValue([GRANT]);
});

describe("SkillsList — grant pill + revoke", () => {
  it("granted disk skill row shows the authorized pill and revoke action", async () => {
    render(<SkillsList onRunSkill={() => {}} />);
    expect(await screen.findByText("Scripts authorized")).toBeTruthy();
    expect(screen.getByText("Revoke")).toBeTruthy();
  });

  it("revoke calls revokeGrant with the grant key and refreshes grants", async () => {
    render(<SkillsList onRunSkill={() => {}} />);
    fireEvent.click(await screen.findByText("Revoke"));
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith("skill:gh-dashboard:abc"));
    // 刷新后无 grant → pill 消失
    vi.mocked(queryGrants).mockResolvedValue([]);
    await waitFor(() => expect(screen.queryByText("Scripts authorized")).toBeFalsy());
  });

  it("no grants → row renders without pill or revoke", async () => {
    vi.mocked(queryGrants).mockResolvedValue([]);
    render(<SkillsList onRunSkill={() => {}} />);
    expect(await screen.findByText(/gh-dashboard/)).toBeTruthy();
    expect(screen.queryByText("Scripts authorized")).toBeFalsy();
    expect(screen.queryByText("Revoke")).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/local-grants.test.ts src/sidepanel/components/SkillsList.grants.test.tsx`
Expected: FAIL — `Cannot find module './local-grants'` / SkillsList 无 pill

- [ ] **Step 4: Write local-grants helpers**

```ts
// src/lib/local-grants.ts
import type { GrantRecord } from "@/types/local-bridge";

/**
 * skill grants 查询/撤销（#270：控制入口住 SkillsList，Settings 不再消费）。
 * SW 侧消息既有：daemon-off / 旧 daemon / SW 睡死 → 空列表 / false，调用方零分支。
 */
export function queryGrants(): Promise<GrantRecord[]> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "local-grants:list" }, (res) => {
        if (chrome.runtime.lastError) return resolve([]);
        resolve(res && Array.isArray(res.grants) ? (res.grants as GrantRecord[]) : []);
      });
    } catch {
      resolve([]);
    }
  });
}

export function revokeGrant(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "local-grants:revoke", key }, (res) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(res?.ok === true);
      });
    } catch {
      resolve(false);
    }
  });
}
```

- [ ] **Step 5: Wire grants into SkillsList**

`SkillsList.tsx` 增改（其余不动）：

```tsx
// import 区补：
import { queryGrants, revokeGrant } from "@/lib/local-grants";
import type { GrantRecord } from "@/types/local-bridge";

// SkillsList 组件内补 state：
const [grants, setGrants] = useState<Map<string, GrantRecord>>(new Map());

// loadSkills 末尾（setEnabledIds 之后）补：
const grantList = await queryGrants();
setGrants(new Map(grantList.map((g) => [g.skillName, g])));

// 撤销：撤销后重查 grants（不必重拉 skills）
async function handleRevoke(key: string) {
  const ok = await revokeGrant(key);
  if (ok) {
    const grantList = await queryGrants();
    setGrants(new Map(grantList.map((g) => [g.skillName, g])));
  }
}

// custom.map(...) 渲染处给 SkillRow 传新 props（完整调用）：
<SkillRow
  key={skill.id}
  skill={skill}
  grant={grants.get(skill.name) ?? null}
  onRevoke={handleRevoke}
  enabled={isEffectivelyEnabled(skill)}
  onToggle={() => handleToggle(skill)}
  onRun={() => onRunSkill(skill.id, skill.name)}
  onEdit={() => openEditForm(skill)}
  confirmDelete={confirmDeleteId === skill.id}
  onAskDelete={() => setConfirmDeleteId(skill.id)}
  onCancelDelete={() => setConfirmDeleteId(null)}
  onDelete={() => handleDelete(skill)}
/>
```

`SkillRow` 签名与渲染增改：

```tsx
function SkillRow({
  skill,
  grant,
  onRevoke,
  enabled,
  onToggle,
  onRun,
  onEdit,
  confirmDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  skill: SkillEntry;
  grant: GrantRecord | null;
  onRevoke: (key: string) => void;
  enabled: boolean;
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  …
  return (
    <div className="flex flex-col gap-2 border-t border-line bg-surface px-3.5 py-3.5 first:border-t-0">
      {/* 名称行、描述行不动 */}
      …
      <div className="flex items-center gap-2 pt-1.5">
        {grant && (
          <span className="flex items-center gap-[5px] rounded-full border border-line bg-surface-deep px-2 py-0.5">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-success">
              <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span className="text-[11px] text-fg-2">{t("skills.grant.granted")}</span>
          </span>
        )}
        <div className="flex-1" />
        {grant && (
          <button
            onClick={() => onRevoke(grant.key)}
            className="rounded-[10px] border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            {t("skills.grant.revoke")}
          </button>
        )}
        {/* Run / 编辑 / 删除按钮现状不动 */}
        …
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/local-grants.test.ts src/sidepanel/components/SkillsList.grants.test.tsx`
Expected: PASS

- [ ] **Step 7: 全量门禁**

Run:
```bash
pnpm test && pnpm typecheck && pnpm build && cd daemon && bun test && cd ..
```
Expected: 全绿。build 的 invariant（tool-names / R-iframe-1）不受本工程影响。

- [ ] **Step 8: Commit**

```bash
git add src/lib/local-grants.ts src/lib/local-grants.test.ts src/sidepanel/components/SkillsList.tsx src/sidepanel/components/SkillsList.grants.test.tsx src/lib/i18n/dictionaries/
git commit -m "feat(panel): grants 控制迁入 SkillsList——脚本已授权 pill + 撤销授权（#270 Task 9）"
```

---

## 真机验收清单（spec §9 全文照抄，merge 前人工过）

1. 逐一触发五张卡：都出现在消息流尾部（滚动区内），进出场有动画，决议后消失无残留；挂起期间 WorkingIndicator 隐藏、列表自动滚到底
2. skill-grant / run-local-agent / handoff 呈 warning 珊瑚强调（图标 + caps + 主按钮）；local-file / cdp-consent 呈 accent 冷蓝灰；明暗两主题都协调
3. 任何卡头都看不到 `run_skill_script` 等内部工具名
4. HandoffCard 收件人行有品牌图标，选中态清晰可辨
5. 设置「本地打通」：主卡只列已启用 agent（带品牌图标 tile）；「Agent 管理」子视图卡内切换、可返回；grants / audit 区不存在
6. Skills 列表：已授权 skill 行有「脚本已授权」pill 与「撤销授权」；撤销后 pill 消失，该 skill 下次跑脚本重新弹授权卡
7. `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿
