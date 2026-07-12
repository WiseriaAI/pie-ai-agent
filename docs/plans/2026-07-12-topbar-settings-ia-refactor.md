# 顶栏 + 设置页 IA 重构 · 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/specs/2026-07-12-topbar-settings-ia-refactor.md`——单栏上下文化顶栏（含 pin 副行）、Settings 混合结构（根页 + 二级页）、Skills 升一级视图、设置入口进抽屉、lucide-react 图标。

**Architecture:** App.tsx 持有 `view + settingsPage` 双状态驱动全局唯一 `TopBar.tsx`（六态变身）；pin 显示子系统从 Chat 抽成 `usePinDisplay` hook；`Settings.tsx`（831 行）拆为 `settings/SettingsRoot.tsx` + `settings/pages/*`，section 组件逻辑零改动纯搬家。

**Tech Stack:** React 19 + TypeScript、TailwindCSS v4、lucide-react（新增）、vitest + @testing-library/react + happy-dom。

## Global Constraints（来自 spec，每个 task 隐含遵守）

- 任何视图任何时刻只有一条顶栏；视图内部不得再渲染自己的 header。
- 图标统一 lucide-react：顶栏 17–18px、列表行 16px、chevron 14px（›）/12px（▾），`strokeWidth={1.75}`。
- 颜色/圆角一律用现有 token（`bg-canvas/surface/field`、`border-line`、`text-fg-1/2/3`、`text-accent`、`rounded-card` 等），不写裸 hex。
- i18n：6 个 locale（en / zh-CN / zh-TW / ja / es-419 / pt-BR）键必须对齐（parity 测试强制）。
- 快捷键不变：Cmd/Ctrl+K 新会话、Cmd/Ctrl+D 抽屉；Esc 走返回栈。
- `theme-mode` 存储语义不变（localStorage + IDB config 双写 + store-bus 同步，逻辑留在 App.tsx）。
- 每个 task 结束：`pnpm test` 相关文件绿 + `pnpm typecheck` 0 错，然后 commit。
- **例外说明**：Task 3 完成后到 Task 6 之间，主题切换暂无 UI 入口（主题仍生效）；Task 6 恢复。这是唯一允许的过渡性缺口。

---

### Task 1: i18n 新键（6 locale）

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`、`zh-CN.ts`、`zh-TW.ts`、`ja.ts`、`es-419.ts`、`pt-BR.ts`
- Test: 现有 `src/lib/i18n/__tests__/dictionary-parity.test.ts`（不改，靠它验证）

**Interfaces:**
- Produces: `t("topbar.back")`、`t("topbar.skills")`、`t("settings.nav.models" | "bridge" | "search" | "experimental" | "feedback" | "preferences")`、`t("settings.nav.configCount", { count })`、`t("settings.nav.bridgeConnected" | "bridgeOff")`、`t("settings.theme.label" | "light" | "dark" | "system")`、`t("settings.language.uiLabel")`。后续所有 task 只用这些键，不再新增。

- [ ] **Step 1: 在 en.ts 加基准键**（en 是 parity 基准，其余 5 locale 同结构同位置加）

```ts
// 顶层新增（与 settings 平级）：
topbar: {
  back: "Back",
  skills: "Skills",
},
// settings 内新增两个子对象 + language 内加一键：
settings: {
  // ...existing keys...
  nav: {
    models: "Model Configs",
    bridge: "Local Bridge",
    search: "Search",
    experimental: "Experimental",
    feedback: "Feedback",
    preferences: "Preferences",
    configCount: "{count} configured",
    bridgeConnected: "Connected",
    bridgeOff: "Not connected",
  },
  theme: { label: "Theme", light: "Light", dark: "Dark", system: "Auto" },
  language: {
    // ...existing sectionTitle / assistantLabel...
    uiLabel: "Interface language",
  },
},
```

- [ ] **Step 2: 其余 5 locale 文案**

| 键 | zh-CN | zh-TW | ja | es-419 | pt-BR |
|---|---|---|---|---|---|
| topbar.back | 返回 | 返回 | 戻る | Volver | Voltar |
| topbar.skills | 技能 | 技能 | スキル | Habilidades | Habilidades |
| nav.models | 模型配置 | 模型配置 | モデル設定 | Configuración de modelos | Configurações de modelo |
| nav.bridge | 本地打通 | 本地打通 | ローカル連携 | Puente local | Ponte local |
| nav.search | 搜索 | 搜尋 | 検索 | Búsqueda | Busca |
| nav.experimental | 实验性功能 | 實驗性功能 | 実験的機能 | Funciones experimentales | Recursos experimentais |
| nav.feedback | 反馈 | 意見回饋 | フィードバック | Comentarios | Feedback |
| nav.preferences | 偏好 | 偏好 | 環境設定 | Preferencias | Preferências |
| nav.configCount | {count} 个配置 | {count} 個配置 | 設定 {count} 件 | {count} configuraciones | {count} configurações |
| nav.bridgeConnected | 已连接 | 已連接 | 接続済み | Conectado | Conectado |
| nav.bridgeOff | 未连接 | 未連接 | 未接続 | Sin conexión | Desconectado |
| theme.label | 主题 | 主題 | テーマ | Tema | Tema |
| theme.light | 亮 | 亮 | ライト | Claro | Claro |
| theme.dark | 暗 | 暗 | ダーク | Oscuro | Escuro |
| theme.system | 自动 | 自動 | 自動 | Auto | Auto |
| language.uiLabel | 界面语言 | 介面語言 | 表示言語 | Idioma de la interfaz | Idioma da interface |

- [ ] **Step 3: 验证 parity + 类型**

Run: `pnpm test src/lib/i18n && pnpm typecheck`
Expected: parity 测试 PASS（键结构 6 locale 一致）、tsc 0 错

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries/
git commit -m "feat(i18n): 顶栏/设置根页/主题控件新键（6 locale）"
```

