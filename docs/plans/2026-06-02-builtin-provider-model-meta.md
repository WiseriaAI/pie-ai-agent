# Builtin Provider 自定义模型属性编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 builtin provider 新增的自定义模型能配 `vision` + `maxContextTokens`，圆环/图片上传/窗口预算正确生效，对齐 custom provider 体验。

**Architecture:** 旁路 `pcmm_${provider}` 存储表挂属性（现有 `string[]` id 池不动 → 零迁移）；`resolveModelMeta` 查找加一层 pcmm（预置优先）；抽出共用 `<ModelMetaEditor>`，「+添加」和铅笔都打开它；`tools` 不暴露（构造 ModelMeta 时恒 true）。

**Tech Stack:** TypeScript 6, React 19, vitest + happy-dom + @testing-library/react, chrome.storage.local。

**Spec:** `docs/specs/2026-06-02-builtin-provider-model-meta.md`

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/lib/provider-custom-model-meta.ts`（新） | pcmm CRUD + `DEFAULT_CUSTOM_MODEL_MAX_CONTEXT` 常量 + `StoredCustomModelMeta` 类型 |
| `src/lib/model-router/providers/registry.ts`（改） | `resolveModelMeta` builtin 分支加 pcmm 查询 |
| `src/sidepanel/components/ModelMetaEditor.tsx`（新） | 从 CustomProviderForm 抽出的模型属性编辑 modal，`showTools` 控制 tools 字段 |
| `src/sidepanel/components/CustomProviderForm.tsx`（改） | 复用 ModelMetaEditor；默认 256K |
| `src/sidepanel/components/ModelDropdown.tsx`（改） | 「+添加」/铅笔打开 modal；`customModelMetas` prop；vision badge；新回调 |
| `src/sidepanel/components/InstanceForm.tsx`（改） | 透传 meta + `customModelMetas` + `onUpdateCustomMeta` |
| `src/sidepanel/components/Settings.tsx`（改） | 加载 pcmm；回调写 pcm+pcmm；删连带 pcmm |
| `src/sidepanel/components/NewConfigWizard.tsx`（改） | 同 Settings |
| `src/sidepanel/components/Chat.tsx`（改） | vision 用 `resolveModelMeta` 结果回退 |
| `CLAUDE.md`（改） | Project Structure 增条目 |

---

## Task 1: pcmm 存储模块

**Files:**
- Create: `src/lib/provider-custom-model-meta.ts`
- Test: `src/lib/provider-custom-model-meta.test.ts`

参考现有 `src/lib/provider-custom-models.ts`（同款 per-provider `chrome.storage.local` 模式）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/provider-custom-model-meta.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getProviderCustomModelMetas,
  getProviderCustomModelMeta,
  setProviderCustomModelMeta,
  removeProviderCustomModelMeta,
  DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
} from "./provider-custom-model-meta";

// In-memory chrome.storage.local mock (happy-dom 不带 chrome)
beforeEach(() => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (obj: Record<string, unknown>) => { Object.assign(store, obj); },
      },
    },
  });
});

describe("provider-custom-model-meta", () => {
  it("default max context is 256k", () => {
    expect(DEFAULT_CUSTOM_MODEL_MAX_CONTEXT).toBe(256_000);
  });

  it("empty get returns {}", async () => {
    expect(await getProviderCustomModelMetas("minimax")).toEqual({});
    expect(await getProviderCustomModelMeta("minimax", "x")).toBeUndefined();
  });

  it("set then get round-trips, scoped per provider", async () => {
    await setProviderCustomModelMeta("minimax", "MiniMax-X", { vision: true, maxContextTokens: 1_000_000 });
    expect(await getProviderCustomModelMeta("minimax", "MiniMax-X")).toEqual({ vision: true, maxContextTokens: 1_000_000 });
    // 不同 provider 隔离
    expect(await getProviderCustomModelMeta("mimo", "MiniMax-X")).toBeUndefined();
  });

  it("remove deletes the entry only", async () => {
    await setProviderCustomModelMeta("minimax", "a", { vision: false, maxContextTokens: 256_000 });
    await setProviderCustomModelMeta("minimax", "b", { vision: true, maxContextTokens: 256_000 });
    await removeProviderCustomModelMeta("minimax", "a");
    expect(await getProviderCustomModelMeta("minimax", "a")).toBeUndefined();
    expect(await getProviderCustomModelMeta("minimax", "b")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm test src/lib/provider-custom-model-meta.test.ts`
