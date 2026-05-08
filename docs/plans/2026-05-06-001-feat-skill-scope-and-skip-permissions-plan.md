---
title: "feat: Skill scope 解禁 + 全局 skip-permissions toggle"
type: feat
status: draft
date: 2026-05-06
origin: docs/specs/2026-05-06-skill-scope-and-skip-permissions-requirements.md
issue: "#26"
---

# feat: Skill scope 解禁 + 全局 skip-permissions toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 issue #26 的两个诉求 —— (1) 删除 Skill scope 内的 `allowedTools` 白名单 / R3 嵌套禁止 / R10 first-run-confirm；(2) Settings 加全局 `skipPermissions` toggle，开后所有 high-risk confirm 自动 approve。

**Architecture:** 两件事正交。Change 1 拆 `loop.ts` / `skill-meta.ts` / `SkillsList` / `AgentConfirmCard` 中所有 R2/R3/R10 与 `allowedTools` 相关代码；保留字段为 deprecated 以兼容老 storage。Change 2 在 `src/lib/skip-permissions.ts` 新建 toggle helper，SW `sendConfirmRequest` 在 pre-capture 之后短路返回；agent-step 事件加 `autoApproved` wire 字段供 panel 渲染审计标记。Risk classifier、`untrusted_*` wrapper、K-9/R7 server-side 锁全部保留。

**Tech Stack:** TypeScript / React 19 / Chrome MV3 / Vite 8 + @crxjs/vite-plugin / vitest + happy-dom / TailwindCSS v4。

---

## Requirements Trace

源自 `docs/specs/2026-05-06-skill-scope-and-skip-permissions-requirements.md`：

- **R1.1 – R1.10** Change 1：解禁 skill scope（删 R2/R3/R10、字段 deprecated、schema 清理、storage helper 删）
- **R2.1 – R2.9** Change 2：全局 toggle（新模块、SW 短路、ctx 注入、agent-step 标记、Settings UI、Chat banner）
- **R3.1 – R3.5** UI 修剪
- **R4.1 – R4.6** 留下来的护栏（明确不动）
- **Success Criteria** 见 origin "Success Criteria" 段

参见 origin `Success Criteria` 与 `Testing` 段——本 plan acceptance 以那两段为准。

## Scope Boundaries

参见 origin `Scope Boundaries`：本 plan **不含** per-skill `trusted` 标记、per-tool/per-domain 信任记忆、SW 端额外 page-content 防注入、Settings 内 typing-style 强仪式、risk classifier 规则修改、跨 session 单独的 skipPermissions 配置。

## Context & Research

### Relevant Code and Patterns

- `src/lib/keyboard-simulation.ts` —— Settings toggle 的 reference 实现：单文件单 key 单 helper。新模块 `skip-permissions.ts` 镜像此模式
- `src/sidepanel/components/Settings.tsx:302-343` —— `KeyboardSimSection` 视觉模板。新 `SkipPermissionsSection` 沿用 `<Switch>` 子组件 + warning 色系（`border-warning-line bg-warning-tint text-warning`）
- `src/lib/agent/loop.ts:33` —— `import { ... markSkillFirstRun ... } from "../skills"` 入口
- `src/lib/agent/loop.ts:60-79` —— SkillScope 接口与 R2/R3 注释（待删）
- `src/lib/agent/loop.ts:144-155` —— `resumedSkillScopeStack` ctx 字段（待删）
- `src/lib/agent/loop.ts:925-928` —— resume 路径恢复 stack（待删）
- `src/lib/agent/loop.ts:1107-1110` —— `keyboardSimEnabledAtStart` snapshot 模式；`skipPermissions` 同位置加 snapshot
- `src/lib/agent/loop.ts:1518-1551` —— R2/R3 enforcement 整段（待删）
- `src/lib/agent/loop.ts:1740-1746, 1918-1926` —— `sendConfirmRequest` 两个 call site
- `src/lib/agent/loop.ts:2002-2061` —— R10 first-run-confirm 整段（待删）
- `src/lib/agent/loop.ts:2151-2156` —— skill scope push（待删）
- `src/lib/agent/loop.ts:2211` —— `buildSessionAgentSnapshot` 调用，含 `skillExecutionScopeStack` 参数（待删）
- `src/lib/agent/loop.ts:643-690` —— `buildSessionAgentSnapshot` 与默认状态构造器签名（待改）
- `src/background/index.ts:1215-1410` —— SW chat-stream-port handler 内 `sendConfirmRequest` 定义（短路插点）
- `src/background/index.ts:642-845` —— SW message-port handler 同名定义（同改动应用）
- `src/lib/skills/types.ts:1-41` —— `SkillDefinition` interface
- `src/lib/skills/storage.ts:73-77` —— `markSkillFirstRun`（待删）；`withSkillDefaults`（保留 + 调整：不再默认设 allowedTools）
- `src/lib/skills/index.ts:8-14` —— skills barrel export 中 `markSkillFirstRun`（待删）
- `src/lib/skills/builtin.ts:30-322` —— 7 个 BUILT_IN_SKILLS（待去 `allowedTools`）
- `src/lib/skills/builtin.ts:325-350` —— `BUILT_IN_SKILLS` 导入时 `allowedTools` 校验（待删）
- `src/lib/agent/tool-names.ts:179-200` —— `ALL_KNOWN_NON_SKILL_TOOL_NAMES`（删）
- `src/lib/agent/tool-names.ts:202-220` —— `ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES`（删）
- `src/lib/agent/tools/skill-meta.ts:79-109` —— `validateSkillContent` P1-F + P1-G（待删两条）
- `src/lib/agent/tools/skill-meta.ts:113-193` —— `create_skill` schema/handler
- `src/lib/agent/tools/skill-meta.ts:195-275` —— `update_skill` schema/handler
- `src/lib/agent/risk.ts:364-375` —— `riskOfAllowedTools`（待删）
- `src/lib/agent/risk.ts:397-453` —— G-1 build-time gate（保留代码 + 重写注释）
- `src/sidepanel/components/SkillsList.tsx:111-122, 270, 494-497, 523-530, 562-564` —— allowedTools 输入与派生 UI（待删）
- `src/sidepanel/components/SkillsList.tsx:492-493, 532-553` —— first-run-pending 角标 + 提示卡（待删）
- `src/sidepanel/components/AgentConfirmCard.tsx:236-241, 252-253, 294-307` —— allowedTools 比较与渲染（待删）
- `src/sidepanel/components/AgentConfirmCard.tsx:248-253` —— "re-confirm on next execution" 文案（待改）
- `src/sidepanel/components/Chat.tsx` —— Chat 顶部加 banner 的挂载点（具体行待 implementation 时定，找 message list 之上的 layout 节点）

### Institutional Learnings

- **Cross-layer integration test 模板**（来自 user memory `feedback_cross_layer_integration_tests.md`）：任何跨 panel↔SW 新 wire 字段必须有 wire→DisplayMessage 透传 regression test。本 plan 新增 wire 字段 `agent-step.autoApproved`，必须配套 cross-layer test。
- **Snapshot 时机模式**：`keyboardSimEnabledAtStart` 在 `runAgentLoop` 入口读一次后闭包捕获，确保任务跑到一半切 toggle 不影响 in-flight；`skipPermissions` 沿用此模式（origin §2.6）。
- **SW 双 confirm 路径**：`src/background/index.ts` 内 `sendConfirmRequest` 在 chat-stream-port handler（行 1215）和 message-port handler（行 642）各定义了一份，结构相同。短路逻辑必须在两处都加，否则一类 session 没生效。

### External References

无外部参考。本 plan 全部基于 origin 决策与项目已有 pattern。

## Key Technical Decisions

- **不做 storage migration**：`allowedTools` / `firstRunConfirmedAt` 字段在 TS 类型保留为 optional + `@deprecated`，老 storage 数据反序列化不报错。新写入路径不携带这两字段——下次用户保存 skill 时自然 lazy migration。
- **`skillExecutionScopeStack` 字段从 `SessionAgentState` 完全删除**：checkpoint resume 时反序列化老 snapshot 多余字段被忽略（TS excess property check 仅对字面量生效）；新 snapshot 不再写该字段。需对 `buildSessionAgentSnapshot` 签名做 breaking change 并更新所有调用点。
- **`autoApproved` wire 字段为 `boolean | undefined`，不是 `boolean`**：仅在自动批准发生时携带 `true`；不存在时忽略，便于 panel 端类型守卫与渲染分支。
- **SW 短路插入点：pre-capture 之后、panel-post 之前**：截图 / open_url 的 pre-capture 与 URL 解析必须保留（截图字节是 LLM 输入，不是 UI 决策面）。短路只跳过"post 给 panel + 等待 resolver"那一段。
- **改动顺序：增量先行，删除收尾**：步骤 1-4 是新增（toggle、UI、SW 短路），互不破坏老语义；步骤 5-6 才开始删 R10/R2/R3；步骤 7-13 是连带的 schema/UI/常量清理。任意中间步骤 commit 后 build/test 均绿。
- **测试策略**：能用 vitest 覆盖的逻辑（loop / skill-meta / risk / storage / skip-permissions）走 unit + cross-layer integration；UI 视觉与 SW 协议交互走 manual E2E checklist（已有项目惯例，不新加 framework）。

## File Structure