---

### Task 2: usePinDisplay hook + TopBar 组件（TDD）

**Files:**
- Create: `src/sidepanel/hooks/usePinDisplay.ts`
- Create: `src/sidepanel/components/TopBar.tsx`
- Test: `src/sidepanel/components/TopBar.test.tsx`
- Modify: `package.json`（新增 lucide-react）

**Interfaces:**
- Consumes: Task 1 的 i18n 键；现有 `IconButton`（`./ui/IconButton`）、`Popover`（`./ui/Popover`）、`useAnchorRect`（`./ui/useAnchorRect`）、`PinnedTabDropdown`（`./PinnedTabDropdown`）。
- Produces（后续 task 依赖的精确签名）:

```ts
// TopBar.tsx exports
export type AppView = "agent" | "schedules" | "skills" | "settings";
export type SettingsPage = "root" | "models" | "bridge" | "search" | "experimental" | "feedback";
export interface TopBarProps {
  view: AppView;
  settingsPage: SettingsPage;
  sessionTitle: string;
  pendingCount: number;
  onToggleDrawer: () => void;
  onNewSession: () => void;
  onNavigate: (v: "schedules" | "skills") => void;
  onBack: () => void;
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  pinMode: "auto" | "task" | "user" | null;
  streaming: boolean;
  onTogglePinTab: (tabId: number, origin: string) => void;
  onClearUserPin: () => void;
}
export default function TopBar(props: TopBarProps): JSX.Element;

// usePinDisplay.ts export
export function usePinDisplay(args: {
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  pinMode: "auto" | "task" | "user" | null;
  streaming: boolean;
}): { displayPinnedOrigin: string | null; isLocked: boolean };
```

- [ ] **Step 1: 安装依赖**

Run: `pnpm add lucide-react`
Expected: package.json dependencies 出现 lucide-react

- [ ] **Step 2: 提取 usePinDisplay hook（复制，不动 Chat）**

从 `Chat.tsx` **复制**以下标识符到 `src/sidepanel/hooks/usePinDisplay.ts`，组装成上面签名的 hook（Chat 本体这一步不改，Task 4 再删）：

- state：`livePinnedOrigin` / `livePinnedTitle` / `lockedPinnedTitle`（及其 setState）
- 派生：`isLocked`（`Chat.tsx:486`）、`displayPinnedOrigin`（`Chat.tsx:632-646`）、`sessionPinnedOrigin` / `sessionPinnedTabId`（`Chat.tsx:205-206`）
- effect：live-preview 的 chrome.tabs/windows 监听 effect（`Chat.tsx:488-541`）以及 `lockedPinnedTitle` 的获取 effect（grep `lockedPinnedTitle` 定位）
- 工具函数：`truncate`（60 上限）、`extractOrigin`（`Chat.tsx:2523`）、`extractHost`（grep 定位）——如工具函数被 Chat 其他逻辑共用，则移到 hook 文件并从 Chat import

- [ ] **Step 3: 写 TopBar 失败测试**