Expected: FAIL，`Cannot find module './provider-custom-model-meta'`

- [ ] **Step 3: 实现模块**

```ts
// src/lib/provider-custom-model-meta.ts
import type { Provider } from "@/lib/model-router";

/**
 * 旁路属性表：给 builtin provider 的自定义模型挂 vision / maxContextTokens。
 * 现有 `pcm_${provider}`（provider-custom-models.ts）只存 model id；本表是
 * id-keyed 的属性层，二者独立。删模型时两边都要清（见 Settings/Wizard 接线）。
 *
 * 不存 `tools`：loop 对所有 provider 无条件发 tools，该 flag 只是 dropdown
 * 展示用；builtin 自定义模型不暴露 tools 配置，构造 ModelMeta 时恒 true。
 */
export interface StoredCustomModelMeta {
  displayName?: string;
  vision: boolean;
  maxContextTokens: number;
}

export const DEFAULT_CUSTOM_MODEL_MAX_CONTEXT = 256_000;

const KEY = (provider: Provider) => `pcmm_${provider}`;

export async function getProviderCustomModelMetas(
  provider: Provider,
): Promise<Record<string, StoredCustomModelMeta>> {
  const r = await chrome.storage.local.get(KEY(provider));
  return { ...((r[KEY(provider)] as Record<string, StoredCustomModelMeta>) ?? {}) };
}

export async function getProviderCustomModelMeta(
  provider: Provider,
  modelId: string,
): Promise<StoredCustomModelMeta | undefined> {
  return (await getProviderCustomModelMetas(provider))[modelId];
}

export async function setProviderCustomModelMeta(
  provider: Provider,
  modelId: string,
  meta: StoredCustomModelMeta,
): Promise<void> {
  const all = await getProviderCustomModelMetas(provider);
  all[modelId] = meta;
  await chrome.storage.local.set({ [KEY(provider)]: all });
}

export async function removeProviderCustomModelMeta(
  provider: Provider,
  modelId: string,
): Promise<void> {
  const all = await getProviderCustomModelMetas(provider);
  if (!(modelId in all)) return;
  delete all[modelId];
  await chrome.storage.local.set({ [KEY(provider)]: all });
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm test src/lib/provider-custom-model-meta.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/provider-custom-model-meta.ts src/lib/provider-custom-model-meta.test.ts
git commit -m "feat(model-meta): pcmm sidecar store for builtin custom-model attributes" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: resolveModelMeta 读 pcmm

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts`（`resolveModelMeta`，约 181-198）
- Test: `src/lib/model-router/providers/registry.test.ts`

- [ ] **Step 1: 写失败测试**（加到 registry.test.ts，用同款 chrome mock）

```ts
// 在 registry.test.ts 顶部确保有 chrome.storage.local mock（参考 Task 1 beforeEach）。
// 若文件已有 mock，复用之。

import { setProviderCustomModelMeta } from "@/lib/provider-custom-model-meta";

describe("resolveModelMeta + pcmm", () => {
  it("builtin custom id resolves from pcmm with tools forced true", async () => {
    await setProviderCustomModelMeta("minimax", "MiniMax-Future", { vision: true, maxContextTokens: 1_000_000 });
    const meta = await resolveModelMeta("minimax", "MiniMax-Future");
    expect(meta).toMatchObject({ id: "MiniMax-Future", vision: true, tools: true, maxContextTokens: 1_000_000 });
  });

  it("registry preset wins over pcmm (preset not overridable)", async () => {
    // MiniMax-M3 是预置（registry maxContextTokens 1_000_000, vision true）
    await setProviderCustomModelMeta("minimax", "MiniMax-M3", { vision: false, maxContextTokens: 1 });
    const meta = await resolveModelMeta("minimax", "MiniMax-M3");
    expect(meta?.maxContextTokens).toBe(1_000_000); // 预置值，非 pcmm 的 1
    expect(meta?.vision).toBe(true);
  });

  it("unknown id with no pcmm returns null", async () => {
    expect(await resolveModelMeta("minimax", "no-such-model")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts -t pcmm`
Expected: FAIL（第一个用例得 null，因 resolveModelMeta 还没查 pcmm）

- [ ] **Step 3: 改 resolveModelMeta**

在 `registry.ts` 顶部加 import：