| 路径 | 操作 | 责任 |
|---|---|---|
| `src/lib/skip-permissions.ts` | 新建 | toggle storage helper（仿 `keyboard-simulation.ts`） |
| `src/lib/skip-permissions.test.ts` | 新建 | helper 单元测试 |
| `src/sidepanel/components/Settings.tsx` | 改 | 加 `<SkipPermissionsSection>` + 一次性 modal |
| `src/sidepanel/components/Chat.tsx` | 改 | 顶部 banner + storage onChanged 订阅 |
| `src/background/index.ts` | 改 | 两处 `sendConfirmRequest` 短路；ctx 注入 `skipPermissions` |
| `src/lib/agent/loop.ts` | 改 | 删 R2/R3/R10/scope stack；ctx 加字段；agent-step 加 `autoApproved` |
| `src/lib/agent/loop.test.ts` | 改 | 删过期 test，加新 cases |
| `src/lib/agent/cross-layer.test.ts` | 新建 | wire→DisplayMessage 透传 regression |
| `src/lib/agent/types.ts` | 改 | `AgentLoopContext.skipPermissions` |
| `src/lib/agent/tools/skill-meta.ts` | 改 | schema 删 `allowedTools`；handler 删 P1-F/P1-G/firstRunConfirmedAt 清空 |
| `src/lib/agent/tools/skill-meta.test.ts` | 改 | 删过期 test，加新 cases |
| `src/lib/skills/types.ts` | 改 | `allowedTools` / `firstRunConfirmedAt` 标 `@deprecated` |
| `src/lib/skills/storage.ts` | 改 | 删 `markSkillFirstRun`；`withSkillDefaults` 不再默认补 `allowedTools` |
| `src/lib/skills/index.ts` | 改 | 删 `markSkillFirstRun` re-export |
| `src/lib/skills/builtin.ts` | 改 | 7 个 entry 去 `allowedTools`；删导入时校验 |
| `src/lib/agent/risk.ts` | 改 | 删 `riskOfAllowedTools`；G-1 注释重写 |
| `src/lib/agent/tool-names.ts` | 改 | 删 `ALL_KNOWN_NON_SKILL_TOOL_NAMES` + `ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES` |
| `src/sidepanel/components/SkillsList.tsx` | 改 | 删 allowedTools 输入 + first-run badge + 派生 UI |
| `src/sidepanel/components/AgentConfirmCard.tsx` | 改 | 删 allowedTools 渲染；header 文案改 |
| `src/types/messages.ts` | 改 | `AgentStepMessage` 加 `autoApproved?: boolean` |
| `docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md` | 新建 | invariant trace doc（落地后写） |
| `docs/ROADMAP.md` | 改 | 标记本 phase 已交付 |

---

## Tasks

### Task 1: 新建 skip-permissions module

**Files:**
- Create: `src/lib/skip-permissions.ts`
- Test: `src/lib/skip-permissions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/skip-permissions.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isSkipPermissionsEnabled,
  setSkipPermissionsEnabled,
  SKIP_PERMISSIONS_STORAGE_KEY,
} from "./skip-permissions";

describe("skip-permissions toggle storage", () => {
  beforeEach(() => {
    const store: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (kv: Record<string, unknown>) => {
            Object.assign(store, kv);
          }),
        },
      },
    } as unknown as typeof chrome;
  });

  it("defaults to false when key absent", async () => {
    expect(await isSkipPermissionsEnabled()).toBe(false);
  });

  it("returns true after set true", async () => {
    await setSkipPermissionsEnabled(true);
    expect(await isSkipPermissionsEnabled()).toBe(true);
  });

  it("coerces non-boolean to boolean", async () => {
    await setSkipPermissionsEnabled("yes" as unknown as boolean);
    expect(await isSkipPermissionsEnabled()).toBe(true);
    await setSkipPermissionsEnabled(0 as unknown as boolean);
    expect(await isSkipPermissionsEnabled()).toBe(false);
  });

  it("exports stable storage key", () => {
    expect(SKIP_PERMISSIONS_STORAGE_KEY).toBe("skip_permissions_enabled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/skip-permissions.test.ts`
Expected: FAIL — module `./skip-permissions` not found.

- [ ] **Step 3: Write the module**

```ts
// src/lib/skip-permissions.ts
// Global "skip permissions" toggle. When ON, sendConfirmRequest in the SW
// short-circuits every high-risk confirm card and auto-approves. Default OFF.
// See docs/specs/2026-05-06-skill-scope-and-skip-permissions-requirements.md
// (R2.1) — task-level snapshot semantics applied at chat-start (R2.2).

const STORAGE_KEY = "skip_permissions_enabled";

export async function isSkipPermissionsEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return !!result[STORAGE_KEY];
}

export async function setSkipPermissionsEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: !!value });
}

export const SKIP_PERMISSIONS_STORAGE_KEY = STORAGE_KEY;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/skip-permissions.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skip-permissions.ts src/lib/skip-permissions.test.ts
git commit -m "feat(skip-permissions): add storage helper module (#26)"
```

---

### Task 2: Settings UI — `<SkipPermissionsSection>` + 一次性 modal

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`

- [ ] **Step 1: Add imports + state hooks**

在 `Settings.tsx` 顶部 import 区（第 16 行 `keyboard-simulation` 那行下面）添加：

```ts
import { isSkipPermissionsEnabled, setSkipPermissionsEnabled } from "@/lib/skip-permissions";
```

在 `Settings` 组件 useState 区（约第 35 行 `keyboardSim` 之后）添加：

```ts
const [skipPermissions, setSkipPermissions] = useState(false);
const [showSkipPermissionsModal, setShowSkipPermissionsModal] = useState(false);
```

- [ ] **Step 2: Read initial state on mount**

在 `useEffect(() => { reload(); isKeyboardSimulationEnabled().then(setKeyboardSim); }, [reload]);`（第 50-53 行）扩展为：

```ts
useEffect(() => {
  reload();
  isKeyboardSimulationEnabled().then(setKeyboardSim);
  isSkipPermissionsEnabled().then(setSkipPermissions);
}, [reload]);
```

- [ ] **Step 3: Add toggle handler that shows modal on OFF→ON**

在 `Settings` 组件内（紧接着 useEffect 的下面）加：

```ts
function handleSkipPermissionsToggle(next: boolean) {
  if (next) {
    // OFF → ON: gate behind one-shot confirm modal
    setShowSkipPermissionsModal(true);
  } else {
    // ON → OFF: direct
    setSkipPermissions(false);
    void setSkipPermissionsEnabled(false);
  }
}

async function confirmSkipPermissions() {
  setSkipPermissions(true);
  await setSkipPermissionsEnabled(true);
  setShowSkipPermissionsModal(false);
}

function cancelSkipPermissions() {
  setShowSkipPermissionsModal(false);
}
```

- [ ] **Step 4: Render section + modal**

在 `<KeyboardSimSection ... />`（第 228-231 行）下面加：

```tsx
<SkipPermissionsSection
  enabled={skipPermissions}
  onToggle={handleSkipPermissionsToggle}
/>
{showSkipPermissionsModal && (
  <SkipPermissionsConfirmModal
    onConfirm={confirmSkipPermissions}
    onCancel={cancelSkipPermissions}
  />
)}
```

- [ ] **Step 5: Add `SkipPermissionsSection` component below `KeyboardSimSection`**

在 `Settings.tsx` 文件末尾、`maskKey` helper 之前加：

```tsx
function SkipPermissionsSection({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="caps text-fg-3">DANGER</span>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-warning-line bg-warning-tint p-3.5">
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <div className="text-[13px] font-medium text-warning">⚠ Skip permissions</div>
            <p className="text-[12px] leading-[18px] text-warning/90">
              Auto-approve every tool call (high-risk clicks, keyboard input, screenshots,
              cross-tab writes, skill creation). The agent will execute without asking.
              Recommended only for trusted, well-tested skills and providers you control.
            </p>
            <p className="text-[11px] leading-[16px] text-warning/80">
              Page-content prompt-injection defenses (untrusted wrappers, cross-session tab locks)
              remain on.
            </p>
          </div>
          <Switch checked={enabled} onChange={onToggle} />
        </div>
      </div>
    </section>
  );
}

function SkipPermissionsConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex max-w-sm flex-col gap-3 rounded-lg border border-warning-line bg-surface p-4">
        <div className="text-[14px] font-semibold text-warning">Enable skip permissions?</div>
        <p className="text-[12px] leading-[18px] text-fg-2">
          Every tool call will be auto-approved without showing a confirm card. The agent
          can click submit buttons, type into sensitive fields, capture screenshots, open
          new tabs, and create skills with no further confirmation. You can disable this
          at any time.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="rounded border border-line bg-transparent px-3 py-1.5 text-[12px] text-fg-2 hover:border-fg-3 hover:text-fg-1"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded border border-warning-line bg-warning-tint px-3 py-1.5 text-[12px] text-warning hover:bg-warning/20"
          >
            I understand, enable
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Build + manual smoke**

Run: `pnpm build`
Expected: 0 errors. Load unpacked extension; open Settings → Configs tab → scroll to bottom → see new "DANGER" section with warning-colored card. Click toggle → modal appears → Cancel returns to OFF; toggle again → "I understand, enable" → toggle stays ON.

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/Settings.tsx
git commit -m "feat(settings): add skip-permissions toggle UI with one-shot confirm modal (#26)"
```

---

### Task 3: Chat header warning banner

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`

- [ ] **Step 1: Locate banner mount point**

Run: `grep -n "messages\.map\|MessageList\|<header\|rounded.*surface" src/sidepanel/components/Chat.tsx | head -10`
Read the surrounding 30 lines to find the layout root that renders above the message list. Pick the JSX node that wraps everything from the title bar down to the input. The banner mounts as a sibling immediately above the message list (or below the title bar — whichever shows on every Chat screen).

- [ ] **Step 2: Add imports + subscription**

在 Chat.tsx 顶部 import 区添加：

```ts
import {
  isSkipPermissionsEnabled,
  SKIP_PERMISSIONS_STORAGE_KEY,
} from "@/lib/skip-permissions";
```

在 Chat 组件 useState 区添加：

```ts
const [skipPermissionsBanner, setSkipPermissionsBanner] = useState(false);
```

加 useEffect 订阅：

```ts
useEffect(() => {
  void isSkipPermissionsEnabled().then(setSkipPermissionsBanner);
  const onChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== "local") return;
    if (SKIP_PERMISSIONS_STORAGE_KEY in changes) {
      setSkipPermissionsBanner(!!changes[SKIP_PERMISSIONS_STORAGE_KEY]?.newValue);
    }
  };
  chrome.storage.onChanged.addListener(onChange);
  return () => chrome.storage.onChanged.removeListener(onChange);
}, []);
```

- [ ] **Step 3: Render banner**

在 message list 之上、Chat 主区域内合适位置插入：

```tsx
{skipPermissionsBanner && (
  <div
    className="flex items-center gap-2 border-b border-warning-line bg-warning-tint px-3 py-1.5 text-[11px] text-warning"
    role="status"
  >
    <span>⚠ Skip-permissions ON — tool calls auto-approved</span>
    <button
      type="button"
      onClick={() => onOpenSettings?.()}
      className="ml-auto underline hover:text-warning/80"
    >
      Disable
    </button>
  </div>
)}
```