```tsx
// src/sidepanel/components/TopBar.test.tsx
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import TopBar, { type TopBarProps } from "./TopBar";

// usePinDisplay 依赖 chrome.tabs — mock 掉，直接控制显示值
vi.mock("@/sidepanel/hooks/usePinDisplay", () => ({
  usePinDisplay: vi.fn(({ pinnedTabs }) => ({
    displayPinnedOrigin: pinnedTabs?.[0]?.origin ?? null,
    isLocked: true,
  })),
}));
vi.mock("./PinnedTabDropdown", () => ({ default: () => <div data-testid="pin-dropdown" /> }));

afterEach(cleanup);

function make(over: Partial<TopBarProps> = {}): TopBarProps {
  return {
    view: "agent", settingsPage: "root", sessionTitle: "测试会话", pendingCount: 0,
    onToggleDrawer: vi.fn(), onNewSession: vi.fn(),
    onNavigate: vi.fn(), onBack: vi.fn(),
    pinnedTabs: null, pinMode: null, streaming: false,
    onTogglePinTab: vi.fn(), onClearUserPin: vi.fn(),
    ...over,
  };
}

describe("TopBar 六态", () => {
  it("chat：渲染抽屉/新会话/schedules/skills 按钮 + 会话标题，无 back", () => {
    const p = make();
    render(<TopBar {...p} />);
    expect(screen.getByTestId("topbar-drawer")).toBeTruthy();
    expect(screen.getByTestId("topbar-new")).toBeTruthy();
    expect(screen.getByText("测试会话")).toBeTruthy();
    expect(screen.getByTestId("topbar-schedules")).toBeTruthy();
    expect(screen.getByTestId("topbar-skills")).toBeTruthy();
    expect(screen.queryByTestId("topbar-back")).toBeNull();
  });

  it("chat：pendingCount>0 显示红点", () => {
    render(<TopBar {...make({ pendingCount: 2 })} />);
    expect(screen.getByTestId("topbar-pending-dot")).toBeTruthy();
  });

  it("schedules：back + schedules 按钮 aria-pressed，无抽屉/新会话", () => {
    render(<TopBar {...make({ view: "schedules" })} />);
    expect(screen.getByTestId("topbar-back")).toBeTruthy();
    expect(screen.getByTestId("topbar-schedules").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("topbar-drawer")).toBeNull();
    expect(screen.queryByTestId("topbar-new")).toBeNull();
  });

  it("skills：skills 按钮 aria-pressed；点 schedules 触发 onNavigate 互切", () => {
    const p = make({ view: "skills" });
    render(<TopBar {...p} />);
    expect(screen.getByTestId("topbar-skills").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("topbar-schedules"));
    expect(p.onNavigate).toHaveBeenCalledWith("schedules");
  });

  it("settings 根页：back + 标题，无 schedules/skills 按钮", () => {
    render(<TopBar {...make({ view: "settings" })} />);
    expect(screen.getByTestId("topbar-back")).toBeTruthy();
    expect(screen.queryByTestId("topbar-schedules")).toBeNull();
    expect(screen.queryByTestId("topbar-skills")).toBeNull();
  });

  it("back 点击触发 onBack", () => {
    const p = make({ view: "settings", settingsPage: "models" });
    render(<TopBar {...p} />);
    fireEvent.click(screen.getByTestId("topbar-back"));
    expect(p.onBack).toHaveBeenCalled();
  });
});

describe("TopBar pin 副行", () => {
  const pinned = [{ tabId: 1, origin: "news.ycombinator.com" }, { tabId: 2, origin: "github.com" }] as const;

  it("chat + pinnedTabs 渲染副行：origin + ×2 计数", () => {
    render(<TopBar {...make({ pinnedTabs: [...pinned], pinMode: "user" })} />);
    expect(screen.getByTestId("topbar-pin-row")).toBeTruthy();
    expect(screen.getByText("news.ycombinator.com")).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
  });

  it("无 pin 不渲染副行；非 chat 视图不渲染副行", () => {
    render(<TopBar {...make()} />);
    expect(screen.queryByTestId("topbar-pin-row")).toBeNull();
    cleanup();
    render(<TopBar {...make({ view: "schedules", pinnedTabs: [...pinned], pinMode: "user" })} />);
    expect(screen.queryByTestId("topbar-pin-row")).toBeNull();
  });

  it("点击副行翻转 aria-expanded", () => {
    render(<TopBar {...make({ pinnedTabs: [...pinned], pinMode: "user" })} />);
    const row = screen.getByTestId("topbar-pin-row");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/TopBar.test.tsx`
Expected: FAIL —— `Cannot find module './TopBar'`

- [ ] **Step 5: 实现 TopBar.tsx**