```ts
import { getProviderCustomModelMeta } from "@/lib/provider-custom-model-meta";
```

把 builtin 分支改成（registry miss 后查 pcmm）：

```ts
export async function resolveModelMeta(ref: ProviderRef, modelId: string): Promise<ModelMeta | null> {
  // Builtin: registry preset first (preset wins, not overridable)
  if (!ref.startsWith("custom:")) {
    const hit = getModelMeta(ref as BuiltinProvider, modelId);
    if (hit) return hit;
    // Then user-set sidecar meta (pcmm). tools is not user-configurable for
    // builtin custom models — forced true (loop always sends tools anyway).
    const stored = await getProviderCustomModelMeta(ref, modelId);
    if (stored) {
      return {
        id: modelId,
        ...(stored.displayName ? { displayName: stored.displayName } : {}),
        vision: stored.vision,
        tools: true,
        maxContextTokens: stored.maxContextTokens,
      };
    }
    return null;
  }

  // Custom provider models (unchanged)
  const id = ref.slice("custom:".length);
  const cp = await getCustomProvider(id);
  if (!cp) return null;
  return cp.models.find((m) => m.id === modelId) ?? null;
}
```

> 注：`ref` 在 builtin 分支是 `Provider` 字符串（如 `"minimax"`），`getProviderCustomModelMeta` 接受 `Provider`，类型兼容。

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: PASS（含原有用例不回归）

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts
git commit -m "feat(model-meta): resolveModelMeta reads pcmm for builtin custom models" -m "Preset wins over pcmm; tools forced true. Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 抽出 ModelMetaEditor 组件

**Files:**
- Create: `src/sidepanel/components/ModelMetaEditor.tsx`
- Modify: `src/sidepanel/components/CustomProviderForm.tsx`（删 inline modal，改用新组件；默认 256K）
- Test: `src/sidepanel/components/__tests__/ModelMetaEditor.test.tsx`

源：现有 inline modal 在 `CustomProviderForm.tsx:431-546`，`EditingModel` 类型与 `openAddModel`/`openEditModel`/`saveEditingModel` 在 `CustomProviderForm.tsx:22-145`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/__tests__/ModelMetaEditor.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelMetaEditor from "../ModelMetaEditor";

describe("ModelMetaEditor", () => {
  it("hides tools field when showTools=false", () => {
    render(<ModelMetaEditor showTools={false} onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText(/advanced/i)); // 展开 Advanced
    expect(screen.queryByText(/tools/i)).toBeNull();
    expect(screen.getByText(/vision/i)).toBeTruthy();
  });

  it("shows tools field when showTools=true (custom provider parity)", () => {
    render(<ModelMetaEditor showTools onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText(/advanced/i));
    expect(screen.getByText(/tools/i)).toBeTruthy();
  });

  it("save emits id + meta with 256k default", () => {
    const onSave = vi.fn();
    render(<ModelMetaEditor showTools={false} onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: "m1" } });
    fireEvent.click(screen.getByText(/save/i));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1", vision: false, maxContextTokens: 256_000 }),
    );
  });

  it("modelId is read-only in edit mode", () => {
    render(<ModelMetaEditor showTools={false} modelIdReadonly initial={{ id: "fixed", vision: true, maxContextTokens: 999 }} onSave={() => {}} onCancel={() => {}} />);
    const input = screen.getByDisplayValue("fixed") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });
});
```

> i18n：测试用 `/advanced/i`、`/vision/i`、`/save/i` 等正则匹配，避免依赖具体文案。若渲染需 i18n provider，按项目现有测试约定包一层（参考其它 `__tests__` 下组件测试的 render 包装）。

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm test src/sidepanel/components/__tests__/ModelMetaEditor.test.tsx`
Expected: FAIL，`Cannot find module '../ModelMetaEditor'`

- [ ] **Step 3: 实现 ModelMetaEditor**

把 `CustomProviderForm.tsx:431-546` 的 modal JSX 搬进新组件，参数化。组件契约：