如果 `Chat` 组件还没有 `onOpenSettings` prop，从父组件读现有"打开 Settings"的入口（同一 panel 已有 Settings tab），把它通过 prop 传入。如果没有现成 callback，banner 的 Disable 按钮先用 `() => alert("Open Settings to disable")` 占位，并标记 TODO；找到入口后再连。

- [ ] **Step 4: Build + manual smoke**

Run: `pnpm build`
Expected: 0 errors. Load unpacked. 默认状态 Chat 顶部无 banner。Settings 开 toggle → 切回 Chat → banner 出现。再切 OFF → banner 消失。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx
git commit -m "feat(chat): add skip-permissions warning banner (#26)"
```

---

### Task 4: SW `sendConfirmRequest` 短路 + ctx 注入

**Files:**
- Modify: `src/background/index.ts`
- Modify: `src/lib/agent/loop.ts` (新增 `skipPermissions` ctx 字段)
- Modify: `src/lib/agent/types.ts` (如有 `AgentLoopContext` 别处定义) — 若无则 loop.ts 内部 interface 即可

- [ ] **Step 1: Add `skipPermissions` to AgentLoopContext**

修改 `src/lib/agent/loop.ts`，在 `AgentLoopContext` interface（第 81 行附近）新增字段（与现有 `keyboardSimEnabledAtStart` 模式对照——但 keyboard sim 是直接读 helper 不是 ctx 字段；这里 skipPermissions 作 ctx 字段是因为 SW 短路也需要它，统一从 ctx 流转）：

```ts
  /**
   * Task-level snapshot of the global skip-permissions toggle, read at
   * chat-start by the SW dispatcher (`isSkipPermissionsEnabled()`). When
   * true, the SW-side `sendConfirmRequest` short-circuits every high-risk
   * confirm and auto-approves; loop-side this also drives the
   * `autoApproved: true` wire flag on agent-step events so the panel can
   * render the audit footer (R2.5).
   *
   * Snapshot semantics: toggling mid-task does NOT affect the in-flight
   * task — same shape as keyboardSimEnabledAtStart.
   */
  skipPermissions: boolean;
```

- [ ] **Step 2: Read snapshot at chat-start in SW**

在 `src/background/index.ts` 两处 chat handler 内（第 642 + 1215 行附近）找到既有 `sendConfirmRequest` 定义的**正前方**。在那两处之前加：

```ts
import { isSkipPermissionsEnabled } from "@/lib/skip-permissions";
// ...