```tsx
import { useRef, useState } from "react";
import { Menu, Plus, AlarmClock, Zap, ArrowLeft, Pin, Star, ChevronDown } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { Popover } from "./ui/Popover";
import { useAnchorRect } from "./ui/useAnchorRect";
import PinnedTabDropdown from "./PinnedTabDropdown";
import { usePinDisplay } from "@/sidepanel/hooks/usePinDisplay";
import { useT } from "@/lib/i18n";

export type AppView = "agent" | "schedules" | "skills" | "settings";
export type SettingsPage = "root" | "models" | "bridge" | "search" | "experimental" | "feedback";

export interface TopBarProps { /* …按 Interfaces 块的完整定义… */ }

const ICON = { size: 17, strokeWidth: 1.75 } as const;

export default function TopBar({
  view, settingsPage, sessionTitle, pendingCount,
  onToggleDrawer, onNewSession, onNavigate, onBack,
  pinnedTabs, pinMode, streaming, onTogglePinTab, onClearUserPin,
}: TopBarProps) {
  const t = useT();
  const isChat = view === "agent";
  const { displayPinnedOrigin, isLocked } = usePinDisplay({ pinnedTabs, pinMode, streaming });
  const showPinRow = isChat && displayPinnedOrigin !== null;

  const [pinOpen, setPinOpen] = useState(false);
  const pinRowRef = useRef<HTMLButtonElement>(null);
  const pinRect = useAnchorRect(pinRowRef, pinOpen);
  const pinStyle = pinRect
    ? { left: pinRect.left, top: pinRect.bottom + 4, width: pinRect.width }
    : undefined;

  const title = isChat
    ? sessionTitle
    : view === "schedules"
      ? t("schedules.title")
      : view === "skills"
        ? t("topbar.skills")
        : settingsPage === "root"
          ? t("settings.title")
          : t(`settings.nav.${settingsPage}`);

  const showFnButtons = view !== "settings";

  return (
    <div className="z-10 flex flex-shrink-0 flex-col border-b border-line bg-canvas px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        {isChat ? (
          <>
            <div className="relative">
              <IconButton data-testid="topbar-drawer" size="sm" aria-label={t("chat.sessionsAria") ?? "Sessions"}
                icon={<Menu {...ICON} />} onClick={onToggleDrawer} />
              {pendingCount > 0 && (
                <span data-testid="topbar-pending-dot"
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--c-pending)" }} />
              )}
            </div>
            <IconButton data-testid="topbar-new" size="sm" aria-label={t("chat.newSessionAria") ?? "New session"}
              icon={<Plus {...ICON} />} onClick={() => onNewSession()} />
          </>
        ) : (
          <IconButton data-testid="topbar-back" size="sm" aria-label={t("topbar.back")}
            icon={<ArrowLeft {...ICON} />} onClick={onBack} />
        )}
        <span className={`min-w-0 flex-1 truncate select-none text-[13px] text-fg-1 ${isChat ? "font-medium" : "font-semibold"}`}
          title={title}>
          {title}
        </span>
        {showFnButtons && (
          <>
            <IconButton data-testid="topbar-schedules" size="sm" aria-label={t("schedules.title")}
              aria-pressed={view === "schedules"} active={view === "schedules"}
              icon={<AlarmClock {...ICON} />} onClick={() => onNavigate("schedules")} />
            <IconButton data-testid="topbar-skills" size="sm" aria-label={t("topbar.skills")}
              aria-pressed={view === "skills"} active={view === "skills"}
              icon={<Zap {...ICON} />} onClick={() => onNavigate("skills")} />
          </>
        )}
      </div>

      {showPinRow && (
        <>
          <button ref={pinRowRef} type="button" data-testid="topbar-pin-row"
            aria-label={t("chat.pinnedTabSelector")} aria-expanded={pinOpen}
            onClick={() => setPinOpen((v) => !v)}
            className="mt-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-field">
            {pinMode === "user"
              ? <Star size={13} strokeWidth={1.75} className="shrink-0 text-accent" fill="currentColor" />
              : <Pin size={13} strokeWidth={1.75} className={`shrink-0 ${isLocked ? "text-accent" : "text-fg-2"}`}
                  fill={isLocked ? "currentColor" : "none"} />}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2">{displayPinnedOrigin}</span>
            {pinnedTabs && pinnedTabs.length > 1 && (
              <span className="rounded bg-accent-tint px-1 font-mono text-[10px] text-accent">×{pinnedTabs.length}</span>
            )}
            <ChevronDown size={11} strokeWidth={1.75} className="shrink-0 text-fg-3" />
          </button>
          <Popover open={pinOpen && !!pinStyle} style={pinStyle} placement="below" className="fixed z-20">
            <PinnedTabDropdown
              anchorRef={pinRowRef} pinMode={pinMode} pinnedTabs={pinnedTabs} streaming={streaming}
              onToggle={(tabId, origin) => onTogglePinTab(tabId, origin)}
              onClearPin={onClearUserPin} onClose={() => setPinOpen(false)} />
          </Popover>
        </>
      )}
    </div>
  );
}
```

注意：`chat.sessionsAria` / `chat.newSessionAria` 若字典无此键，改用现有 TopBarListButton / TopBarNewSessionButton 里的 aria-label 键（grep 其现有实现照抄）；`PinnedTabDropdown` 的 props 类型以其现有定义为准（`anchorRef` 是 button ref，签名照 `Chat.tsx:1254-1266` 现状）。

- [ ] **Step 6: 跑测试到绿**

Run: `pnpm test src/sidepanel/components/TopBar.test.tsx && pnpm typecheck`
Expected: 全 PASS、0 错

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/sidepanel/hooks/usePinDisplay.ts src/sidepanel/components/TopBar.tsx src/sidepanel/components/TopBar.test.tsx
git commit -m "feat(topbar): 上下文化单栏 TopBar 组件 + usePinDisplay hook（lucide-react）"
```

---

### Task 3: App 接线（view 扩展 / goBack / 深链 / 抽屉设置入口 / 删 TopBar*×5）

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/components/SessionDrawer.tsx`（footer 设置行）
- Delete: `TopBarListButton.tsx` / `TopBarNewSessionButton.tsx` / `TopBarSchedulesButton.tsx` / `TopBarSettingsButton.tsx` / `TopBarThemeButton.tsx`（同名 test 一并删）
- Create: `src/sidepanel/theme.ts`（ThemeMode 类型迁移落脚点）

**Interfaces:**
- Consumes: Task 2 的 `TopBar` / `AppView` / `SettingsPage`。
- Produces: `src/sidepanel/theme.ts` 导出 `export type ThemeMode = "light" | "dark" | "system";`；App 内部 `goBack()`、`settingsPage` state、`openSettings()`（供抽屉）。Task 6/7 依赖 App 已按 `settingsPage` 渲染 settings 分支。

- [ ] **Step 1: ThemeMode 类型迁移**