```tsx
// src/sidepanel/components/ModelMetaEditor.tsx
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { DEFAULT_CUSTOM_MODEL_MAX_CONTEXT } from "@/lib/provider-custom-model-meta";

export interface ModelMetaDraft {
  id: string;
  displayName?: string;
  vision: boolean;
  tools: boolean; // custom provider 用；builtin 忽略（showTools=false）
  maxContextTokens: number;
}

interface Props {
  initial?: Partial<ModelMetaDraft>;
  showTools: boolean;
  modelIdReadonly?: boolean;
  onSave: (draft: ModelMetaDraft) => void;
  onCancel: () => void;
}

export default function ModelMetaEditor({ initial, showTools, modelIdReadonly, onSave, onCancel }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<ModelMetaDraft>({
    id: initial?.id ?? "",
    displayName: initial?.displayName ?? "",
    vision: initial?.vision ?? false,
    tools: initial?.tools ?? true,
    maxContextTokens: initial?.maxContextTokens ?? DEFAULT_CUSTOM_MODEL_MAX_CONTEXT,
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // ... 复制 CustomProviderForm.tsx:431-546 的 modal 结构：
  //  - modelId 输入（modelIdReadonly 时 readOnly）
  //  - displayName 输入
  //  - Advanced 折叠：vision checkbox + maxContextTokens number input
  //    + tools checkbox 仅当 showTools 为 true 时渲染
  //  - Cancel → onCancel；Save（disabled 当 !draft.id.trim()）→ onSave(draft)
  // 返回值类型对齐 ModelMetaDraft。
  return (/* modal JSX，见源 431-546 */);
}
```

实现要点（对照源）：
- 源 `editingModel.advancedOpen` → 本组件 `advancedOpen` state。
- 源 tools checkbox（`CustomProviderForm.tsx:486-497`）整段**包在 `{showTools && (...)}` 内**。
- maxContextTokens number input 默认值改用 `DEFAULT_CUSTOM_MODEL_MAX_CONTEXT`。
- modelId input 加 `readOnly={modelIdReadonly}`。

- [ ] **Step 4: CustomProviderForm 改用 ModelMetaEditor**

- 删 `CustomProviderForm.tsx:431-546` 的 inline modal，替换为：
  ```tsx
  {editingModel && (
    <ModelMetaEditor
      showTools
      modelIdReadonly={editingModel.index !== undefined}
      initial={editingModel}
      onSave={(d) => { /* 原 saveEditingModel 逻辑：写 models[]，区分 add/edit by index */ }}
      onCancel={() => setEditingModel(null)}
    />
  )}
  ```
- `openAddModel`（`CustomProviderForm.tsx:93-100`）的默认 `maxContextTokens: 128_000` 改为 `DEFAULT_CUSTOM_MODEL_MAX_CONTEXT`（import 之）。
- `EditingModel`/`saveEditingModel` 仍保留在 CustomProviderForm（它管 cp.models[] 的本地编辑）；只是 modal UI 委托给 ModelMetaEditor。

- [ ] **Step 5: 跑测试验证通过 + custom provider 不回归**

Run: `pnpm test src/sidepanel/components/__tests__/ModelMetaEditor.test.tsx src/sidepanel/components/__tests__/CustomProviderForm.test.tsx`
Expected: PASS（新 4 个 + CustomProviderForm 原有不回归）
> 若 CustomProviderForm 无现成测试，至少手动确认 `pnpm typecheck` 通过、`pnpm build` 不报错。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/ModelMetaEditor.tsx src/sidepanel/components/__tests__/ModelMetaEditor.test.tsx src/sidepanel/components/CustomProviderForm.tsx
git commit -m "refactor(settings): extract shared ModelMetaEditor; default 256k" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ModelDropdown 集成 modal + badge + 回调

**Files:**
- Modify: `src/sidepanel/components/ModelDropdown.tsx`
- Test: `src/sidepanel/components/ModelDropdown.test.tsx`

- [ ] **Step 1: 写失败测试**（扩展现有 ModelDropdown.test.tsx）