const skipPermissionsAtStart = await isSkipPermissionsEnabled();
```

具体定位：在 `chat-start` 消息处理函数顶部、靠近其他 `await isKeyboardSimulationEnabled()`（如有）或紧接在 sendConfirmRequest 闭包定义之前的非异步代码块。

- [ ] **Step 3: Insert short-circuit branch in `sendConfirmRequest`（chat-stream-port handler 第 1215 行附近）**

在 `sendConfirmRequest` 内，紧接着既有的 pre-capture（screenshot 分支）+ open_url URL 解析之后、panel-post 之前（约 1330 行附近，找 `port.postMessage({ type: "agent-confirm-request"...})` 的正前方），插入：

```ts
// R2.3 — global skip-permissions short-circuit. After pre-capture
// (screenshot) and URL pre-parse (open_url) so LLM-fed bytes / typed
// origin payloads are still produced, but the panel confirm card is
// never shown and the agent-confirm-response wait is bypassed.
if (skipPermissionsAtStart) {
  if (isScreenshotTool) {
    const consumed = consumePreCapture(confirmationId);
    if (!consumed?.image) {
      return {
        approved: false,
        reason: "pre-capture-failed",
        failureReason: "pre-capture cache miss (skip-permissions auto-approve path)",
      };
    }
    return {
      approved: true,
      screenshotResult: consumed.image,
    };
  }
  return { approved: true };
}
```

- [ ] **Step 4: Apply same short-circuit to message-port handler 第 642 行附近的 `sendConfirmRequest`**

重复 Step 3 的代码块插入第二个 handler 内同位置。两处必须保持同步。

- [ ] **Step 5: Pass snapshot into `runAgentLoop` ctx**

在 SW dispatch 调用 `runAgentLoop({ ... })` 处，新增 ctx 字段。两处 handler 都需要：

```ts
runAgentLoop({
  // ... existing fields
  skipPermissions: skipPermissionsAtStart,
});
```

定位：`runAgentLoop({` 字面量出现的地方，两个 handler 各一处。

- [ ] **Step 6: Build + smoke**

Run: `pnpm build`
Expected: 0 errors. Manual: 默认 OFF 状态下 click submit 仍弹卡（与改前同）；ON 状态下 click submit 不弹卡，agent-step 直接显示 ok（autoApproved 标记下一步加）。

- [ ] **Step 7: Commit**

```bash
git add src/background/index.ts src/lib/agent/loop.ts
git commit -m "feat(sw): short-circuit sendConfirmRequest when skip-permissions ON (#26)"
```

---

### Task 5: 删除 R10 first-run-confirm + 加 `autoApproved` wire 字段

**Files:**
- Modify: `src/lib/agent/loop.ts`
- Modify: `src/types/messages.ts`
- Modify: `src/sidepanel/components/AgentStepCard.tsx`（如存在；若 step 渲染散在 Chat.tsx 内则改 Chat.tsx）
- Modify: `src/lib/agent/loop.test.ts`

- [ ] **Step 1: Add `autoApproved` to `AgentStepMessage`**

修改 `src/types/messages.ts`，找到 `AgentStepMessage` interface 定义（项目笔记 origin §4.1 提示约第 64-81 行），在字段列表中追加：

```ts
  /**
   * R2.5 — when the SW auto-approved this step due to global
   * skipPermissions toggle (and the step would otherwise have shown a
   * confirm card: high-risk tool, screenshot tool). Absent on regular
   * approved/low-risk steps. Panel renders an audit footer when true.
   */
  autoApproved?: boolean;
```

- [ ] **Step 2: Delete R10 block + emit `autoApproved` in loop.ts**

删除 `src/lib/agent/loop.ts` 第 2002-2061 行（整段 R10 first-run-confirm 块——从注释 `// ── Phase 2.6 — R10 first-run confirm for agent-authored skills ────` 到 `}` 闭合，含 `await markSkillFirstRun(...)` 与 in-memory cache update）。

定位行的方法：

```bash
grep -n "Phase 2.6 — R10 first-run confirm" src/lib/agent/loop.ts
grep -n "skill-resolved set + first-run gate end" src/lib/agent/loop.ts
```

注：实际删除区间以 grep 标出的注释/代码块自然边界为准——从 R10 注释开头，到下一个不属于 R10 的代码段（即 "Phase 3 — confirm-time TabTarget snapshot" 注释）之前。删完该段后下一行应是：

```ts
        // Phase 3 — confirm-time TabTarget snapshot for cross-tab handlers.
```

同时把 `import` 行第 33 行 `markSkillFirstRun` 移除：

```ts
// 改前
import { getEnabledSkills, markSkillFirstRun, type SkillDefinition } from "../skills";
// 改后
import { getEnabledSkills, type SkillDefinition } from "../skills";
```

- [ ] **Step 3: Inject `autoApproved` in agent-step emits for high-risk path**

在 loop.ts 第 1890-2000 行的高风险分支内（`if (risk.level === "high") { ... if (!confirmResult.approved) { ... } }` 之后、handler 执行之前的 `emitStep` 调用），不存在直接 emit；real emit 发生在 handler 完成之后第 2133-2142 行的 `emitStep({ ... status: result.success ? "ok" : "error" ... })`。修改为：

```ts
        emitStep({
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: result.success ? "ok" : "error",
          observation,
          skillAuthor: skillAuthorForStep,
          autoApproved:
            ctx.skipPermissions && risk.level === "high" ? true : undefined,
        });
```

注：`risk` 变量在该作用域内可见（来自第 1877 行 `classifyRisk(...)` 调用）。

- [ ] **Step 4: Inject `autoApproved` in screenshot path**

同样在 loop.ts 第 1707-1867 行截图分支内，找最终 ok 出口的 `emitStep` 调用（第 1857-1866 行 `status: "ok"`）。修改为：

```ts
          emitStep({
            type: "agent-step",
            stepIndex,
            tool: tc.name,
            args: redactArgsForPanel(tc.name, tc.args),
            resolvedElement,
            status: "ok",
            observation: screenshotObs,
            skillAuthor: skillAuthorForStep,
            autoApproved: ctx.skipPermissions ? true : undefined,
          });
```

注：截图工具永远 high-risk（risk classifier 硬编码），所以条件不需要 `risk.level === "high"`——只要 skipPermissions 开就标记。

- [ ] **Step 5: Update panel renderer to show audit footer**

定位 step 卡渲染：

```bash
grep -n "agent-step\|autoApproved\|step.observation\|status === \"ok\"" src/sidepanel/components/*.tsx | head -20
```

找到渲染 `step.tool` / `step.observation` 的 JSX 块（可能在 `Chat.tsx` 或独立 `AgentStepCard.tsx`）。在该块内、step 主体之后追加：

```tsx
{step.autoApproved && (
  <div className="text-[10px] text-fg-3 italic">
    auto-approved by skip-permissions
  </div>
)}
```

- [ ] **Step 6: Update or delete loop tests referencing R10**

打开 `src/lib/agent/loop.test.ts`，搜索 `firstRunConfirmedAt` / `markSkillFirstRun` / `R10`：

```bash
grep -n "firstRun\|R10\|markSkillFirstRun" src/lib/agent/loop.test.ts
```

每个 R10 相关 test 改为断言**不发生**——例如：

```ts
it("agent-authored skill with no firstRunConfirmedAt does NOT trigger an extra confirm-request (R10 removed)", async () => {
  // setup: build a skill { author: 'agent', firstRunConfirmedAt: undefined }
  // execute one tool call against it
  // assert: sendConfirmRequest was NOT called for the skill itself,
  //         only for its high-risk inner tool calls (if any).
  expect(sendConfirmRequestSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({ riskReason: expect.stringMatching(/first run/i) }),
  );
});
```

具体测试代码以现有 loop.test.ts 风格为准（mock 依赖、setup helper）。

- [ ] **Step 7: Add new test for `autoApproved` flag**

在 loop.test.ts 加：

```ts
it("emits autoApproved=true on agent-step when skipPermissions is on and risk is high", async () => {
  const emitted: AgentStepMessage[] = [];
  await runAgentLoop({
    /* ... ctx with skipPermissions: true, sendConfirmRequest mocked to return {approved: true} */
    onAgentStep: (s) => emitted.push(s),
  });
  const highRiskStep = emitted.find((s) => s.tool === "click" /* high-risk submit */);
  expect(highRiskStep?.autoApproved).toBe(true);
});

it("omits autoApproved when skipPermissions is off", async () => {
  /* same setup with skipPermissions: false */
  expect(emitted.every((s) => s.autoApproved === undefined)).toBe(true);
});
```

- [ ] **Step 8: Run tests**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS — all R10 tests now assert non-occurrence; new `autoApproved` tests pass.

- [ ] **Step 9: Build**

Run: `pnpm build`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/agent/loop.ts src/types/messages.ts src/sidepanel/components/ src/lib/agent/loop.test.ts
git commit -m "refactor(loop): remove R10 first-run-confirm; add autoApproved wire field (#26)"
```

---

### Task 6: 删除 R2/R3 + `skillExecutionScopeStack`

**Files:**
- Modify: `src/lib/agent/loop.ts`
- Modify: `src/lib/agent/loop.test.ts`
- Modify: 任何持久化 SessionAgentState 的位置（搜索 `skillExecutionScopeStack` 全 repo）

- [ ] **Step 1: Inventory all references**

Run: `grep -rn "skillExecutionScopeStack\|resumedSkillScopeStack\|SkillScope" src/ --include="*.ts" --include="*.tsx"`

把每个匹配位置记下来，确认全部要删除。预期匹配：
- `src/lib/agent/loop.ts` 多处（interface SkillScope、ctx 字段、resume 入参、stack 创建、push、snapshot 调用）
- `src/lib/sessions/` 内 `SessionAgentState` 类型定义
- `src/lib/agent/loop.test.ts` 内既有 R2/R3 test

- [ ] **Step 2: Remove `SkillScope` interface + R2/R3 enforcement block**

删除 `src/lib/agent/loop.ts` 第 60-79 行（`SkillScope` interface 与 R2/R3 注释）。

删除 `src/lib/agent/loop.ts` 第 144-155 行（`resumedSkillScopeStack` ctx 字段定义）。

删除 `src/lib/agent/loop.ts` 第 925-928 行（resume 路径恢复 stack 的 if-else 分支）。把：

```ts
const skillExecutionScopeStack: SkillScope[] = ctx.resumedSkillScopeStack
  ? structuredClone(ctx.resumedSkillScopeStack)
  : [];
```

整段删除。

删除 `src/lib/agent/loop.ts` 第 1518-1551 行（R2/R3 enforcement——从 `// ── Phase 2.6 — Skill scope enforcement (R2 + R3 anti-nest) ────` 注释到对应 `}` 闭合）。

删除 `src/lib/agent/loop.ts` 第 2151-2156 行 skill scope push：

```ts
// 删除整段
if (skillResolvedNames.has(tc.name) && result.success) {
  skillExecutionScopeStack.push({
    skillId: tc.name,
    allowedTools: skillDefForStep?.allowedTools ?? null,
  });
}
```

- [ ] **Step 3: Remove `skillExecutionScopeStack` from `buildSessionAgentSnapshot`**

修改 `src/lib/agent/loop.ts` 第 643-690 行 `buildSessionAgentSnapshot` 与默认状态构造器。把签名

```ts
function buildSessionAgentSnapshot(
  agentMessages: AgentMessage[],
  stepIndex: number,
  skillExecutionScopeStack: SessionAgentState["skillExecutionScopeStack"] = [],
  hasImageContent: boolean = false,
): SessionAgentState
```

改为：

```ts
function buildSessionAgentSnapshot(
  agentMessages: AgentMessage[],
  stepIndex: number,
  hasImageContent: boolean = false,
): SessionAgentState
```

并把函数 body 内 `skillExecutionScopeStack: structuredClone(skillExecutionScopeStack),` 行删除；默认状态构造器内 `skillExecutionScopeStack: [],` 行删除。

修改第 2211 行调用点：

```ts
// 改前
const snapshot = buildSessionAgentSnapshot(history, stepIndex, skillExecutionScopeStack, hasImageContent);
// 改后
const snapshot = buildSessionAgentSnapshot(history, stepIndex, hasImageContent);
```

- [ ] **Step 4: Remove `skillExecutionScopeStack` field from `SessionAgentState`**

Run: `grep -n "skillExecutionScopeStack" src/lib/sessions/`

打开匹配文件（很可能是 `src/lib/sessions/types.ts` 或 `state-machine.ts`），从 `SessionAgentState` interface 中删除：

```ts
  skillExecutionScopeStack: Array<{ skillId: string; allowedTools: string[] | null }>;
```

任何构造默认 SessionAgentState 的地方（如 `defaultSessionAgentState()` helper）同步删除该字段的初始化。

老 storage 数据兼容性：反序列化时多余字段被 TS 忽略（excess properties OK in plain object decode）；新写入路径不再带这个字段。无需主动 migration。

- [ ] **Step 5: Remove `import { SkillScope }` if any**

Run: `grep -rn "SkillScope" src/`
删除任何残留 import 或别处使用。预期此时全 repo 0 匹配。

- [ ] **Step 6: Update tests**

打开 `src/lib/agent/loop.test.ts`：

```bash
grep -n "skillExecutionScopeStack\|resumedSkillScopeStack\|allowedTools.*scope\|R2\|R3" src/lib/agent/loop.test.ts
```

R2/R3 相关 test 重写为断言**不再拒绝**：

```ts
it("R2 removed: skill scope no longer rejects calls outside allowedTools", async () => {
  // setup a skill with allowedTools: ["click"] (legacy data shape)
  // execute the skill; agent then calls "type"
  // assert: type call goes through to its handler (no error observation)
  expect(observations.find((o) => o.includes("not allowed in skill"))).toBeUndefined();
});

it("R3 removed: a skill can call another skill", async () => {
  // skill A's promptTemplate triggers calling skill B
  // assert: no "Skills cannot call other skills" error observation
  expect(observations.find((o) => o.includes("Skills cannot call other skills"))).toBeUndefined();
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS — old R2/R3 enforcement tests inverted; new "scope freedom" cases pass.

- [ ] **Step 8: Build**

Run: `pnpm build`
Expected: 0 errors. (build-time check 在 risk.ts G-1 gate 仍在跑——它独立于 R2/R3，不应受影响。)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(loop): remove R2 (allowedTools) + R3 (skill→skill ban) + scope stack (#26)"
```

---

### Task 7: `skill-meta.ts` schema 清理

**Files:**
- Modify: `src/lib/agent/tools/skill-meta.ts`
- Modify: `src/lib/agent/tools/skill-meta.test.ts`（如存在；若 test 在 loop.test.ts 内则改那里）

- [ ] **Step 1: Drop `allowedTools` from `validateSkillContent`**

`src/lib/agent/tools/skill-meta.ts` 第 79-109 行 `validateSkillContent` 函数：

```ts
// 改前 — function signature & body
function validateSkillContent(args: {
  promptTemplate: string;
  parameters: unknown;
  allowedTools: unknown;
}): string | null {
  if (args.promptTemplate.length > PROMPT_TEMPLATE_MAX_BYTES) { ... }
  if (typeof args.parameters !== "object" || ...) { ... }
  const schemaChars = countAllStringChars(args.parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX_BYTES) { ... }
  // P1-F
  if (!Array.isArray(args.allowedTools)) { return "allowedTools must be an array..."; }
  // P1-G
  for (const t of args.allowedTools) {
    if (typeof t !== "string") return `allowedTools entries must be strings`;
    if (!ALL_KNOWN_NON_SKILL_TOOL_NAMES.has(t)) return `unknown tool: ${t}`;
  }
  return null;
}

// 改后
function validateSkillContent(args: {
  promptTemplate: string;
  parameters: unknown;
}): string | null {
  if (args.promptTemplate.length > PROMPT_TEMPLATE_MAX_BYTES) {
    return `promptTemplate too long (max ${PROMPT_TEMPLATE_MAX_BYTES} bytes, got ${args.promptTemplate.length})`;
  }
  if (typeof args.parameters !== "object" || args.parameters === null || Array.isArray(args.parameters)) {
    return "parameters must be a JSON Schema object";
  }
  const schemaChars = countAllStringChars(args.parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX_BYTES) {
    return `parameters schema strings too long (max ${SCHEMA_STRINGS_MAX_BYTES} bytes, got ${schemaChars})`;
  }
  return null;
}
```

同时删除 `import { ALL_KNOWN_NON_SKILL_TOOL_NAMES } from "../tool-names";`（文件顶部第 30 行）。

- [ ] **Step 2: Drop `allowedTools` from `create_skill` schema**

`src/lib/agent/tools/skill-meta.ts` 第 113-147 行：

```ts
// 改前
parameters: {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "promptTemplate", "parameters", "allowedTools"],
  properties: {
    name: { ... },
    description: { ... },
    promptTemplate: { ... },
    parameters: { ... },
    allowedTools: {
      type: "array",
      items: { type: "string" },
      description: "Required whitelist of tool names callable inside this skill's scope. ...",
    },
  },
},

// 改后
parameters: {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "promptTemplate", "parameters"],
  properties: {
    name: { ... },
    description: { ... },
    promptTemplate: { ... },
    parameters: { ... },
  },
},
```

- [ ] **Step 3: Update `create_skill` handler**

第 148-193 行 handler。把对 `validateSkillContent` 的调用更新为不传 `allowedTools`；构造的 SkillDefinition 不带 `allowedTools` / `firstRunConfirmedAt`：

```ts
// 改前 (line ~157-176)
const validationErr = validateSkillContent({
  promptTemplate: a.promptTemplate as string,
  parameters: a.parameters,
  allowedTools: a.allowedTools,
});
if (validationErr) return err(validationErr);

const skill: SkillDefinition = {
  id: generateSkillId(),
  name: (a.name as string).trim(),
  description: (a.description as string).trim(),
  toolSchema: { parameters: a.parameters as Record<string, unknown> },
  promptTemplate: a.promptTemplate as string,
  enabled: true,
  builtIn: false,
  author: "agent",
  createdAt: Date.now(),
  allowedTools: a.allowedTools as string[],
  // firstRunConfirmedAt intentionally undefined — R10 will trigger on first run
};

// 改后
const validationErr = validateSkillContent({
  promptTemplate: a.promptTemplate as string,
  parameters: a.parameters,
});
if (validationErr) return err(validationErr);

const skill: SkillDefinition = {
  id: generateSkillId(),
  name: (a.name as string).trim(),
  description: (a.description as string).trim(),
  toolSchema: { parameters: a.parameters as Record<string, unknown> },
  promptTemplate: a.promptTemplate as string,
  enabled: true,
  builtIn: false,
  author: "agent",
  createdAt: Date.now(),
  // allowedTools / firstRunConfirmedAt removed (#26 — R2/R10 deleted)
};
```

handler 末尾 observation 文字也改：

```ts
// 改前
observation: `skill created: id=${skill.id} name="${skill.name}". Will require first-run confirm before execution.`,
// 改后
observation: `skill created: id=${skill.id} name="${skill.name}". Callable on subsequent turns.`,
```

- [ ] **Step 4: Drop `allowedTools` from `update_skill` schema**

第 195-217 行 patch 字段：

```ts
// 改前
patch: {
  type: "object",
  additionalProperties: false,
  description: "Subset of fields to update. ...",
  properties: {
    description: { type: "string" },
    promptTemplate: { type: "string" },
    parameters: { type: "object" },
    allowedTools: { type: "array", items: { type: "string" } },
  },
},

// 改后
patch: {
  type: "object",
  additionalProperties: false,
  description: "Subset of fields to update. Forbidden fields (id / author / builtIn / createdAt / enabled) are silently ignored if included.",
  properties: {
    description: { type: "string" },
    promptTemplate: { type: "string" },
    parameters: { type: "object" },
  },
},
```

- [ ] **Step 5: Update `update_skill` handler**

第 218-275 行 handler。删除 `if ("allowedTools" in patch) { merged.allowedTools = ... }` 分支；删除 `merged.firstRunConfirmedAt = undefined;` 那一行（P0-C 污染规则的运行时部分；author 改为 'agent' 仍保留）；调用 `validateSkillContent` 时不传 `allowedTools`：

```ts
// 改前
if ("allowedTools" in patch) {
  merged.allowedTools = patch.allowedTools as string[];
}

const validationErr = validateSkillContent({
  promptTemplate: merged.promptTemplate,
  parameters: merged.toolSchema.parameters,
  allowedTools: merged.allowedTools,
});
if (validationErr) return err(validationErr);

merged.author = "agent";
merged.firstRunConfirmedAt = undefined;

// 改后 (allowedTools 分支整段删；validate 不传 allowedTools；firstRunConfirmedAt 那行删)
const validationErr = validateSkillContent({
  promptTemplate: merged.promptTemplate,
  parameters: merged.toolSchema.parameters,
});
if (validationErr) return err(validationErr);

// Author taint propagation preserved (drives SkillsList "AGENT" badge);
// firstRunConfirmedAt no longer cleared (R10 removed).
merged.author = "agent";
```

handler 末尾 observation 文字也改：

```ts
// 改前
observation: `skill updated: id=${merged.id}. author tainted to 'agent'; first-run confirm will be required on next execution.`,
// 改后
observation: `skill updated: id=${merged.id}. author marked 'agent'.`,
```

- [ ] **Step 6: Update / add tests**

打开 `src/lib/agent/tools/skill-meta.test.ts`（若不存在则创建；以现有 vitest pattern 写）：

```ts
import { describe, it, expect, beforeEach } from "vitest";
// ... mock chrome.storage.local in beforeEach ...
import { create_skill, update_skill } from "./skill-meta"; // 实际导出名以源文件为准

describe("create_skill — allowedTools removed (#26)", () => {
  it("accepts a skill without allowedTools", async () => {
    const r = await create_skill.handler({
      name: "n", description: "d", promptTemplate: "p",
      parameters: { type: "object", properties: {} },
    });
    expect(r.success).toBe(true);
  });
  it("ignores allowedTools if passed (additionalProperties:false would reject; schema accepts)", async () => {
    // additionalProperties:false at schema validation; this test ensures
    // the runtime handler does NOT write allowedTools into storage even if
    // some pre-schema injection slipped one through.
    const r = await create_skill.handler({
      name: "n", description: "d", promptTemplate: "p",
      parameters: { type: "object", properties: {} },
      allowedTools: ["click"],
    } as Record<string, unknown>);
    expect(r.success).toBe(true);
    // assert stored skill has no allowedTools
  });
});

describe("update_skill — firstRunConfirmedAt no longer cleared", () => {
  it("does not clear firstRunConfirmedAt on update (R10 removed)", async () => {
    // pre-seed a skill with firstRunConfirmedAt: 12345
    // update its description
    // re-read; firstRunConfirmedAt should be unchanged (or absent if storage doesn't write deprecated field)
    // important: handler must NOT actively SET it to undefined
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm test src/lib/agent/tools/skill-meta.test.ts`
Expected: PASS。

- [ ] **Step 8: Build**

Run: `pnpm build`
Expected: 0 errors。注意：如果 `ALL_KNOWN_NON_SKILL_TOOL_NAMES` 别处仍被引用（如 SkillsList 表单），build 会报 unused import；那个清理在 Task 11 / 13。当前阶段先确认 skill-meta 自身不再 import。

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent/tools/skill-meta.ts src/lib/agent/tools/skill-meta.test.ts
git commit -m "refactor(skill-meta): drop allowedTools from create_skill/update_skill schema (#26)"
```

---

### Task 8: SkillDefinition 字段标 deprecated + storage 不再写入

**Files:**
- Modify: `src/lib/skills/types.ts`
- Modify: `src/lib/skills/storage.ts`

- [ ] **Step 1: Mark fields deprecated**

`src/lib/skills/types.ts`：

```ts
// 改前
  /** Whitelist of tool names callable inside this skill's scope. `null` = no
   *  scope restriction (legacy behavior). Meta tool write path requires a
   *  non-null array (P1-F); read path tolerates null for back-compat. */
  allowedTools?: string[] | null;
  /** ms timestamp of when the user approved the first execution of this skill
   *  after it was authored or last modified by an agent. R10 first-run-confirm
   *  is gated on this field being absent AND author === 'agent'. update_skill
   *  clears this field on every modification (taint propagation defense). */
  firstRunConfirmedAt?: number;

// 改后
  /**
   * @deprecated since 2026-05-06 (issue #26). Field kept for back-compat
   * deserialization of pre-#26 storage data; new code paths neither read
   * nor write it. R2 enforcement was removed alongside the field.
   */
  allowedTools?: string[] | null;
  /**
   * @deprecated since 2026-05-06 (issue #26). R10 first-run-confirm was
   * removed; field kept for back-compat deserialization only.
   */
  firstRunConfirmedAt?: number;
```

- [ ] **Step 2: Stop populating `allowedTools` default in `withSkillDefaults`**

`src/lib/skills/storage.ts` 第 28-35 行：

```ts
// 改前
export function withSkillDefaults(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    author: skill.author ?? "user",
    createdAt: skill.createdAt ?? 0,
    allowedTools: skill.allowedTools === undefined ? null : skill.allowedTools,
  };
}

// 改后
export function withSkillDefaults(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    author: skill.author ?? "user",
    createdAt: skill.createdAt ?? 0,
    // allowedTools / firstRunConfirmedAt no longer defaulted — fields are
    // deprecated as of #26; absence is the new normal.
  };
}
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: 0 errors. TypeScript should accept @deprecated fields silently.