创建 `src/sidepanel/theme.ts`：`export type ThemeMode = "light" | "dark" | "system";`
App.tsx 的 `import TopBarThemeButton, { type ThemeMode }` 改为 `import type { ThemeMode } from "@/sidepanel/theme"`。grep 全仓 `from "@/sidepanel/components/TopBarThemeButton"` 的其他引用一并改。

- [ ] **Step 2: view 状态扩展 + goBack**

App.tsx 修改（`View` 类型删除，改用 TopBar 导出的类型）：

```tsx
import TopBar, { type AppView, type SettingsPage } from "@/sidepanel/components/TopBar";

const [view, setView] = useState<AppView>("agent");
const [settingsPage, setSettingsPage] = useState<SettingsPage>("root");

const openSettings = useCallback((page: SettingsPage = "root") => {
  setSettingsPage(page);
  setView("settings");
  setDrawerOpen(false);
}, []);

const goBack = useCallback(() => {
  if (view === "settings" && settingsPage !== "root") setSettingsPage("root");
  else setView("agent");
}, [view, settingsPage]);
```

- Esc handler（`App.tsx:325-327`）：`setView("agent")` 改为 `goBack()`。
- firstRun（`App.tsx:137`）：`setView("settings")` 改为 `openSettings()`。
- 深链 consume（`App.tsx:155`）：`setView("settings")` 改为 `openSettings("models")`（过渡期旧 Settings 不认 page，深链靠原 nonce 机制照常工作；Task 7 切换后 page 生效）。
- `handleRunSkill`（`App.tsx:246`）等处 `setView("agent")` 保持。

- [ ] **Step 3: 顶栏 JSX 替换**

删除 `App.tsx:342-402` 的整个顶栏 div 与 5 个 TopBar* import，替换为：

```tsx
<TopBar
  view={view} settingsPage={settingsPage}
  sessionTitle={sessionTitle} pendingCount={pendingCount}
  onToggleDrawer={() => setDrawerOpen((v) => !v)}
  onNewSession={() => void handleNewSession()}
  onNavigate={(v) => setView(view === v ? "agent" : v)}
  onBack={goBack}
  pinnedTabs={session.pinnedTabs} pinMode={session.pinMode ?? null}
  streaming={session.streaming}
  onTogglePinTab={(tabId, origin) => void session.togglePinTab(tabId, origin)}
  onClearUserPin={() => void session.clearUserPin()}
/>
```

主内容区加 `view === "skills"` 分支占位（暂渲染 `null`，Task 5 填充）；`view === "settings"` 分支照旧渲染 `<Settings onBack={goBack} …/>`（过渡态：Settings 自己的 header/tabs 仍在，Task 7 移除）。themeMode 的 state/effect/store-bus 同步逻辑**全部留在 App**，仅删除按钮的渲染。

- [ ] **Step 4: SessionDrawer footer 设置行**

`SessionDrawer.tsx`：props 加 `onOpenSettings: () => void`；在 `<StorageIndicator />`（`SessionDrawer.tsx:444`）**上方**插入：

```tsx
import { Settings as SettingsIcon, ChevronRight } from "lucide-react";

<button
  type="button"
  onClick={onOpenSettings}
  className="flex w-full items-center gap-2.5 border-t border-line px-3.5 py-3 text-left hover:bg-field"
>
  <SettingsIcon size={17} strokeWidth={1.75} className="shrink-0 text-fg-2" />
  <span className="flex-1 text-[13px] font-medium text-fg-1">{t("settings.title")}</span>
  <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-fg-3" />
</button>
```

App 传 `onOpenSettings={() => openSettings()}`。

- [ ] **Step 5: 删 5 个 TopBar* 组件文件及其测试**

Run: `rm src/sidepanel/components/TopBar{ListButton,NewSessionButton,SchedulesButton,SettingsButton,ThemeButton}.tsx` + 对应 `.test.tsx`（存在才删），grep 全仓确认无残留 import。

- [ ] **Step 6: 验证 + Commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿（受影响的旧 TopBar* 测试已随文件删除；其他失败=真回归须修）

```bash
git add -A && git commit -m "feat(app): TopBar 接线 + view 两层栈 + 抽屉设置入口，删旧顶栏按钮组件"
```

---

### Task 4: Chat 删独立 pin bar

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`
- Modify: `src/sidepanel/components/Chat.test.tsx`（如有 pin bar 断言）

**Interfaces:**
- Consumes: TopBar 已渲染 pin 副行（Task 3 接线完成）。
- Produces: Chat 不再渲染任何 pin UI；`pinnedTabIds`/`pageChanged` 提示逻辑保留。

- [ ] **Step 1: 删 pin bar JSX**——`Chat.tsx:1219-1271` 整段（含 Popover + PinnedTabDropdown）。
- [ ] **Step 2: 删 pin 显示子系统内联版**——按 Task 2 Step 2 的同一清单删：`pinDropdownOpen` / `pinBarRef` / `pinAnchorRef`（`Chat.tsx:213-217`）、`pinRect` / `pinDropdownStyle`（`Chat.tsx:448-451`）、`livePinnedOrigin` / `livePinnedTitle` / `lockedPinnedTitle` state、live-preview effect（`488-541`）、`isLocked` / `displayPinnedOrigin` / `truncate`；`extractOrigin` / `extractHost` 若已被 usePinDisplay 收编且 Chat 无其他引用则删，有引用则从 hook 文件 import。**保留** `pinnedTabs` / `pinMode` / `togglePinTab` / `clearUserPin` 解构中仍被其他逻辑（`pinnedTabIds`、发送校验等）使用的部分——以 typecheck 报错为准逐个判断。
- [ ] **Step 3: 验证 + Commit**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx && pnpm typecheck && pnpm build`
Expected: 绿（若 Chat.test 有 pin bar 断言：断言 UI 的删除，断言 toggle/clear 行为的迁到 TopBar.test 补一条）