```tsx
import type { StoredCustomModelMeta } from "@/lib/provider-custom-model-meta";

it("custom model with vision meta shows vision badge, never tools badge", () => {
  const metas: Record<string, StoredCustomModelMeta> = { "my-model": { vision: true, maxContextTokens: 256_000 } };
  render(<ModelDropdown provider="minimax" value="" customModels={["my-model"]} customModelMetas={metas}
    onChange={() => {}} onAddCustom={() => {}} onUpdateCustomMeta={() => {}} onRemoveCustom={() => {}} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /select/i })); // 打开 dropdown（按现有测试打开方式）
  expect(screen.getByText(/vision/i)).toBeTruthy();
  expect(screen.queryByText(/^tools$/i)).toBeNull();
});

it("+add opens ModelMetaEditor modal and save emits (id, meta)", () => {
  const onAddCustom = vi.fn();
  render(<ModelDropdown provider="minimax" value="" customModels={[]} customModelMetas={{}}
    onChange={() => {}} onAddCustom={onAddCustom} onUpdateCustomMeta={() => {}} onRemoveCustom={() => {}} onRefresh={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /select/i }));
  fireEvent.click(screen.getByText(/add.*custom.*model/i));
  fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: "m9" } });
  fireEvent.click(screen.getByText(/save/i));
  expect(onAddCustom).toHaveBeenCalledWith("m9", expect.objectContaining({ vision: false, maxContextTokens: 256_000 }));
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm test src/sidepanel/components/ModelDropdown.test.tsx`
Expected: FAIL（`customModelMetas`/`onUpdateCustomMeta` 未定义；badge/modal 行为缺失）

- [ ] **Step 3: 改 ModelDropdown**

Props 接口（`ModelDropdown.tsx:7-18`）改为：

```ts
import type { StoredCustomModelMeta } from "@/lib/provider-custom-model-meta";

interface Props {
  provider: ProviderRef;
  value: string;
  customModels: string[];
  customModelMetas?: Record<string, StoredCustomModelMeta>; // 新增
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  onChange: (modelId: string) => void;
  onAddCustom?: (modelId: string, meta: StoredCustomModelMeta) => void;      // 签名变
  onUpdateCustomMeta?: (modelId: string, meta: StoredCustomModelMeta) => void; // 新增
  onRemoveCustom?: (modelId: string) => void;
  onRefresh: () => void;
}
```

改动点：
1. `baseList`（`ModelDropdown.tsx:43-47`）自定义项填 meta（构造展示用 ModelMeta，tools 恒 true）：
   ```ts
   ...props.customModels.map((id) => {
     const cm = props.customModelMetas?.[id];
     return {
       id,
       meta: cm ? { id, vision: cm.vision, tools: true, maxContextTokens: cm.maxContextTokens, displayName: cm.displayName } : undefined,
       isCustom: true,
     };
   }),
   ```
2. badge（`ModelDropdown.tsx:117-119`）：tools badge 行加 `!m.isCustom` 守卫：
   ```tsx
   {m.meta?.vision && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.vision")}</span>}
   {!m.isCustom && m.meta?.tools && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.tools")}</span>}
   ```
3. 自定义项加铅笔（在 `ModelDropdown.tsx:120-131` 的 isCustom 块，× 前）：
   ```tsx
   <span role="button" aria-label="edit" onClick={(e) => { e.stopPropagation(); setEditing({ id: m.id, ...(props.customModelMetas?.[m.id] ?? { vision: false, maxContextTokens: DEFAULT_CUSTOM_MODEL_MAX_CONTEXT }) }); setOpen(false); }} className="text-fg-3 hover:text-fg-1">✎</span>
   ```