- [ ] **Step 4: Commit**

```bash
git add src/lib/skills/types.ts src/lib/skills/storage.ts
git commit -m "refactor(skills): mark allowedTools/firstRunConfirmedAt deprecated (#26)"
```

---

### Task 9: 删除 `markSkillFirstRun` + `riskOfAllowedTools`

**Files:**
- Modify: `src/lib/skills/storage.ts`
- Modify: `src/lib/skills/index.ts`
- Modify: `src/lib/agent/risk.ts`
- Modify: `src/lib/agent/risk.test.ts`

- [ ] **Step 1: Delete `markSkillFirstRun`**

`src/lib/skills/storage.ts` 第 69-77 行整段删除（注释 + 函数定义）。

- [ ] **Step 2: Remove from barrel re-export**

`src/lib/skills/index.ts` 第 8-14 行：

```ts
// 改前
export {
  listUserSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  getEnabledSkillIds,
  setSkillEnabled,
  withSkillDefaults,
  generateSkillId,
  generateUserSkillId,
  getSkillStorageBytes,
  markSkillFirstRun,
} from "./storage";

// 改后 (markSkillFirstRun 移除)
export {
  listUserSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  getEnabledSkillIds,
  setSkillEnabled,
  withSkillDefaults,
  generateSkillId,
  generateUserSkillId,
  getSkillStorageBytes,
} from "./storage";
```

- [ ] **Step 3: Delete `riskOfAllowedTools`**

`src/lib/agent/risk.ts` 第 364-375 行整段删除（注释 + 函数定义 + `ALWAYS_HIGH_RISK_TOOL_NAMES` 仅服务于该函数则一起删）。

确认 `ALWAYS_HIGH_RISK_TOOL_NAMES` 是否还有别的引用：

```bash
grep -n "ALWAYS_HIGH_RISK_TOOL_NAMES" src/
```

如果只有 `risk.ts` 内部引用，整个常量也删掉。

- [ ] **Step 4: Update risk tests**

`src/lib/agent/risk.test.ts`：

```bash
grep -n "riskOfAllowedTools" src/lib/agent/risk.test.ts
```

删除所有 `riskOfAllowedTools` 测试块。

- [ ] **Step 5: Run tests**