```bash
git add -A && git commit -m "refactor(chat): 删独立 pin bar，pin 显示归 TopBar 副行"
```

---

### Task 5: Skills 一级视图 + SchedulesPanel 去自有标题

**Files:**
- Modify: `src/sidepanel/App.tsx`（skills 分支）
- Modify: `src/sidepanel/components/Schedules/SchedulesPanel.tsx`（删 title 行）
- Modify: `src/sidepanel/components/Schedules/SchedulesPanel.test.tsx`（如有标题断言）

**Interfaces:**
- Consumes: `SkillsList`（props 仅 `onRunSkill: (skillId: string, skillName: string) => void`）；App 现有 `handleRunSkill`。
- Produces: `view === "skills"` 渲染完整技能管理页。

- [ ] **Step 1: App skills 分支**（替换 Task 3 的占位）：

```tsx
) : view === "skills" ? (
  <div className="flex-1 overflow-y-auto px-4 py-6">
    <SkillsList onRunSkill={(id, name) => void handleRunSkill(id, name)} />
  </div>
) : ...
```

`handleRunSkill` 尾部的 `setView("agent")` 已存在——运行技能自动回 chat ✓。

- [ ] **Step 2: SchedulesPanel 删自己的标题行**——grep `t("schedules.title")`（`SchedulesPanel.tsx:184` 附近）删除标题 JSX（保留「新建」按钮等功能件：若标题与按钮同行，标题文本删、按钮右移或左移到行首）。
- [ ] **Step 3: 验证 + Commit**

Run: `pnpm test src/sidepanel/components/Schedules && pnpm typecheck`
Expected: 绿

```bash
git add -A && git commit -m "feat(skills): 技能升一级视图；schedules 去自有标题（单栏化）"
```

---

### Task 6: SettingsRoot 根页（TDD）

**Files:**
- Create: `src/sidepanel/components/settings/SettingsRoot.tsx`
- Create: `src/sidepanel/components/settings/bridge-status.ts`
- Test: `src/sidepanel/components/settings/SettingsRoot.test.tsx`
- Modify: `src/sidepanel/App.tsx`（settings root 渲染 + themeMode props 下传）

**Interfaces:**
- Consumes: Task 1 键；`listInstances`（`@/lib/instances`）、`getSearchProviderStatus, ACTIVE_SEARCH_PROVIDER`（`@/lib/search-provider`）、`LanguageSelect` / `AssistantLanguageSelect`、`ThemeMode`（`@/sidepanel/theme`）、lucide `Box, Plug, Search, Contrast, Globe, MessageSquare, FlaskConical, MessageCircle, ChevronRight, ChevronDown`。
- Produces:

```ts
// bridge-status.ts
export type BridgeStatus = { hasPermission: boolean; ready: boolean };
export function queryBridgeStatus(cb: (s: BridgeStatus) => void): void; // 实现 = 现 Settings.tsx:552-561 原样搬

// SettingsRoot.tsx
export interface SettingsRootProps {
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
  onOpenPage: (p: Exclude<SettingsPage, "root">) => void;
}
export default function SettingsRoot(props: SettingsRootProps): JSX.Element;
```

- [ ] **Step 1: 失败测试**

```tsx
// SettingsRoot.test.tsx —— mock listInstances 返回 2 条、search status configured:true、
// chrome.runtime.sendMessage 静默；断言：
// 1. 五个下钻行（testid settings-row-models/bridge/search/experimental/feedback），
//    点击 row-models 触发 onOpenPage("models")
// 2. row-models 内出现 badge 文本节点（testid settings-badge-models）
// 3. 主题 segmented 三段（testid theme-light/dark/system），点 theme-light 触发 onThemeModeChange("light")
// 4. LanguageSelect / AssistantLanguageSelect 渲染（mock 成占位组件断存在）
// 5. About footer 含版本号（chrome.runtime.getManifest mock version）
```

（测试代码结构参照 `SettingsTabs.test.tsx` 的 mock 方式：`vi.mock("@/lib/instances", …)` 等。）