4. footer「+添加」（`ModelDropdown.tsx:141-147`）：`onClick` 从 `setAdding(true)` 改为 `setEditing({})`；删 inline 输入框分支（148-169）及不再用的 `adding`/`draft` state（26-27）。
5. 组件内加 `editing` state + 渲染 ModelMetaEditor（import `ModelMetaEditor`、`ModelMetaDraft`、`DEFAULT_CUSTOM_MODEL_MAX_CONTEXT`）：
   ```tsx
   const [editing, setEditing] = useState<Partial<ModelMetaDraft> | null>(null);
   // 在组件返回最外层 <div> 内加：
   {editing && (
     <ModelMetaEditor
       showTools={false}
       modelIdReadonly={!!editing.id}
       initial={editing}
       onSave={(d) => {
         const meta = { displayName: d.displayName || undefined, vision: d.vision, maxContextTokens: d.maxContextTokens };
         if (editing.id) props.onUpdateCustomMeta?.(d.id, meta);
         else props.onAddCustom?.(d.id, meta);
         setEditing(null);
       }}
       onCancel={() => setEditing(null)}
     />
   )}
   ```

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm test src/sidepanel/components/ModelDropdown.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ModelDropdown.tsx src/sidepanel/components/ModelDropdown.test.tsx
git commit -m "feat(settings): ModelDropdown add/edit custom-model attributes via modal" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 上层接线（InstanceForm + Settings + NewConfigWizard）

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`（透传）
- Modify: `src/sidepanel/components/Settings.tsx`（加载 pcmm，写 pcm+pcmm，删连带）
- Modify: `src/sidepanel/components/NewConfigWizard.tsx`（同）

- [ ] **Step 1: InstanceForm 透传**

- Props 加 `customModelMetas?: Record<string, StoredCustomModelMeta>`、`onUpdateCustomModelMeta?: (id, meta) => void`，`onAddCustomModel` 签名改 `(id, meta)`。
- `ModelDropdown` 用法（`InstanceForm.tsx:175-198`）：
  ```tsx
  customModelMetas={props.customModelMetas}
  onAddCustom={isCustomProvider ? undefined : (id, meta) => {
    setCustomModels((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setModel(id);
    props.onAddCustomModel?.(id, meta);
  }}
  onUpdateCustomMeta={isCustomProvider ? undefined : (id, meta) => props.onUpdateCustomModelMeta?.(id, meta)}
  onRemoveCustom={isCustomProvider ? undefined : (id) => {
    setCustomModels((prev) => prev.filter((x) => x !== id));
    if (model === id) setModel("");
    props.onRemoveCustomModel?.(id);
  }}
  ```

- [ ] **Step 2: Settings 接线**

- 顶部加载每个 provider 的 pcmm（与 `providerPools` 并列，新 `providerMetas` state；`Settings.tsx` 已有 `providerPools` 加载逻辑，仿之用 `getProviderCustomModelMetas`）。import `getProviderCustomModelMetas` / `setProviderCustomModelMeta` / `removeProviderCustomModelMeta`。
- `renderForm`（`Settings.tsx:207` 起）给 InstanceForm 传：
  ```tsx
  customModelMetas={providerMetas[inst.provider] ?? {}}
  onAddCustomModel={async (mid, meta) => {
    const nextInst = [...(inst.customModels ?? []), mid];
    await updateInstance(id, { customModels: nextInst });
    await addProviderCustomModel(inst.provider, mid);
    await setProviderCustomModelMeta(inst.provider, mid, meta);
    await reload();
  }}
  onUpdateCustomModelMeta={async (mid, meta) => {
    await setProviderCustomModelMeta(inst.provider, mid, meta);
    await reload();
  }}
  onRemoveCustomModel={async (mid) => {
    const nextInst = (inst.customModels ?? []).filter((x) => x !== mid);
    await updateInstance(id, { customModels: nextInst });
    await removeProviderCustomModel(inst.provider, mid);
    await removeProviderCustomModelMeta(inst.provider, mid); // 连带清 pcmm
    await reload();
  }}
  ```
- `reload()`（或等价加载函数）里补加载 `providerMetas`。

- [ ] **Step 3: NewConfigWizard 接线**

- 加 `metas` state（仿 `pool`）。InstanceForm（`NewConfigWizard.tsx:147` 起）传 `customModelMetas={metas}`、改回调：
  ```tsx
  onAddCustomModel={async (id, meta) => {
    await addProviderCustomModel(provider, id);
    await setProviderCustomModelMeta(provider, id, meta);
    setPool(await getProviderCustomModels(provider));
    setMetas(await getProviderCustomModelMetas(provider));
  }}
  onUpdateCustomModelMeta={async (id, meta) => {
    await setProviderCustomModelMeta(provider, id, meta);
    setMetas(await getProviderCustomModelMetas(provider));
  }}
  onRemoveCustomModel={async (id) => {
    await removeProviderCustomModel(provider, id);
    await removeProviderCustomModelMeta(provider, id);
    setPool(await getProviderCustomModels(provider));
    setMetas(await getProviderCustomModelMetas(provider));
  }}
  ```
  （import 对应函数 + `getProviderCustomModels`，后者现有）

- [ ] **Step 4: 验证**

Run: `pnpm test && pnpm typecheck`
Expected: PASS（接线层主要靠类型 + 既有组件测试守护；签名改动若漏改会被 typecheck 抓出）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/Settings.tsx src/sidepanel/components/NewConfigWizard.tsx
git commit -m "feat(settings): wire pcmm through InstanceForm/Settings/Wizard (load + write + cascade delete)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Chat vision 从 pcmm 生效

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（约 544-548）

方案 (b)：不动 `resolveModelVision` 签名，用已 await 的 `resolveModelMeta` 结果回退。

- [ ] **Step 1: 写失败测试**

```tsx
// 断言：provider=minimax、model 是已配 vision:true 的自定义模型时，supportsVision 为 true。
// Chat 的 vision 解析较内聚——先把 544-548 的解析抽成纯函数 resolveSupportsVision，再单测。
import { resolveSupportsVision } from "../Chat"; // 或抽到独立小文件并 export

it("builtin custom model vision: pcmm vision unlocks supportsVision", async () => {
  await setProviderCustomModelMeta("minimax", "MiniMax-Future", { vision: true, maxContextTokens: 256_000 });
  expect(await resolveSupportsVision("minimax", "MiniMax-Future", undefined)).toBe(true);
});

it("builtin custom model without vision stays false", async () => {
  await setProviderCustomModelMeta("minimax", "TextOnly", { vision: false, maxContextTokens: 256_000 });
  expect(await resolveSupportsVision("minimax", "TextOnly", undefined)).toBe(false);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm test -t "builtin custom model vision"`
Expected: FAIL（`resolveSupportsVision` 未导出 / 旧逻辑对自定义模型恒 false）

- [ ] **Step 3: 抽出并改 vision 解析**

抽一个纯函数（放 Chat.tsx 内 export，或 `src/sidepanel/components/chat-vision.ts`）：

```ts
export async function resolveSupportsVision(
  provider: string,
  model: string,
  fetchedModels?: ModelMeta[],
): Promise<boolean> {
  const registryVision = resolveModelVision(provider as BuiltinProvider, model, fetchedModels);
  if (registryVision !== undefined) return registryVision;
  const meta = await resolveModelMeta(provider, model);
  return meta?.vision ?? false;
}
```

`Chat.tsx:544-548` 改为调用它：

```ts
const supportsVision = await resolveSupportsVision(inst.provider, inst.model, inst.fetchedModels);
setSupportsVision(supportsVision);
const meta = await resolveModelMeta(inst.provider, inst.model);
setMaxContextTokens(meta?.maxContextTokens);
```

> registry/fetched 命中预置仍优先（零回归）；只有都 miss 时才回退 pcmm 的 vision。

- [ ] **Step 4: 跑测试验证通过**

Run: `pnpm test -t "builtin custom model vision"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/chat-vision.ts
git commit -m "feat(chat): unlock attach button for vision-enabled builtin custom models" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 文档 + 全量验证

**Files:**
- Modify: `CLAUDE.md`（Project Structure）

- [ ] **Step 1: 更新 CLAUDE.md**

在 `src/lib/provider-custom-models.ts` 条目下加一行：

```
- `src/lib/provider-custom-model-meta.ts` — per-provider sidecar 属性表（`pcmm_${provider}`），给 builtin 自定义模型挂 `vision`/`maxContextTokens`（`tools` 恒 true、不可配）；与 `pcm_${provider}` 的 id 池一一对应，删模型时两边连带清
```

- [ ] **Step 2: 全量门禁**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS；build 无报错（manifest invariant 通过）

- [ ] **Step 3: 手动冒烟（加载 dist/）**

`chrome://extensions` 重载 → Settings → 某 builtin instance → dropdown「+添加自定义模型」→ 填 id + Advanced 配 vision/256K → 保存 → 选中该模型发消息 → 确认：圆环显示（256K 分母）、vision=true 时 attach 按钮启用、dropdown 显示 vision badge 无 tools badge → 铅笔改属性 → × 删除后 pcmm 不留残留（SW console `chrome.storage.local.get('pcmm_minimax')` 核对）。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record provider-custom-model-meta module in CLAUDE.md" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾

完成全部 task 后：用 `finishing-a-development-branch` skill 走 PR 流程（base `main`，分支 `feat/builtin-provider-model-meta`，远端操作前 `gh auth switch --user WiseriaAI`）。

## Self-Review 记录

- **Spec coverage**：范围/存储/查找顺序/UI 入口（+添加+铅笔）/默认 256K/tools 不可配/迁移无/测试 —— 各有对应 task（1-7）。
- **vision 路径**：spec 留的 (a)/(b) 已定为 (b)（Task 6），不改 `resolveModelVision` 签名，避免连锁 `instances.ts`（SW 截图 guard fail-open，不需改）。
- **类型一致**：`StoredCustomModelMeta`（无 tools）跨 Task 1/2/4/5 一致；`ModelMetaDraft`（含 tools）仅 ModelMetaEditor 内部 + dropdown onSave，落库时剥掉 tools。