Run: `pnpm test src/lib/agent/risk.test.ts src/lib/skills/`
Expected: PASS — 既有 risk classifier 行为测试不受影响。

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: 0 errors。如果有别处仍 import `markSkillFirstRun` 或 `riskOfAllowedTools`，build 会报 unresolved import；逐个清理。

- [ ] **Step 7: Commit**

```bash
git add src/lib/skills/storage.ts src/lib/skills/index.ts src/lib/agent/risk.ts src/lib/agent/risk.test.ts
git commit -m "refactor(skills,risk): remove markSkillFirstRun + riskOfAllowedTools (dead code, #26)"
```

---

### Task 10: 内置 skill 去 `allowedTools` + 删导入时校验

**Files:**
- Modify: `src/lib/skills/builtin.ts`

- [ ] **Step 1: Remove `allowedTools` from each entry**

`src/lib/skills/builtin.ts` 7 个 BUILT_IN_SKILLS 条目（第 30-322 行）。每个对象字面量删除 `allowedTools: [...]` 那一行（第 32, 76, 115, 158, 199, 241, 321 行）。也删除附近解释 allowedTools 的代码注释（如第 38-42 行 "declares allowedTools — the loop's R2 scope enforcement uses this..."）。

例如第 30-35 行（第一个 skill）：

```ts
// 改前
{
  id: "record_and_replay",
  name: "Record & Replay",
  ...
  allowedTools: null,
  // (some skills declare allowedTools — the loop's R2 scope enforcement uses this
  //  to refuse calls outside the whitelist; null means no scope restriction.)
  ...
},

// 改后 — 同字面量内 allowedTools 行删除；解释 R2 的注释一并删除
{
  id: "record_and_replay",
  name: "Record & Replay",
  ...
  ...
},
```

第 298-305 行 `record_and_replay` skill 的 promptTemplate 内文字 "Decide allowedTools..." / "The user will see an R10 confirm card..." 也需要修改（这是给 LLM 看的指令，不能保留对已删除概念的描述）：

```ts
// 改前 promptTemplate 内片段
3. Decide allowedTools — only the tools actually used in the trace
   (click / type / scroll / select / open_url) plus done / fail.
4. Write a clean Chinese promptTemplate that mirrors the recorded steps
   but substitutes parameters where appropriate. Keep step numbering ("第 N 步：").
5. Call create_skill with: name (short), description (what it does),
   promptTemplate (your rewritten steps), parameters (JSON Schema), and
   allowedTools. The user will see an R10 confirm card with the full
   skill content before it is persisted — that is their review surface.

// 改后
3. Write a clean Chinese promptTemplate that mirrors the recorded steps
   but substitutes parameters where appropriate. Keep step numbering ("第 N 步：").
4. Call create_skill with: name (short), description (what it does),
   promptTemplate (your rewritten steps), parameters (JSON Schema). The
   user will see a confirm card with the full skill content before it is
   persisted — that is their review surface.
```

并把后续步骤编号顺延。

- [ ] **Step 2: Remove import-time `allowedTools` assertion**

`src/lib/skills/builtin.ts` 第 325-350 行整段——`for (const skill of BUILT_IN_SKILLS) { if (skill.builtIn !== true) {...} if (skill.allowedTools !== null && ...) {...} }`——保留 `builtIn === true` 的检查（这是 P0-A regression guard 与 R10 无关），但删掉 `allowedTools` 的两个 for-loop 校验：

```ts
// 改后
for (const skill of BUILT_IN_SKILLS) {
  if (skill.builtIn !== true) {
    throw new Error(
      `[BUILT_IN_SKILLS] skill ${skill.id} is missing builtIn:true — would allow update_skill mutation, breaking P0-A.`,
    );
  }
}
```

同时移除文件顶部第 2 行 `import { ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES } from "@/lib/agent/tool-names";`（不再使用）。

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/lib/skills/builtin.ts
git commit -m "refactor(skills): drop allowedTools from BUILT_IN_SKILLS + import-time check (#26)"
```

---

### Task 11: SkillsList UI 修剪

**Files:**
- Modify: `src/sidepanel/components/SkillsList.tsx`

- [ ] **Step 1: Remove `ALL_KNOWN_NON_SKILL_TOOL_NAMES` import + form state**

`SkillsList.tsx` 第 12 行删除：

```ts
// 删除
import { ALL_KNOWN_NON_SKILL_TOOL_NAMES } from "@/lib/agent/tool-names";
```

第 24-43 行 `SkillFormState` interface 与 `emptyForm` / `formFromSkill` helper 中 `allowedToolsText` 字段 + 默认值 + 迁移逻辑全部删除：

```ts
// 改前
interface SkillFormState {
  editingId?: string;
  editingCreatedAt?: number;
  editingEnabled?: boolean;
  name: string;
  description: string;
  promptTemplate: string;
  parametersText: string;
  allowedToolsText: string;
}

function emptyForm(): SkillFormState {
  return {
    name: "", description: "", promptTemplate: "",
    parametersText: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
    allowedToolsText: "scroll, wait, done, fail",
  };
}

function formFromSkill(skill: SkillDefinition): SkillFormState {
  return {
    editingId: skill.id,
    editingCreatedAt: skill.createdAt ?? 0,
    editingEnabled: skill.enabled,
    name: skill.name,
    description: skill.description,
    promptTemplate: skill.promptTemplate,
    parametersText: JSON.stringify(skill.toolSchema.parameters, null, 2),
    allowedToolsText: (skill.allowedTools ?? []).join(", "),
  };
}

// 改后 — allowedToolsText 字段全部移除
interface SkillFormState {
  editingId?: string;
  editingCreatedAt?: number;
  editingEnabled?: boolean;
  name: string;
  description: string;
  promptTemplate: string;
  parametersText: string;
}

function emptyForm(): SkillFormState {
  return {
    name: "", description: "", promptTemplate: "",
    parametersText: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
  };
}

function formFromSkill(skill: SkillDefinition): SkillFormState {
  return {
    editingId: skill.id,
    editingCreatedAt: skill.createdAt ?? 0,
    editingEnabled: skill.enabled,
    name: skill.name,
    description: skill.description,
    promptTemplate: skill.promptTemplate,
    parametersText: JSON.stringify(skill.toolSchema.parameters, null, 2),
  };
}
```

- [ ] **Step 2: Trim `validateAndBuild`**

第 73-135 行 `validateAndBuild` 函数与 `BuiltSkillFields` interface：

```ts
// 改前
interface BuiltSkillFields {
  name: string; description: string; promptTemplate: string;
  parameters: Record<string, unknown>;
  allowedTools: string[];
}

