# Provider 配置 UI 重构（dropdown 选择）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页「新建配置」从「provider 长列表两步向导」改成「单页 dropdown 选择」，并把 custom provider 的新建/编辑/删除入口收进该 dropdown。

**Architecture:** 新增 `ProviderDropdown`（popover + 搜索 + 内置/自定义分组 + 项内 ✎/🗑 + 底部新建）与受控的 `CustomProviderFields`（name/baseUrl/测试连接）。`NewConfigWizard` 重写为单页：顶部 `ProviderDropdown`，custom 可编辑时插入 `CustomProviderFields`，下方复用 `InstanceForm`（新增 `hideProviderField` 开关隐藏其自带的只读 provider 字段）。新建 custom 走「原子 `saveCustomProvider` → `createInstance`」，model 统一经 `ModelDropdown`。删除 `Settings.tsx` 独立 custom 管理区与整屏 `CustomProviderForm`。

**Tech Stack:** React 19 + TS, TailwindCSS v4, vitest + happy-dom + @testing-library/react, chrome.storage.local。

**Spec:** `docs/specs/2026-06-04-provider-dropdown-restructure-design.md`

---

## 文件结构

**新建：**
- `src/sidepanel/components/ProviderDropdown.tsx` — provider 选择 popover（展示 + 回调，无 storage 副作用）
- `src/sidepanel/components/ProviderDropdown.test.tsx` — 组件测试
- `src/sidepanel/components/CustomProviderFields.tsx` — 受控的 custom provider 字段（name/baseUrl/测试连接），无 header/footer/model 列表
- `src/sidepanel/components/CustomProviderFields.test.tsx` — 组件测试

**修改：**
- `src/sidepanel/components/InstanceForm.tsx` — 加 `hideProviderField?: boolean`，true 时不渲染自带 provider Field（`:118-127`）
- `src/sidepanel/components/NewConfigWizard.tsx` — 重写为单页，删 `step`/`showCustomForm`，接入 ProviderDropdown + CustomProviderFields
- `src/sidepanel/components/Settings.tsx` — 删除独立 custom 管理区（`:335-379`）及 `showCustomProviderForm`/`editingCustomProvider` state、`CustomProviderForm` 挂载/import
- `src/lib/i18n/dictionaries/en.ts` + `zh-CN.ts` — 加 `providerDropdown.*`；清理废弃 `newConfigWizard.*` / `customProvider.*` key（中英同步）

**删除：**
- `src/sidepanel/components/CustomProviderForm.tsx`（整屏组件，逻辑下沉到 CustomProviderFields + ModelDropdown）

**不动：** `ModelDropdown.tsx`、`ModelMetaEditor.tsx`、`instances.ts`、`custom-providers.ts`、`registry.ts`、edit-instance 流程的 provider 只读约束。

**关键常量：** new custom 态尚无 provider id，给 `InstanceForm`/`ModelDropdown` 传 sentinel ref `DRAFT_CUSTOM_REF = "custom:__draft__"`（以 `CUSTOM_PREFIX` 开头 → `registryModels=[]`，model 全走 `fetchedModels`/`customModels` 本地态）。在 `NewConfigWizard.tsx` 内定义。

---

## Task 1: `ProviderDropdown` 组件

纯展示 + 回调组件，无 storage 副作用，易测。视觉复用 `ModelDropdown` 语言。

**Files:**
- Create: `src/sidepanel/components/ProviderDropdown.tsx`
- Test: `src/sidepanel/components/ProviderDropdown.test.tsx`

接口：

```ts
import type { ProviderRef } from "@/lib/model-router";
import type { ProviderMeta } from "@/lib/model-router/providers/registry";
import type { StoredCustomProvider } from "@/lib/custom-providers";

interface Props {
  value: ProviderRef | null;
  builtinProviders: ProviderMeta[];      // 调用方已按显示名排序
  customProviders: StoredCustomProvider[];
  onSelect: (ref: ProviderRef) => void;
  onCreateCustom: () => void;
  onEditCustom: (cp: StoredCustomProvider) => void;
  onDeleteCustom: (cp: StoredCustomProvider) => void;
}
```

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/ProviderDropdown.test.tsx
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import ProviderDropdown from "./ProviderDropdown";
import type { ProviderMeta } from "@/lib/model-router/providers/registry";
import type { StoredCustomProvider } from "@/lib/custom-providers";