Run: `pnpm test src/sidepanel/components/settings/SettingsRoot.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 2: 实现**

```tsx
// SettingsRoot.tsx 骨架（行组件 + 三分组 + footer）：
function NavRow({ id, icon, label, badge, onClick }: {
  id: string; icon: ReactNode; label: string; badge?: ReactNode; onClick: () => void;
}) {
  return (
    <button type="button" data-testid={`settings-row-${id}`} onClick={onClick}
      className="flex h-[46px] w-full items-center gap-3 px-3.5 text-left first:border-t-0 border-t border-line hover:bg-field">
      <span className="shrink-0 text-fg-2">{icon}</span>
      <span className="flex-1 text-[13px] font-medium text-fg-1">{label}</span>
      {badge && <span data-testid={`settings-badge-${id}`} className="text-[12px] text-fg-3">{badge}</span>}
      <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-fg-3" />
    </button>
  );
}
// 分组容器：<div className="overflow-hidden rounded-card border border-line bg-surface">…行…</div>
// 分组间 gap-5；「偏好」分组前加 caps 标签（font-mono text-[10px] tracking-[0.14em] text-fg-3）
// 偏好组：主题行（Contrast 图标 + ThemeSegmented 内联）+ 界面语言行（label + <LanguageSelect/>）+ 助手语言行（label + <AssistantLanguageSelect/>）
//   —— LanguageSelect/AssistantLanguageSelect 保持现组件（占行右侧），行布局用与 NavRow 同构的非按钮 div
// ThemeSegmented（同文件内私有组件）：
//   <div className="flex rounded-lg border border-line bg-field p-0.5 gap-0.5">
//     {(["light","dark","system"] as const).map(m => (
//       <button key={m} data-testid={`theme-${m}`} onClick={() => onThemeModeChange(m)}
//         className={`rounded-md px-2.5 py-0.5 text-[11px] ${themeMode===m ? "bg-canvas font-medium text-fg-1" : "text-fg-2 hover:text-fg-1"}`}>
//         {t(`settings.theme.${m}`)}
//       </button>))}
//   </div>
// badges：
//   models — useEffect 里 listInstances().then(l => setCount(l.length))，t("settings.nav.configCount", { count: String(count) })
//   bridge — queryBridgeStatus 一次；ready ? 绿点+t("settings.nav.bridgeConnected") : t("settings.nav.bridgeOff")（无权限则无 badge）
//   search — getSearchProviderStatus(ACTIVE_SEARCH_PROVIDER).then(s => s.configured && "Tavily")
// About footer：现 Settings.tsx AboutSection JSX 原样搬入（同文件私有组件）
```

- [ ] **Step 3: App 渲染 root**——settings 分支改为（过渡期与旧 Settings 并轨）：

```tsx
) : view === "settings" && settingsPage === "root" ? (
  <div className="flex-1 overflow-y-auto px-4 py-6">
    <SettingsRoot themeMode={themeMode} onThemeModeChange={setThemeMode}
      onOpenPage={(p) => setSettingsPage(p)} />
  </div>
) : view === "settings" ? (
  <Settings onBack={goBack} onRunSkill={…} openSubscribeNonce={subscribeNonce} />  /* Task 7 替换 */
) : ...
```

- [ ] **Step 4: 跑测试到绿 + Commit**

Run: `pnpm test src/sidepanel/components/settings && pnpm typecheck`

```bash
git add -A && git commit -m "feat(settings): 根页 SettingsRoot——三分组列表 + 主题 segmented + badge"
```

---

### Task 7: 二级页搬家 + 删 Settings.tsx

**Files:**
- Create: `src/sidepanel/components/settings/pages/ModelsPage.tsx` / `BridgePage.tsx` / `ExperimentalPage.tsx` / `FeedbackPage.tsx`
- Create: `src/sidepanel/components/ui/Switch.tsx`（从 Settings.tsx 抽出，Bridge/Experimental 共用）
- Modify: `src/sidepanel/App.tsx`（settings 子页渲染映射；删 Settings import）
- Modify: `src/sidepanel/components/Settings.localbridge.test.tsx`（import 路径）
- Delete: `src/sidepanel/components/Settings.tsx`、`src/sidepanel/components/__tests__/SettingsTabs.test.tsx`
- Create: `src/sidepanel/components/settings/pages/pages.test.tsx`
- Modify: 6 个 locale 字典（删 `settings.tabs`）

**Interfaces:**
- Consumes: Task 6 的 `SettingsPage` 渲染骨架、`bridge-status.ts`。
- Produces: 每页默认导出无 props 组件，除 `ModelsPage`：`export default function ModelsPage({ openSubscribeNonce }: { openSubscribeNonce?: number }): JSX.Element`；`BridgePage.tsx` 具名导出 `LocalBridgeSection`（兼容测试）。

- [ ] **Step 1: 机械搬家**（逻辑零改动，只挪文件 + 改 import）：
  - `ModelsPage.tsx` ← Settings.tsx 的全部 configs 状态与 handlers（`instances/expandedId/showWizard/testResult/testingIds/providerPools/providerMetas/customProviderNames`、`reload/handleCreate/handleSaveEdit/handleDelete/handleTest/draftProviderMeta/maskKey`）+ configs tab JSX（`Settings.tsx:209-354`）+ `openSubscribeNonce → setShowWizard(true)` effect
  - `BridgePage.tsx` ← `LocalBridgeSection`（`Settings.tsx:603-772`）+ `queryLocalAgents/queryGrants/queryAudit`（`queryBridgeStatus` 改 import 自 `../bridge-status`）；页组件 `export default function BridgePage() { return <LocalBridgeSection />; }` + `export { LocalBridgeSection }`
  - `ExperimentalPage.tsx` ← `CdpInputSection` + `cdpInput` state + `isCdpInputEnabled/setCdpInputEnabled` 接线（`Settings.tsx:60,91,367-370,502-546`）
  - `FeedbackPage.tsx` ← `FeedbackSection`（`Settings.tsx:434-500`）+ 页内自取 `listInstances`
  - `ui/Switch.tsx` ← `Settings.tsx:774-798`，Bridge/Experimental 改 import
- [ ] **Step 2: App settings 渲染映射**（替换 Task 6 的过渡分支；`SearchProviderSection` 直接复用不建新文件）：

```tsx
) : view === "settings" ? (
  <div key={settingsPage} className="view-enter flex-1 overflow-y-auto px-4 py-6">
    {settingsPage === "root" ? (
      <SettingsRoot themeMode={themeMode} onThemeModeChange={setThemeMode}
        onOpenPage={(p) => setSettingsPage(p)} />
    ) : settingsPage === "models" ? <ModelsPage openSubscribeNonce={subscribeNonce} />
      : settingsPage === "bridge" ? <BridgePage />
      : settingsPage === "search" ? <SearchProviderSection />
      : settingsPage === "experimental" ? <ExperimentalPage />
      : <FeedbackPage />}
  </div>
) : ...
```

- [ ] **Step 3: 深链验证逻辑**——`openSettings("models")`（Task 3 已埋）+ ModelsPage 的 nonce effect = 深链直落模型配置页并展开 wizard。手动 grep `openSubscribeNonce` 全链路确认无断点。
- [ ] **Step 4: 测试跟进**——`Settings.localbridge.test.tsx` 的 `import ... from "../Settings"` 改 `from "./settings/pages/BridgePage"`（按实际相对路径）；删 `SettingsTabs.test.tsx`；新建 `pages.test.tsx`：断言 ExperimentalPage 渲染 `role="switch"`（原 SettingsTabs 测试的意图迁移）+ ModelsPage 空列表渲染「新建配置」按钮（mock 同原 SettingsTabs.test 的 mock 集）。
- [ ] **Step 5: 删除**——`rm src/sidepanel/components/Settings.tsx src/sidepanel/components/__tests__/SettingsTabs.test.tsx`；6 locale 删 `settings.tabs` 行；grep `settings.tabs` / `from "./Settings"` / `from "../Settings"` 全仓零残留。
- [ ] **Step 6: 验证 + Commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿（parity 测试确认 tabs 键 6 locale 同步删除）

```bash
git add -A && git commit -m "refactor(settings): 二级页拆分搬家，删 Settings 容器与 4-tab 结构"
```

---

### Task 8: 收尾验证

**Files:** 无新增（只验证与微调）

- [ ] **Step 1: 全量门禁**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿；build 产物 dist/ 正常

- [ ] **Step 2: 死代码扫描**

Run: `grep -rn "TopBarListButton\|TopBarNewSessionButton\|TopBarSchedulesButton\|TopBarSettingsButton\|TopBarThemeButton\|SegmentedTabs\|settings.tabs" src/ | grep -v test`
Expected: 零输出

- [ ] **Step 3: 真机验收清单**（`pnpm build` 后 chrome://extensions 刷新，亮暗双主题各过一遍）：
  1. chat 顶栏：抽屉/新会话/标题/⏰/⚡；pending 红点
  2. pin：钉 1 个 tab → 副行出现；钉 2 个 → ×2；点副行 → dropdown 开合、toggle/clear 生效；无 pin → 单行
  3. schedules ↔ skills 顶栏互切；back/Esc 回 chat
  4. 抽屉底部设置行 → 设置根页；badge（配置数/桥状态/Tavily）正确
  5. 根页五行下钻 + back 回根页 + 再 back 回 chat；Esc 同路径
  6. 主题三段切换即时生效且持久；界面/助手语言切换正常
  7. 深链：pie.chat Subscribe → 直落模型配置页 wizard（managed 模式）
  8. Cmd-K / Cmd-D 各视图可用；技能列表「运行」→ 回 chat 且 composer 预填 /slug
  9. 首次安装 firstRun → 落设置根页

- [ ] **Step 4: 按 `superpowers:finishing-a-development-branch` 收尾**（PR 到 main，`gh auth switch --user WiseriaAI`）

---

## Self-Review 记录

- **Spec 覆盖**：spec §1 导航模型→Task 3；§2 顶栏+pin 副行→Task 2/3/4；§3 根页/二级页→Task 6/7；§4 图标→Task 2/3/6（范围内全换）；§5 规格→各 task 类名；§6 影响面全部有对应 task；§7 验收→Task 8 清单逐条映射；§8 non-goals 未越界。
- **占位符**：Task 2 Step 5 的 props 注释「按 Interfaces 块的完整定义」指向同 task 内的完整签名，非悬空引用；SettingsRoot Step 2 以带类名的骨架+行为清单给出（搬家型代码源文件行号已标注）。
- **类型一致性**：`AppView`/`SettingsPage`/`ThemeMode`/`BridgeStatus`/`usePinDisplay` 签名在 Task 2/3/6 间一致；`onNavigate` 参数收窄为 `"schedules" | "skills"` 与 App 侧调用一致。