function validateAndBuild(form: SkillFormState): { ok: true; built: BuiltSkillFields } | { ok: false; error: string } {
  if (!form.name.trim()) { ... }
  // ... existing checks ...

  const allowedTools = form.allowedToolsText.split(/[,\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (allowedTools.length === 0) { return { ok: false, error: "AllowedTools must include at least one tool name (e.g. 'done', 'fail')" }; }
  for (const t of allowedTools) {
    if (!ALL_KNOWN_NON_SKILL_TOOL_NAMES.has(t)) {
      return { ok: false, error: `Unknown tool: '${t}'. Skills cannot reference other skills.` };
    }
  }

  return { ok: true, built: { name: ..., allowedTools } };
}

// 改后
interface BuiltSkillFields {
  name: string; description: string; promptTemplate: string;
  parameters: Record<string, unknown>;
}

function validateAndBuild(form: SkillFormState): { ok: true; built: BuiltSkillFields } | { ok: false; error: string } {
  if (!form.name.trim()) return { ok: false, error: "Name is required" };
  if (!form.description.trim()) return { ok: false, error: "Description is required" };
  if (!form.promptTemplate.trim()) return { ok: false, error: "Prompt template is required" };
  if (form.promptTemplate.length > PROMPT_TEMPLATE_MAX) {
    return { ok: false, error: `Prompt template too long (${form.promptTemplate.length}/${PROMPT_TEMPLATE_MAX} bytes)` };
  }

  let parameters: unknown;
  try { parameters = JSON.parse(form.parametersText); }
  catch (e) { return { ok: false, error: `Parameters JSON parse error: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { ok: false, error: 'Parameters must be a JSON object (e.g. { "type": "object", ... })' };
  }
  const schemaChars = countAllStringChars(parameters);
  if (schemaChars > SCHEMA_STRINGS_MAX) {
    return { ok: false, error: `Parameters schema strings too long (${schemaChars}/${SCHEMA_STRINGS_MAX} bytes)` };
  }

  return {
    ok: true,
    built: {
      name: form.name.trim(),
      description: form.description.trim(),
      promptTemplate: form.promptTemplate,
      parameters: parameters as Record<string, unknown>,
    },
  };
}
```

- [ ] **Step 3: Remove `allowedTools` from `handleSubmit` save path**

第 251-294 行 `handleSubmit`：

```ts
// 改前
const newSkill: SkillDefinition = {
  id: form.editingId ?? generateUserSkillId(),
  name: v.built.name, description: v.built.description,
  toolSchema: { parameters: v.built.parameters },
  promptTemplate: v.built.promptTemplate,
  enabled: form.editingEnabled ?? true,
  builtIn: false, author: "user",
  createdAt: form.editingCreatedAt ?? Date.now(),
  allowedTools: v.built.allowedTools,
  firstRunConfirmedAt: undefined,
};

// 改后
const newSkill: SkillDefinition = {
  id: form.editingId ?? generateUserSkillId(),
  name: v.built.name, description: v.built.description,
  toolSchema: { parameters: v.built.parameters },
  promptTemplate: v.built.promptTemplate,
  enabled: form.editingEnabled ?? true,
  builtIn: false, author: "user",
  createdAt: form.editingCreatedAt ?? Date.now(),
  // allowedTools / firstRunConfirmedAt removed (#26)
};
```

- [ ] **Step 4: Delete first-run-pending UI in `SkillRow`**

第 490-559 行 `SkillRow` 组件。删除：

- 第 492-493 行 `awaitingFirstRun` 派生
- 第 502 行 `awaitingFirstRun ? "border-l-2 border-l-accent pl-[12px]" : ""` 条件 className
- 第 517 行 `{awaitingFirstRun ? "AGENT · NEW" : tag}` 改为 `{tag}`
- 第 532-553 行整段 `{awaitingFirstRun && (...提示卡...)}` 删除

也删除第 494-497 行 `hasScreenshotTool = (skill.allowedTools ?? []).some(...)` 派生与 `showVisionWarning` 提示（已无 allowedTools，无法以静态分析得出 vision 需求；改为运行时由 LLM 自决，UI 不再前置警告）：

```tsx
// 删除整段
const hasScreenshotTool = (skill.allowedTools ?? []).some((t) => t === "capture_visible_tab" || t === "capture_fullpage_tab");
const showVisionWarning = hasScreenshotTool && !supportsVision;
// ...
{showVisionWarning && (<div className="text-fg-3 text-xs mt-1">Screenshot tools in this skill require...</div>)}
```

第 523-530 行 `(skill.allowedTools ?? []).includes("open_url")` 派生的 "Per-call approval" badge 也删除（同理，allowedTools 已不再权威）：

```tsx
// 删除整段
{(skill.allowedTools ?? []).includes("open_url") && (
  <span ... title="Each open_url call requires user approval">Per-call approval</span>
)}
```

第 562-564 行 tool count 显示 `{(skill.allowedTools ?? []).length} tool{...}` 改为只显示 storage size：

```tsx
// 改前
<span className="font-mono text-[10px] text-fg-3">
  {(skill.allowedTools ?? []).length} tool
  {(skill.allowedTools ?? []).length === 1 ? "" : "s"}
  {skill.createdAt && skill.createdAt > 0
    ? ` · ${formatBytes(JSON.stringify(skill).length)}`
    : ""}
</span>

// 改后
<span className="font-mono text-[10px] text-fg-3">
  {skill.createdAt && skill.createdAt > 0
    ? formatBytes(JSON.stringify(skill).length)
    : ""}
</span>
```

- [ ] **Step 5: Remove form input row for `allowedTools`**

`SkillsList.tsx` 内 `SkillForm` 子组件（搜 `allowedToolsText` 找到对应输入控件——大约在 form rendering JSX 内，标签写 "Allowed tools" 的那一段）。

```bash
grep -n "Allowed tools\|allowedToolsText" src/sidepanel/components/SkillsList.tsx
```

把对应 `<label>...<textarea ... value={form.allowedToolsText} ... /></label>` 整段删除。

`supportsVision` prop 现在仅用于 SkillRow 的 `showVisionWarning` 逻辑，已被删——如果 prop 在 SkillRow / parent 之间已无其他用途，连带清理（搜 `supportsVision` 找到剩余引用，删除函数签名 prop 与传入处）。

- [ ] **Step 6: Build + manual smoke**

Run: `pnpm build`
Expected: 0 errors。

Manual: 加载扩展 → Settings → Skills → 点 "新建 skill" → 表单只有 name / description / promptTemplate / parameters；没有 "Allowed tools" 字段。每个 skill 卡片不再显示 first-run badge / Per-call approval / Vision warning / "N tools" 计数。

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/SkillsList.tsx
git commit -m "refactor(SkillsList): remove allowedTools input + first-run badge + derived warnings (#26)"
```

---

### Task 12: AgentConfirmCard 文案与渲染修剪

**Files:**
- Modify: `src/sidepanel/components/AgentConfirmCard.tsx`

- [ ] **Step 1: Remove `allowedToolsUnchanged` 比较与字段渲染**

`AgentConfirmCard.tsx` 第 236-241 行：

```ts
// 删除
const allowedToolsUnchanged =
  isUpdate &&
  existing !== null &&
  JSON.stringify(existing.allowedTools ?? null) === JSON.stringify(eff.allowedTools ?? null);

const allowedTools = eff.allowedTools;
```

第 294-307 行 JSX block 整段删除（`allowedTools` field 渲染——含 unchanged 标签、null/empty/list 三态条件渲染）。

- [ ] **Step 2: Update header copy**

第 245-255 行：

```tsx
// 改前
{isUpdate ? (
  <>
    Updating <code className="font-mono">{existing?.id ?? eff.id}</code>. After
    approval the skill is re-marked as agent-authored and the user will be asked
    to re-confirm on its next execution. Fields tagged "(unchanged)" stay as they were.
  </>
) : (
  <>Creating a new agent-authored skill. The user will be asked to re-confirm on its first execution.</>
)}

// 改后
{isUpdate ? (
  <>
    Updating <code className="font-mono">{existing?.id ?? eff.id}</code>. After
    approval the skill is saved and runs without further confirmation. Fields
    tagged "(unchanged)" stay as they were.
  </>
) : (
  <>Creating a new agent-authored skill. After approval the skill is saved
    and callable on subsequent turns.</>
)}
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/components/AgentConfirmCard.tsx
git commit -m "refactor(AgentConfirmCard): drop allowedTools rendering + update copy (#26)"
```

---

### Task 13: 删除死代码 `ALL_KNOWN_NON_SKILL_TOOL_NAMES` + `ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES`

**Files:**
- Modify: `src/lib/agent/tool-names.ts`

- [ ] **Step 1: 验证已无引用**

```bash
grep -rn "ALL_KNOWN_NON_SKILL_TOOL_NAMES\|ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES" src/
```

预期：经过 Task 7 + 10 + 11 后，唯一匹配应在 `src/lib/agent/tool-names.ts` 自身（定义处）。如有别处残留，先回到对应 task 清理。

- [ ] **Step 2: Delete the two sets**

`src/lib/agent/tool-names.ts` 第 179-220 行，删除两个 `export const` 块（含上方注释）。

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/tool-names.ts
git commit -m "refactor(tool-names): remove dead exports after allowedTools removal (#26)"
```

---

### Task 14: `risk.ts` G-1 gate 注释重写

**Files:**
- Modify: `src/lib/agent/risk.ts`

- [ ] **Step 1: 重写 G-1 gate 头部注释**

`src/lib/agent/risk.ts` 第 397-413 行：

```ts
// 改前
// ── Phase 3 G-1 acceptance gate — build-time exhaustive check ──────────────
//
// The K-3 decision (do not upgrade SkillDefinition.allowedTools schema in v1)
// rests on a load-bearing claim: every cross-tab write tool returns high risk
// every time it's called. If a future PR introduces a low-risk cross-tab
// tool (a "peek_tab_metadata", "read_tab_title", etc.) without first
// upgrading the allowedTools schema to (name, scope) tuple, the K-3 defense
// silently breaks — agent-authored skills could thereafter add the new
// low-risk tool to allowedTools and R10 first-run-confirm would only fire
// once, granting indefinite access.
//
// This block enforces the gate at build time: every name in TAB_TOOL_NAMES
// must be classified as either always-high (write/read tools) or
// args-conditional (the two existing tools whose risk depends on args).
// A new entry that doesn't appear in either set throws at module load —
// the PR introducing it cannot be shipped without consciously updating
// this list, which is the prompt to revisit G-1.

// 改后
// ── Phase 3 G-1 — cross-tab tool classification gate ────────────────────────
//
// Build-time check ensuring every name in TAB_TOOL_NAMES is classified as
// always-high (write tools + always-high reads), args-conditional (risk
// depends on args), or always-low. A new entry that doesn't appear in any
// of the three sets throws at module load.
//
// Historical note: this gate was originally introduced as the K-3 defense
// support for SkillDefinition.allowedTools (issue #26 removed allowedTools
// and R10 first-run-confirm, deprecating the K-3 invariant chain). The
// gate is retained because the underlying property — every new tab tool
// must be consciously classified — is independently valuable: it prevents
// a default-low classification from silently shipping for a write-class
// cross-tab op.
```

注释头改完，下面的 `ALWAYS_HIGH_TAB_TOOLS` / `ARGS_CONDITIONAL_TAB_TOOLS` / `ALWAYS_LOW_TAB_TOOLS` Set 与 for-loop 校验**保留不动**。

- [ ] **Step 2: Update inline `K-3 decision` comments elsewhere**

```bash
grep -n "K-3" src/lib/agent/risk.ts
```

对于第 425-436 行 `ARGS_CONDITIONAL_TAB_TOOLS` / `ALWAYS_LOW_TAB_TOOLS` 注释中提到 K-3 的，改为指向本 phase brainstorm：

```ts
// 改前 (第 432-436 行附近)
// NOTE: G-1 K-3 rationale still holds for this tool — skills that add
// focus_tab to allowedTools will only be granted per-call low-risk focus
// switching, which does not open the K-3 privilege-chain vector (focus_tab
// cannot itself call any tool; it just changes what tab the next snapshot
// targets). No allowedTools schema upgrade needed.

// 改后
// NOTE: focus_tab is always low. Mutates only internal session pointer;
// no tab state, no cross-origin data exposure.
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/risk.ts
git commit -m "docs(risk): rewrite G-1 gate header — K-3 deprecated by #26"
```

---

### Task 15: Cross-layer integration test（**重点**）

**Files:**
- Create: `src/lib/agent/cross-layer.test.ts`（如已存在则追加 describe block）

**目的**：覆盖 wire→DisplayMessage 透传 regression（user memory `feedback_cross_layer_integration_tests.md`）。

- [ ] **Step 1: Locate or create the cross-layer test file**

```bash
ls src/lib/agent/cross-layer*.test.ts 2>/dev/null
```

如已存在追加；若不存在则新建：

```ts
// src/lib/agent/cross-layer.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
// import test helpers / fixtures with same pattern as loop.test.ts

describe("Cross-layer wire → DisplayMessage propagation (#26)", () => {
  beforeEach(() => {
    // mock chrome.storage.local + runtime.connect Port harness
  });

  it("autoApproved=true wire field reaches AgentStepCard render", async () => {
    // 1. seed skipPermissions=true via storage mock
    // 2. drive runAgentLoop with a high-risk click step (mocked snapshot
    //    returns submit button) and a sendConfirmRequest mock returning
    //    {approved: true} (simulating SW short-circuit)
    // 3. capture the agent-step wire message emitted by the loop
    // 4. assert message.autoApproved === true
    // 5. (if rendering layer testable in happy-dom) mount AgentStepCard
    //    with that message and assert "auto-approved by skip-permissions"
    //    text node present
  });

  it("autoApproved is undefined when skipPermissions=false", async () => {
    // setup with skipPermissions=false; trigger high-risk click; user
    // approves via mocked sendConfirmRequest. Assert message.autoApproved
    // is undefined (not false, not true).
  });

  it("agent-authored skill with no firstRunConfirmedAt does NOT trigger an extra confirm-request (R10 removed)", async () => {
    // build SkillDefinition { author: 'agent', firstRunConfirmedAt: undefined };
    // execute one tool call against it; assert sendConfirmRequest spy was
    // called only for the inner tool call's risk gate (if any), never with
    // a riskReason matching /first-run|first execution/i.
  });

  it("toggling skipPermissions mid-task does not affect in-flight steps (snapshot)", async () => {
    // start runAgentLoop with skipPermissions=false snapshot;
    // mid-task, mutate storage to true (simulate user toggle);
    // execute a high-risk step; assert sendConfirmRequest was called
    // (NOT short-circuited — the in-flight task uses the start-time
    // snapshot, not the current storage value).
  });

  it("skill scope freedom — skill A can call skill B (R3 removed)", async () => {
    // register skill A with promptTemplate that triggers calling skill B;
    // assert the loop dispatches skill B without an "Skills cannot call
    // other skills" error observation.
  });

  it("skill scope freedom — call inside skill scope is not whitelist-rejected (R2 removed)", async () => {
    // register a legacy skill { allowedTools: ["click"] }; agent calls
    // "type" inside its scope; assert no "tool 'type' not allowed in skill
    // ... scope" error observation.
  });
});
```

具体实现以 `src/lib/agent/loop.test.ts` 既有 mock pattern + project test fixtures 为模板。如果项目已有 cross-layer 测试 helper (`src/lib/agent/test-helpers.ts` 或类似)，复用之。

- [ ] **Step 2: Run tests**

Run: `pnpm test src/lib/agent/cross-layer.test.ts`
Expected: PASS — 6 tests。

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent/cross-layer.test.ts
git commit -m "test(cross-layer): wire→panel autoApproved + R2/R3/R10 removal regression (#26)"
```

---

### Task 16: 落地文档 + ROADMAP 更新

**Files:**
- Create: `docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Write invariant trace doc**

```markdown
<!-- docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md -->
---
date: 2026-05-06
phase: skill-scope-and-skip-permissions (issue #26)
origin: docs/specs/2026-05-06-skill-scope-and-skip-permissions-requirements.md
plan: docs/plans/2026-05-06-001-feat-skill-scope-and-skip-permissions-plan.md
---

# Skill Scope 解禁 + 全局 skip-permissions toggle — Invariant Trace

## What shipped

- **Change 1**：删除 R2 (allowedTools enforcement) / R3 (skill→skill 禁止) / R10 (first-run-confirm)。
  `SkillDefinition.allowedTools` / `firstRunConfirmedAt` 字段保留为 `@deprecated`
  optional，向后兼容老 storage 反序列化；新写入路径不再携带。
- **Change 2**：新增 `src/lib/skip-permissions.ts` global toggle helper，
  Settings 加 `<SkipPermissionsSection>` + 一次性确认 modal，Chat header 加常驻
  warning banner（订阅 `chrome.storage.onChanged`），SW `sendConfirmRequest`
  在 pre-capture / open_url URL pre-parse 之后短路返回 `{approved: true}` 或
  `{approved: true, screenshotResult}`。
- 新增 wire 字段 `AgentStepMessage.autoApproved?: boolean`，loop 在自动批准 high-risk
  或 screenshot 步骤时携带 `true`，panel `AgentStepCard` 渲染 `auto-approved by
  skip-permissions` 小灰字作事后审计入口。

## Invariants 落地

- **I-1 任务级 snapshot**：`runAgentLoop` 入口读 `isSkipPermissionsEnabled()`
  注入 ctx；mid-task 切 toggle 不影响 in-flight 任务（与 keyboard sim 同语义）。
- **I-2 risk classifier 完整保留**：`classifyRisk` 在 skipPermissions=true 时仍跑、
  仍输出 high/low；只是 high 不再走 panel-bound confirm-request 路径。
- **I-3 untrusted_* wrapper 保留**：page snapshot 进 user role 仍包
  `<untrusted_page_content>`；与 confirm UI 完全正交。
- **I-4 K-9 / R7 server-side 锁保留**：close_tabs locked-pin refusal、cross-session
  pinned-tab lock 不依赖 confirm UI。
- **I-5 author taint propagation 保留**：`update_skill` 仍把 author 改为 'agent'
  （SkillsList 角标依据），不再清空 `firstRunConfirmedAt`（字段已 deprecated）。
- **I-6 K-3 链显式弃用**：`risk.ts` G-1 build-time gate 注释明确指向本 phase；
  gate 代码本身保留，因为"每个新 tab tool 必须显式分类"独立有价值。

## Out of scope（沿用 brainstorm Scope Boundaries）

参见 origin。
```

- [ ] **Step 2: Update docs/ROADMAP.md**

定位"已交付 phases"段，追加：

```markdown
- 2026-05-06 — Skill scope 解禁 + 全局 skip-permissions toggle
  ([#26](https://github.com/.../issues/26),
  [trace](docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md))
```

- [ ] **Step 3: Commit**

```bash
git add docs/solutions/2026-05-06-skill-scope-and-skip-permissions.md docs/ROADMAP.md
git commit -m "docs(solutions): trace skill scope unblock + skip-permissions (#26)"
```

---

### Task 17: 全量验收

**Files:** —

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: PASS — all suites green。任何 fail 回到对应 task 修复。

- [ ] **Step 2: Production build**

Run: `pnpm build`
Expected: 0 errors。所有 build-time invariant（risk.ts G-1 gate / tool-names class registry / builtin.ts builtIn:true 检查）均不爆。

- [ ] **Step 3: Manual browser E2E checklist**

按 origin §Manual browser E2E 全部勾选：

- [ ] 默认状态（skipPermissions=false）：跑 click submit → 弹卡；reject → task 终止
- [ ] Settings 打开 toggle → 一次性 modal → 确认 → toggle 显示 ON
- [ ] Chat header 出现 banner，文字 "⚠ Skip-permissions ON — tool calls auto-approved"
- [ ] 同一 click submit 任务再跑 → 不弹卡，agent-step 卡上看到 `auto-approved by skip-permissions` 小灰字
- [ ] Skill A 内部调 Skill B（手填 promptTemplate 让 LLM 这么做） → 成功执行无 R2/R3 错误
- [ ] Settings 关 toggle → banner 消失 → click submit 又弹卡（确认对称性）
- [ ] 跑任务到一半切换 toggle → in-flight 步骤行为不变
- [ ] 老数据兼容：手动 `chrome.storage.local.set({ skill_legacy_xxx: { id, name, ..., allowedTools: ["click"], firstRunConfirmedAt: 12345 } })` → SkillsList 正常显示该 skill；调用、保存（保存后 storage 中两个 deprecated 字段消失）

- [ ] **Step 4: Open PR / merge**

按现有项目 PR 流程发起。PR 描述链接 origin brainstorm + 本 plan + invariant trace doc。

---

## Self-Review

执行本 plan 之前对照 origin requirements 与本 plan tasks 的最后核对：

**1. Spec coverage（每条 requirement 至少有一个 task 覆盖）**

| Req | 覆盖 task |
|---|---|
| R1.1 删 R2 | Task 6 |
| R1.2 删 R3 | Task 6 |
| R1.3 删 R10 | Task 5 |
| R1.4 字段 deprecated | Task 8 |
| R1.5 schema 移除 allowedTools | Task 7 |
| R1.6 update_skill handler 调整 | Task 7 |
| R1.7 删 markSkillFirstRun | Task 9 |
| R1.8 删 skillExecutionScopeStack | Task 6 |
| R1.9 删 riskOfAllowedTools / G-1 注释 | Task 9 + 14 |
| R1.10 删 dead exports | Task 13 |
| R2.1 新建 skip-permissions.ts | Task 1 |
| R2.2 chat-start snapshot + ctx | Task 4 |
| R2.3 sendConfirmRequest 短路 | Task 4 |
| R2.4 risk classifier 保留 | 无需 task（默认行为；Task 14 显式注释指向） |
| R2.5 autoApproved wire 字段 | Task 5 |
| R2.6 Settings UI | Task 2 |
| R2.7 一次性 modal | Task 2 |
| R2.8 Chat banner | Task 3 |
| R2.9 文案英文 | Task 2 + 3（代码内英文文案） |
| R3.1 SkillsList 表单修剪 | Task 11 |
| R3.2 删 first-run badge | Task 11 |
| R3.3 AgentConfirmCard 文案 | Task 12 |
| R3.4 SkillSlashPopover authorTag 保留 | 无需 task（默认行为） |
| R3.5 builtin.ts 7 个 entry | Task 10 |
| R4.* 留下来的护栏 | 无需 task（默认行为；Task 15 含正向回归） |
| Testing 全部 | Task 1 / 5 / 6 / 7 / 9 / 15 |
| Implementation Surface 顺序 1-14 | Tasks 1-14 |

**2. Placeholder scan**：plan 内无 "TBD" / "TODO" 字样；每步都有具体代码或 grep 命令；每个删除区间有定位 grep 帮助找精确行号（行号会随上面 task 推进而漂移，所以 task 内提供 grep 命令 + 注释/代码块边界双重定位）。

**3. Type consistency**：
- `autoApproved?: boolean`（一致）
- `skipPermissions: boolean` ctx 字段（一致）
- `SkillDefinition.allowedTools?: string[] | null`（保留 optional + nullable）
- `SkillDefinition.firstRunConfirmedAt?: number`（保留 optional）
- `SessionAgentState.skillExecutionScopeStack` 字段从 type 中**移除**（Task 6 Step 4）；snapshot builder 签名同步更新（Task 6 Step 3）

**4. 已知漂移点**：plan 内行号引用全部基于 main 分支当前快照（commit `cf81133`）。Task 之间有些重叠区域——比如 Task 5 + Task 6 都改 loop.ts。建议按 Task 顺序执行，每步 commit 后行号可能漂移；下一 task 用 grep 命令重新定位即可。

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-06-001-feat-skill-scope-and-skip-permissions-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