const BUILTINS = [
  { id: "anthropic", name: "Anthropic", defaultBaseUrl: "https://api.anthropic.com", placeholder: "", models: [] },
  { id: "openai", name: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", placeholder: "", models: [] },
] as unknown as ProviderMeta[];

const CUSTOM: StoredCustomProvider = {
  id: "cp1", name: "My Proxy", baseUrl: "https://proxy.test/v1", models: [], createdAt: 0, updatedAt: 0,
};

function setup(overrides: Partial<React.ComponentProps<typeof ProviderDropdown>> = {}) {
  const props = {
    value: null,
    builtinProviders: BUILTINS,
    customProviders: [CUSTOM],
    onSelect: vi.fn(),
    onCreateCustom: vi.fn(),
    onEditCustom: vi.fn(),
    onDeleteCustom: vi.fn(),
    ...overrides,
  };
  render(<ProviderDropdown {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("ProviderDropdown", () => {
  it("opens popover and lists builtin + custom providers", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("My Proxy")).toBeTruthy();
  });

  it("filters by search query", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "anthro" } });
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.queryByText("OpenAI")).toBeFalsy();
  });

  it("fires onSelect with builtin id", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("OpenAI"));
    expect(p.onSelect).toHaveBeenCalledWith("openai");
  });

  it("fires onSelect with custom: ref when selecting a custom provider", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("My Proxy"));
    expect(p.onSelect).toHaveBeenCalledWith("custom:cp1");
  });

  it("fires onEditCustom / onDeleteCustom from per-item buttons", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByRole("button", { name: /edit provider/i }));
    expect(p.onEditCustom).toHaveBeenCalledWith(CUSTOM);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i })); // reopen
    fireEvent.click(screen.getByRole("button", { name: /delete provider/i }));
    expect(p.onDeleteCustom).toHaveBeenCalledWith(CUSTOM);
  });

  it("fires onCreateCustom from footer", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText(/new custom provider/i));
    expect(p.onCreateCustom).toHaveBeenCalled();
  });

  it("trigger shows selected provider name", () => {
    setup({ value: "anthropic" });
    expect(screen.getByText("Anthropic")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ProviderDropdown.test.tsx`
Expected: FAIL（模块不存在 / 找不到组件）

- [ ] **Step 3: 实现组件**

实现要点（参照 `ModelDropdown.tsx` 的 popover 结构与 class）：
- `useState` 管理 `open` 与 `query`；关闭时清空 query（同 ModelDropdown `:41-43`）。
- Trigger `<button>`：`aria-label` 用 `t("providerDropdown.selectProvider")`，显示当前选中名（builtin 查 `builtinProviders.find`、custom 查 `customProviders.find`，未选显示 placeholder）。
- Popover 自上而下：
  1. 搜索框 `<input>`，`placeholder={t("providerDropdown.searchPlaceholder")}`，`autoFocus`。
  2. `── 内置 ──` 分组标题（`t("providerDropdown.builtinGroup")`）+ 过滤后的 builtin 列表，每项 `<button onClick={() => { onSelect(p.id); setOpen(false); }}>` 显示名 + 右侧 baseUrl（`p.defaultBaseUrl.replace(/^https?:\/\//, "")`）。
  3. custom 非空时 `── 自定义 ──` 分组标题（`t("providerDropdown.customGroup")`）+ 列表，每项：名字 button（`onSelect("custom:"+cp.id)`）+ 右侧两个小 `<button>`：
     - `aria-label={t("providerDropdown.editProvider")}`，`onClick={(e)=>{e.stopPropagation(); onEditCustom(cp); setOpen(false);}}`，文案 `✎`
     - `aria-label={t("providerDropdown.deleteProvider")}`，`onClick={(e)=>{e.stopPropagation(); onDeleteCustom(cp);}}`，文案 `🗑`
  4. 底部固定 `<button onClick={() => { onCreateCustom(); setOpen(false); }}>` = `t("providerDropdown.newCustomProvider")`。
- 过滤：`query` 对 builtin 的「显示名 + baseUrl」、custom 的「name + baseUrl」做大小写不敏感子串匹配。
- 用 `CUSTOM_PREFIX` from `@/lib/custom-providers` 拼 `custom:` ref（不要硬编码字符串）。

i18n（Task 6 会补，但本 task 先在两份字典加 `providerDropdown` 块，避免 `t()` 返回 key 字符串导致测试 selector 失配）：

```ts
// en.ts —— 顶层加
providerDropdown: {
  selectProvider: "Select provider",
  searchPlaceholder: "Search provider...",
  builtinGroup: "BUILT-IN",
  customGroup: "CUSTOM",
  editProvider: "Edit provider",
  deleteProvider: "Delete provider",
  newCustomProvider: "+ New custom provider",
},
```
```ts
// zh-CN.ts —— 顶层加
providerDropdown: {
  selectProvider: "选择 Provider",
  searchPlaceholder: "搜索 Provider...",
  builtinGroup: "内置",
  customGroup: "自定义",
  editProvider: "编辑 Provider",
  deleteProvider: "删除 Provider",
  newCustomProvider: "+ 新建自定义 Provider",
},
```

> i18n 类型：`src/lib/i18n/types.ts` 若是从 `en` 字典推导（`typeof enDict`）则无需手改类型；若是显式 interface，需同步加 `providerDropdown` 形状。实现前先确认 `types.ts` 的方式。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ProviderDropdown.test.tsx`
Expected: PASS（7 测试）

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ProviderDropdown.tsx src/sidepanel/components/ProviderDropdown.test.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(settings): add ProviderDropdown component"
```

---

## Task 2: `InstanceForm` 加 `hideProviderField`

让父组件（NewConfigWizard）隐藏 InstanceForm 自带的只读 provider Field，因为 provider 改由 ProviderDropdown 管理。edit-instance 流程不传该 prop，保持现状。

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`（Props 加 `hideProviderField?: boolean`；包裹 `:118-127` 的 provider `<Field>`）
- Test: `src/sidepanel/components/InstanceForm.test.tsx`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `InstanceForm.test.tsx` 的 `describe` 内追加：

```tsx
it("hides provider field when hideProviderField is set", () => {
  render(
    <InstanceForm
      mode="create"
      provider="anthropic"
      initialNickname="Anthropic"
      hideProviderField
      onSave={() => {}}
      onTest={() => {}}
    />,
  );
  // The PROVIDER field label must be gone
  expect(screen.queryByText(/^PROVIDER$/)).toBeFalsy();
  expect(screen.queryByText(/LOCKED/)).toBeFalsy();
});

it("still renders provider field by default (edit-instance unchanged)", () => {
  render(
    <InstanceForm
      mode="create"
      provider="anthropic"
      initialNickname="Anthropic"
      onSave={() => {}}
      onTest={() => {}}
    />,
  );
  expect(screen.getByText(/LOCKED/)).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx`
Expected: FAIL（hideProviderField 用例：LOCKED 仍出现）

- [ ] **Step 3: 实现**

`InstanceForm.tsx` Props interface 加：
```ts
  /** When true, hides the built-in read-only provider field.
   *  Used by NewConfigWizard where provider is managed by ProviderDropdown above. */
  hideProviderField?: boolean;
```
把 `:118-127` 的 provider `<Field label={t("instanceForm.provider")} ...>...</Field>` 用 `{!props.hideProviderField && ( ... )}` 包裹。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx`
Expected: PASS（原 5 + 新 2 = 7 测试）

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstanceForm.test.tsx
git commit -m "feat(settings): InstanceForm hideProviderField option"
```

---

## Task 3: `CustomProviderFields` 受控组件

从 `CustomProviderForm` 下沉出「name / baseUrl / 测试连接」三件套，做成受控、无副作用、无 model 列表、无整屏 header/footer 的内联组件。供 NewConfigWizard 在 new/edit custom 态插入。

**Files:**
- Create: `src/sidepanel/components/CustomProviderFields.tsx`
- Test: `src/sidepanel/components/CustomProviderFields.test.tsx`

接口：

```ts
interface Props {
  name: string;
  baseUrl: string;
  onNameChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onTest: () => void;            // 父组件负责 fetchOpenAICompatModels → fetchedModels
  testing?: boolean;
  testError?: string | null;
  /** 编辑已存 provider 时，显示「被 N 个配置共用」提示（N>0 时）。 */
  dependentCount?: number;
  /** 编辑已存 provider 时显示「删除此 Provider」按钮；新建态省略。 */
  onDelete?: () => void;
  deleteDisabled?: boolean;      // dependentCount>0 时禁用
}
```

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/CustomProviderFields.test.tsx
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import CustomProviderFields from "./CustomProviderFields";

afterEach(() => cleanup());

function setup(overrides = {}) {
  const props = {
    name: "", baseUrl: "",
    onNameChange: vi.fn(), onBaseUrlChange: vi.fn(), onTest: vi.fn(),
    ...overrides,
  };
  render(<CustomProviderFields {...props} />);
  return props;
}

describe("CustomProviderFields", () => {
  it("renders name + baseUrl inputs and a test button", () => {
    setup();
    expect(screen.getByPlaceholderText(/my custom provider/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/api\.example\.com/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /test connection/i })).toBeTruthy();
  });

  it("fires onNameChange / onBaseUrlChange", () => {
    const p = setup();
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy" } });
    expect(p.onNameChange).toHaveBeenCalledWith("Proxy");
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), { target: { value: "https://x/v1" } });
    expect(p.onBaseUrlChange).toHaveBeenCalledWith("https://x/v1");
  });

  it("fires onTest", () => {
    const p = setup({ baseUrl: "https://x/v1" });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(p.onTest).toHaveBeenCalled();
  });

  it("shows test error", () => {
    setup({ testError: "boom" });
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it("shows dependent-count notice and disables delete when in use", () => {
    const p = setup({ dependentCount: 2, onDelete: vi.fn(), deleteDisabled: true });
    expect(screen.getByText(/2/)).toBeTruthy();
    const del = screen.getByRole("button", { name: /delete this provider/i });
    fireEvent.click(del);
    expect(p.onDelete).not.toHaveBeenCalled(); // disabled
  });

  it("fires onDelete when enabled", () => {
    const p = setup({ dependentCount: 0, onDelete: vi.fn(), deleteDisabled: false });
    fireEvent.click(screen.getByRole("button", { name: /delete this provider/i }));
    expect(p.onDelete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/CustomProviderFields.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

参照 `CustomProviderForm.tsx:259-309` 的字段标记与 class，但做成受控、无内部 state：
- name `<input>`：`value={props.name}` `onChange={e=>props.onNameChange(e.target.value)}`，`maxLength={40}`，placeholder `t("customProvider.namePlaceholder")`。
- baseUrl `<input>`：受控，placeholder `t("customProvider.baseUrlPlaceholder")`，下方 hint（`customProvider.baseUrlHint` / `baseUrlWarning`）。HTTP 明文警告逻辑可复用 `CustomProviderForm.tsx:200-218` 的 `showHttpWarning`（基于 `props.baseUrl` 计算）。
- 测试连接 `<button onClick={props.onTest}>`：`disabled` 当 `props.testing || !/^https?:\/\//.test(props.baseUrl)`；文案 `props.testing ? t("customProvider.testing") : t("customProvider.testConnection")`。
- `props.testError` 非空时渲染告警行。
- `props.dependentCount` 与 `props.onDelete`：仅当 `onDelete` 传入时渲染「删除此 Provider」按钮（`aria-label` = `t("customProvider.deleteThisProvider")`），`disabled={props.deleteDisabled}`；`dependentCount > 0` 时上方渲染 `t("customProvider.sharedBy", { count })` 提示。

新增 i18n key（en / zh-CN 同步，加进现有 `customProvider` 块）：
```ts
// en.ts customProvider 块内追加
deleteThisProvider: "Delete this provider",
sharedBy: "Shared by {count} config(s) — editing affects all",
inUseCannotDelete: "In use by {count} config(s) — delete those first",
```
```ts
// zh-CN.ts customProvider 块内追加
deleteThisProvider: "删除此 Provider",
sharedBy: "被 {count} 个配置共用 — 修改将影响全部",
inUseCannotDelete: "被 {count} 个配置使用 — 请先删除这些配置",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/CustomProviderFields.test.tsx`
Expected: PASS（6 测试）

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/CustomProviderFields.tsx src/sidepanel/components/CustomProviderFields.test.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(settings): add controlled CustomProviderFields"
```

---

## Task 4: `NewConfigWizard` 单页化 — builtin 路径

重写 `NewConfigWizard` 为单页，先打通 builtin provider 的新建（含 OpenRouter pre-fetch）。custom 新建/编辑/删除留到 Task 5（本 task 中 ProviderDropdown 的 custom 回调可先接 stub，但渲染已存 custom 列表项）。

**Files:**
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`（整体重写）
- Test: `src/sidepanel/components/NewConfigWizard.test.tsx`（新建）

**结构（重写后）：**
```
<div>                              // 容器
  <ProviderDropdown ... />         // 顶部，始终渲染
  {customMode !== "none" && <CustomProviderFields ... />}   // Task 5 接入
  {provider && (
    <InstanceForm hideProviderField provider={effectiveRef} ... renderActions={...} />
  )}
  {!provider && <div>{t("newConfigWizard.pickProviderHint")}</div>}
</div>
```

**State（重写后）：**
- 保留：`provider`（`ProviderRef | null`）、`customProviders`、`pool`、`metas`、`fetchedModels`/`fetchedAt`/`isFetching`、provider 选中 effect（`:57-84` 逻辑照搬，OpenRouter pre-fetch 不变）。
- 删除：`step`、`showCustomForm`。
- 新增（Task 5 用）：`customMode: "none" | "new" | "edit"`、`draftName`、`draftBaseUrl`、`draftModels: string[]`、`draftMetas: Record<string, StoredCustomModelMeta>`、`testing`、`testError`、`customFetched: ModelMeta[]`。

**builtin 选中流程：** `onSelect(ref)` → `setCustomMode("none")` → `setProvider(ref)`；其余 effect 自动拉 pool/metas、OpenRouter pre-fetch。`metaName`/`cpId`/回调分流逻辑沿用原 `:167-255`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/NewConfigWizard.test.tsx
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import NewConfigWizard from "./NewConfigWizard";

// custom-providers reads chrome.storage; stub list to empty for builtin-only tests
vi.mock("@/lib/custom-providers", async (orig) => {
  const actual = await orig<typeof import("@/lib/custom-providers")>();
  return { ...actual, listCustomProviders: vi.fn(async () => []) };
});

afterEach(() => cleanup());

describe("NewConfigWizard (builtin path)", () => {
  it("renders provider dropdown, no step-1 long list", () => {
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    // dropdown trigger present
    expect(screen.getByRole("button", { name: /select provider/i })).toBeTruthy();
    // pick-provider hint shown before selection
    expect(screen.queryByText(/api key/i)).toBeFalsy();
  });

  it("selecting a builtin provider reveals the instance form", async () => {
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    await waitFor(() => expect(screen.getAllByLabelText(/api key/i).length).toBeGreaterThan(0));
    // provider field hidden (managed by dropdown) — no LOCKED chip
    expect(screen.queryByText(/LOCKED/)).toBeFalsy();
  });

  it("creates a builtin instance with payload", async () => {
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText("Anthropic"));
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find((e) => e.tagName === "INPUT")!;
    fireEvent.change(keyInput, { target: { value: "sk-ant-x" } });
    // type a model via ModelDropdown is heavy; instead assert create wiring by selecting a registry model
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    fireEvent.click(screen.getAllByText(/claude/i)[0]);
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(onCreate).toHaveBeenCalledWith("anthropic", expect.objectContaining({ apiKey: "sk-ant-x" }));
  });
});
```

> 注：第 3 个测试依赖 Anthropic 在 registry 有 model。执行前用 `grep -A3 'id: "anthropic"' src/lib/model-router/providers/registry.ts` 确认有 model id 含 "claude"；若 model selector 的 aria-label 文案不同，按实际 `modelDropdown.selectModelPlaceholder` 调整 selector。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/NewConfigWizard.test.tsx`
Expected: FAIL（旧实现仍是两步列表，无 `select provider` 按钮）

- [ ] **Step 3: 重写 NewConfigWizard（builtin 部分）**

- 顶部渲染 `<ProviderDropdown value={provider} builtinProviders={sortedProviders} customProviders={customProviders} onSelect={handleSelect} onCreateCustom={...stub...} onEditCustom={...stub...} onDeleteCustom={...stub...} />`（custom 回调 Task 5 实现，本 task 可先设为打开 customMode 的占位，但**不要**留空函数注释占位——接最小可用实现：`onCreateCustom={() => { setCustomMode("new"); setProvider(DRAFT_CUSTOM_REF); }}` 等，完整逻辑 Task 5 补）。
- `handleSelect(ref)`: `setCustomMode("none"); setProvider(ref);`。
- `sortedProviders` 沿用原 `:87-93`。
- provider 选定时渲染 `<InstanceForm hideProviderField mode="create" provider={provider} ... />`，props 与回调照搬原 `:186-291`（`initialNickname={metaName}`、`onAddCustomModel`/`onUpdateCustomModelMeta`/`onRemoveCustomModel`/`onRefreshModels` 分流逻辑不变），`renderActions` 保留 取消 / 测试 / 创建 三按钮，**删除**「← 更改 Provider」按钮（换 provider 用 dropdown）。
- `provider === null` 时渲染 `t("newConfigWizard.pickProviderHint")` 占位 + 底部「取消」按钮。
- 定义 `const DRAFT_CUSTOM_REF = "custom:__draft__";`（Task 5 用）。
- `metaName` 计算：custom draft（`provider===DRAFT_CUSTOM_REF`）时用 `draftName || t("newConfigWizard.newCustomProvider")`；其余沿用原逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/NewConfigWizard.test.tsx`
Expected: PASS（3 测试）

- [ ] **Step 5: 全量回归 + 提交**

```bash
pnpm test src/sidepanel/components/  # 确保 InstanceForm/ModelDropdown/ProviderDropdown 不回归
git add src/sidepanel/components/NewConfigWizard.tsx src/sidepanel/components/NewConfigWizard.test.tsx
git commit -m "feat(settings): single-page NewConfigWizard with ProviderDropdown (builtin path)"
```

---

## Task 5: `NewConfigWizard` custom 新建（原子）/ 编辑 / 删除

接通 custom provider 三态。

**Files:**
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`
- Test: `src/sidepanel/components/NewConfigWizard.test.tsx`（追加 custom 用例）

**三态行为：**

- **新建（`onCreateCustom`）**：`setCustomMode("new")`；`setProvider(DRAFT_CUSTOM_REF)`；清空 `draftName/draftBaseUrl/draftModels/draftMetas/customFetched/testError`。渲染 `<CustomProviderFields name={draftName} baseUrl={draftBaseUrl} onTest={handleCustomTest} testing testError />`（无 `onDelete`）。InstanceForm 以 `provider={DRAFT_CUSTOM_REF}` 渲染；其 model 来源 = `customFetched`（fetchedModels）+ `draftModels`（customModels）；`onAddCustomModel`/`onRemove` 改 **本地** `draftModels/draftMetas`（不落盘）。
- **编辑（`onEditCustom(cp)`）**：`setCustomMode("edit")`；`setProvider("custom:"+cp.id)`；`setDraftName(cp.name)`；`setDraftBaseUrl(cp.baseUrl)`。渲染 CustomProviderFields（预填 + `dependentCount` + `onDelete`）。InstanceForm 以真实 `custom:<id>` 渲染，model 增删走**已存** custom 回调（`addCustomProviderModel` 等，原 `:199-239` 的 `cpId` 分支）。name/baseUrl 改动 → 失焦或保存时 `updateCustomProvider`。
- **删除（`onDeleteCustom(cp)`）**：先 `getInstancesUsingCustomProvider(cp.id)`；>0 则 `alert(t("customProvider.inUseCannotDelete",{count}))` 不删；=0 则 `await deleteCustomProvider(cp.id)` → 刷新 `customProviders`，若当前 `provider==="custom:"+cp.id` 则 `setProvider(null)`、`setCustomMode("none")`。

**原子创建（关键）：** `handleCreate` 包一层 —— NewConfigWizard 内部新增 `handleSubmit(payload)`：
```ts
async function handleSubmit(payload: InstanceFormPayload) {
  if (customMode === "new") {
    // 1. 落 provider 实体：把 draftModels/draftMetas 组装成 CustomModelMeta[]
    const models: CustomModelMeta[] = draftModels.map((id) => {
      const m = draftMetas[id];
      return { id, displayName: m?.displayName, vision: m?.vision ?? false, tools: true,
               maxContextTokens: m?.maxContextTokens ?? DEFAULT_CUSTOM_MODEL_MAX_CONTEXT };
    });
    const newId = await saveCustomProvider({ name: draftName.trim(), baseUrl: draftBaseUrl.trim(), models });
    // 2. 用真实 ref 建 instance
    props.onCreate(`${CUSTOM_PREFIX}${newId}`, payload);
  } else {
    props.onCreate(provider!, payload);  // builtin 或已存 custom
  }
}
```
InstanceForm 的 `onSave` 改接 `handleSubmit`。`renderActions` 的「创建」按钮的 `canSave` 在 new custom 态需追加校验：`draftName.trim() && /^https?:\/\//.test(draftBaseUrl)`（否则禁用）。

**`handleCustomTest`（测试连接 → fetchedModels）：**
```ts
async function handleCustomTest() {
  const url = draftBaseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) return;
  setTesting(true); setTestError(null);
  try {
    const list = await fetchOpenAICompatModels(url);  // CustomModelMeta[]
    setCustomFetched(list.map((m) => ({ id: m.id, vision: m.vision, tools: m.tools, maxContextTokens: m.maxContextTokens, displayName: m.displayName })));
  } catch (e) {
    setTestError(e instanceof Error ? e.message : "Connection failed");
  } finally { setTesting(false); }
}
```
（编辑已存 custom 态同样可调，对该 provider 的 baseUrl 测试，结果喂 InstanceForm 的 fetchedModels。）

import 追加：`fetchOpenAICompatModels` from `@/lib/openai-compat-models-fetch`；`saveCustomProvider`/`updateCustomProvider`/`deleteCustomProvider`/`getInstancesUsingCustomProvider`/`type CustomModelMeta` from `@/lib/custom-providers`；`DEFAULT_CUSTOM_MODEL_MAX_CONTEXT` from `@/lib/provider-custom-model-meta`。

InstanceForm 的 `fetchedModels` prop：new custom 态传 `customFetched`；edit custom 态传 `customFetched`（若测过）否则不传（InstanceForm 内部对已存 custom 用 `meta.models`，`:64-67`）；builtin 态传 OpenRouter `fetchedModels`（原逻辑）。

- [ ] **Step 1: 写失败测试**

```tsx
// 追加到 NewConfigWizard.test.tsx
import * as cp from "@/lib/custom-providers";

describe("NewConfigWizard (custom path)", () => {
  it("new custom: atomic saveCustomProvider then onCreate with custom ref", async () => {
    const saveSpy = vi.spyOn(cp, "saveCustomProvider").mockResolvedValue("newid");
    const onCreate = vi.fn();
    render(<NewConfigWizard onCreate={onCreate} onCancel={vi.fn()} onTest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    fireEvent.click(screen.getByText(/new custom provider/i));
    // fill name + baseUrl
    fireEvent.change(screen.getByPlaceholderText(/my custom provider/i), { target: { value: "Proxy" } });
    fireEvent.change(screen.getByPlaceholderText(/api\.example\.com/i), { target: { value: "https://proxy/v1" } });
    // add a model via ModelDropdown footer "+ add custom model" → ModelMetaEditor
    fireEvent.click(screen.getByRole("button", { name: /select model/i }));
    fireEvent.click(screen.getByText(/add custom model/i));
    fireEvent.change(screen.getByPlaceholderText(/gpt-4o-mini/i), { target: { value: "my-model" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    // fill api key
    const keyInput = (await screen.findAllByLabelText(/api key/i)).find((e) => e.tagName === "INPUT")!;
    fireEvent.change(keyInput, { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "Proxy", baseUrl: "https://proxy/v1" })));
    expect(onCreate).toHaveBeenCalledWith("custom:newid", expect.objectContaining({ apiKey: "sk-x", model: "my-model" }));
  });

  it("delete custom: blocks when instances depend on it", async () => {
    vi.spyOn(cp, "listCustomProviders").mockResolvedValue([
      { id: "cp1", name: "Proxy", baseUrl: "https://p/v1", models: [], createdAt: 0, updatedAt: 0 },
    ]);
    vi.spyOn(cp, "getInstancesUsingCustomProvider").mockResolvedValue([{ id: "i1", nickname: "x", model: "m" }]);
    const delSpy = vi.spyOn(cp, "deleteCustomProvider").mockResolvedValue();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<NewConfigWizard onCreate={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    await screen.findByRole("button", { name: /select provider/i });
    fireEvent.click(screen.getByRole("button", { name: /select provider/i }));
    await screen.findByText("Proxy");
    fireEvent.click(screen.getByRole("button", { name: /delete provider/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(delSpy).not.toHaveBeenCalled();
  });
});
```

> 测试用例较重，依赖 ModelDropdown 与 ModelMetaEditor 的真实交互文案。执行时若 selector 文案不符，按实际 i18n 调整；保持断言核心（`saveCustomProvider` 先于 `onCreate("custom:newid", ...)`、删除依赖拦截）不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/NewConfigWizard.test.tsx`
Expected: FAIL（custom 路径未实现）

- [ ] **Step 3: 实现 custom 三态**

按上文「三态行为 / 原子创建 / handleCustomTest」实现。`onAddCustomModel`/`onUpdateCustomModelMeta`/`onRemoveCustomModel` 在 `customMode==="new"` 时改本地 draft；`"edit"` 与 builtin 沿用原 `cpId`/`builtinProvider` 分支。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/NewConfigWizard.test.tsx`
Expected: PASS（builtin 3 + custom 2 = 5 测试）

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/NewConfigWizard.tsx src/sidepanel/components/NewConfigWizard.test.tsx
git commit -m "feat(settings): custom provider create/edit/delete via dropdown"
```

---

## Task 6: 删除 Settings 独立管理区 + 删 CustomProviderForm + i18n 清理

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`
- Delete: `src/sidepanel/components/CustomProviderForm.tsx`
- Modify: `src/lib/i18n/dictionaries/en.ts` + `zh-CN.ts`

- [ ] **Step 1: 删除 Settings 独立 custom 管理区**

- 删除 `Settings.tsx:335-379` 整个 `{customProviders.length > 0 && (<section>...)</section>}` 块。
- 删除 state：`showCustomProviderForm`、`editingCustomProvider`（`:58-59`）及所有引用。
- 删除 `CustomProviderForm` 的 import（`:33`）与其整屏挂载（搜索 `showCustomProviderForm` 的渲染分支并删除）。
- `customProviders` / `customProviderCounts` state 与 `reload()` 里的相关填充：`customProviders` 仍被…… 确认是否还有消费者。`NewConfigWizard` 自己 `listCustomProviders`，Settings 不再需要向它传。若 Settings 中 `customProviders`/`customProviderCounts` 再无消费者，一并删除其 state 与 `reload()` 中的填充（`:75-83`）。用 `grep -n 'customProviders\|customProviderCounts\|deleteCustomProvider\|getInstancesUsingCustomProvider' src/sidepanel/components/Settings.tsx` 核对后删净。

- [ ] **Step 2: 删除 CustomProviderForm 组件**

```bash
git rm src/sidepanel/components/CustomProviderForm.tsx
grep -rn "CustomProviderForm" src/   # 必须为空
```
若 grep 有残留 import，删除之。

- [ ] **Step 3: i18n 清理（中英同步）**

- 删除 `newConfigWizard.step1Title` / `step2Title` / `changeProvider`（不再用）；保留 `newCustomProvider` / `create`；新增 `pickProviderHint`（en: `"Select a provider to begin"`，zh: `"先选择一个 Provider"`）；`customProviders` key（`:217`）若无引用则删。
- `customProvider` 块：保留 CustomProviderFields 复用的 `name/namePlaceholder/baseUrl/baseUrlPlaceholder/baseUrlHint/baseUrlWarning/baseUrlWarningHttp/testing/testConnection` + Task 3 新增的 `deleteThisProvider/sharedBy/inUseCannotDelete`；删除仅 CustomProviderForm 用过的 `back/newCustomProvider/importModels/connectedModels/importSelected/models/noModels/editModel/deleteModel/addModel/saving/save/forget`（**先 grep 确认无其他引用再删**：`grep -rn 'customProvider\.\(back\|importModels\|forget\)' src/`）。
- `settings.customProviders` 块（en `:57-63`）：管理区删除后若无引用则删，中英同步。
- ⚠️ 谨慎：`ModelMetaEditor` / `ModelDropdown` 可能复用部分 `customProvider.*` key（如 `modelIdPlaceholder`/`vision`/`tools`/`maxContextTokens`/`advanced`）。**删任何 key 前必须 `grep -rn "customProvider.<key>" src/` 确认零引用。**

- [ ] **Step 4: 验证编译与测试**

Run:
```bash
pnpm typecheck
pnpm test
```
Expected: typecheck 0 错；全部测试 PASS（删 key 若漏引用，typecheck 或测试会报）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(settings): drop standalone custom-provider manager + CustomProviderForm; i18n cleanup"
```

---

## Task 7: 全量验证 + 手测清单

**Files:** 无（验证 task）

- [ ] **Step 1: 全量自动化门禁**

Run:
```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 测试全过；typecheck 0 错；build 成功（manifest/tools invariant 不 throw）。

- [ ] **Step 2: 加载扩展手测（用户执行）**

`pnpm dev` → `chrome://extensions` Load unpacked `dist/` → 打开 side panel → Settings → My Configs：
- [ ] 新建配置：dropdown 列出全部 builtin（搜索可过滤）+ 已存 custom；选 Anthropic → 填 key → 选 model → 创建成功。
- [ ] 选 OpenRouter → model dropdown 自动 pre-fetch（无需手填 key 即可拉公共列表）。
- [ ] dropdown「+ 新建自定义 Provider」→ 内联填 name/baseUrl → 测试连接拉到 model → 选/加 model → 填 key → 创建：custom provider 与 instance 均落盘，dropdown「自定义」分组出现该 provider。
- [ ] dropdown 自定义项 ✎ → 改 baseUrl → 反映到 updateCustomProvider；项 🗑 对「无 instance 引用」可删，对「有引用」弹拦截提示。
- [ ] 编辑现有 instance（InstancesList 展开）：provider 仍只读、不能换 provider（回归未破）。

- [ ] **Step 3: 完成分支**

调用 `superpowers:finishing-a-development-branch` 决定合并/PR。

---

## Self-Review 结果

- **Spec coverage**：① 单页化→Task4；② ProviderDropdown→Task1；③ provider 三态→Task2(hide)+Task3(fields)+Task5(接线)；④ model 统一 fetchedModels→Task5 handleCustomTest；⑤ 删管理区/CustomProviderForm→Task6；范围边界（不碰 registry/instances/edit-instance 只读）→各 task 已遵守。✅ 全覆盖。
- **Placeholder**：custom 回调在 Task4 要求接最小可用实现而非空占位；i18n 删除均要求先 grep。无 TBD。✅
- **类型一致**：`DRAFT_CUSTOM_REF`、`CustomModelMeta`、`StoredCustomModelMeta`、`fetchOpenAICompatModels`、`saveCustomProvider`/`updateCustomProvider`/`deleteCustomProvider`/`getInstancesUsingCustomProvider`、`hideProviderField`、`CustomProviderFields` props 跨 task 一致。✅
- **风险点**：Task5 的 UI 集成测试 selector 依赖 ModelDropdown/ModelMetaEditor 文案，已注明「断言核心不变、selector 按实际调整」。i18n 删除均设 grep 前置门禁。
