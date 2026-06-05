# Provider / Model 解耦 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「模型选择」从 instance/设置页解耦到 Composer：instance 退化为 `(provider, apiKey, nickname)`，模型在 Composer 二级手风琴选择器里选，设置页只配 Provider + 管理模型列表，新会话继承上次选择，内置 Provider 显示图标。

**Architecture:** 数据层先解耦（`StoredInstance` 去 `model`、新增全局 `last_model_selection`、`resolveModelConfig(instanceId, model)`、一次性迁移合并同-provider 多 instance）→ 会话/路由层改为按 `(instanceId, model)` 解析并 snapshot → Composer 新增 `ModelPicker`（手风琴）取代 `InstanceSelector` → 设置页 `InstanceForm`/`InstancesList` 去 model/Activate、编辑卡内嵌「模型列表」区 → 图标 `<ProviderIcon>` 全局接入。

**Tech Stack:** React 19 + TS 6 · vitest + happy-dom + @testing-library/react · chrome.storage.local · @crxjs/vite (public/ → dist/)

**权威 spec:** `docs/specs/2026-06-05-provider-model-decouple.md`（决策 D1–D7、图标章节 §8）

**关键既有约定（务必遵守）:**
- 每个 task 结束跑 `pnpm test <file>`；阶段末跑 `pnpm typecheck`；全部完成跑 `pnpm test && pnpm typecheck && pnpm build`。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 工作目录是 worktree `.claude/worktrees/feat+provider-model-decouple`，所有命令在此根目录跑（**不要** cd 回主仓库）。
- `ModelConfig` 形状（`{provider, providerName?, model, apiKey, baseUrl, maxTokens?, vision?}`）保持不变 —— agent loop 无感。
- 自定义模型双层架构不变：builtin → `pcm_${provider}`(id 池) + `pcmm_${provider}`(meta sidecar)；custom provider → provider 实体 `models[]`。

---

## 文件结构总览

**新建**
- `src/lib/last-model-selection.ts` — 全局「上次选择的 (instanceId, model)」读写
- `src/lib/last-model-selection.test.ts`
- `src/lib/model-selection-resolver.ts` — 纯函数：按 D3 优先级解析出 `(instanceId, model)`
- `src/lib/model-selection-resolver.test.ts`
- `src/sidepanel/components/ProviderIcon.tsx` — 图标 / monogram fallback
- `src/sidepanel/components/ProviderIcon.test.tsx`
- `src/sidepanel/components/ModelPicker.tsx` — Composer 二级手风琴选择器
- `src/sidepanel/components/ModelPicker.test.tsx`
- `src/sidepanel/components/ProviderModelList.tsx` — 设置页「模型列表」区（内置只读 + 自定义增删改）
- `src/sidepanel/components/ProviderModelList.test.tsx`
- `src/lib/migrate-instance-model.ts` — 一次性迁移（合并同-provider 多 instance + 剥离 model）
- `src/lib/migrate-instance-model.test.ts`
- `public/provider-icons/*.svg` — **已落盘**（10 个，本计划不再创建）

**修改**
- `src/lib/instances.ts` — 去 `model` 字段；`resolveInstanceToModelConfig`→`resolveModelConfig(instanceId, model)`；`createInstance`/`updateInstance` 去 model
- `src/lib/model-router/providers/registry.ts` — `ProviderMeta.iconAsset?`；12 个 builtin 填 `iconAsset`
- `src/lib/sessions/types.ts` — `SessionMeta.model?`
- `src/lib/sessions/storage.ts` — backfill 时带 model（保持现状即可，model 缺省）
- `src/background/index.ts` — chat/resume 路径用 `(instanceId, model)` 解析 + snapshot model
- `src/sidepanel/components/Chat.tsx` — 选择状态 `(instanceId, model)`，渲染 ModelPicker
- `src/sidepanel/components/Settings.tsx` — 去 ActiveSection / Activate；handleSaveEdit 去 model；新建走 provider+key
- `src/sidepanel/components/InstanceForm.tsx` — 去 model 选择字段，内嵌 ProviderModelList
- `src/sidepanel/components/InstancesList.tsx` — 去 model 显示 / Activate 按钮，加图标
- `src/sidepanel/App.tsx` — provider label 去 model
- `src/background/eval-bridge.ts` — `resolveActiveInstanceModelConfig` 适配新签名
- i18n 中英文件 — 新增/调整文案

**删除（被取代后）**
- `src/sidepanel/components/InstanceSelector.tsx` + `.test.tsx`（被 ModelPicker 取代）
- `src/sidepanel/components/ModelDropdown.tsx` + `.test.tsx`（被 ProviderModelList 取代）

---

## Phase 0 — 图标基础设施

### Task 1: `ProviderMeta.iconAsset` 字段 + registry 填值

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts`

- [ ] **Step 1: 给 `ProviderMeta` 接口加字段**

在 `ProviderMeta` 接口（含 `id`/`name`/`defaultBaseUrl`/`placeholder`/`models`/`modelsEndpoint?`）中追加：

```ts
  /** 图标资源路径，相对扩展根（public/ 在 build 期拷到 dist/）。
   *  缺省时 UI 走 monogram fallback（见 ProviderIcon）。svg 已用
   *  fill="currentColor"，由组件按主题给色。 */
  iconAsset?: string;
```

- [ ] **Step 2: 给每个 builtin entry 填 `iconAsset`**

对以下 12 个 builtin（按现有 entry 顺序定位 `id:` 行，在该 entry 内加一行）：

| provider id | iconAsset |
|---|---|
| anthropic | `"provider-icons/anthropic.svg"` |
| openai | `"provider-icons/openai.svg"` |
| openrouter | `"provider-icons/openrouter.svg"` |
| minimax | `"provider-icons/minimax.svg"` |
| zhipu | `"provider-icons/zhipu.svg"` |
| gemini | `"provider-icons/gemini.svg"` |
| deepseek | `"provider-icons/deepseek.svg"` |
| mimo | `"provider-icons/mimo.svg"` |
| moonshot | `"provider-icons/moonshot.svg"` |
| moonshot-cn | `"provider-icons/moonshot.svg"` |
| stepfun | `"provider-icons/stepfun.svg"` |
| bailian | （不填 —— 图标缺失，走 monogram fallback） |

例（anthropic entry）：

```ts
  {
    id: "anthropic",
    name: "Anthropic",
    iconAsset: "provider-icons/anthropic.svg",
    // ...其余字段不变
```

- [ ] **Step 3: 验证 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors（`iconAsset?` 可选，不破坏现有构造）。

- [ ] **Step 4: Commit**

```bash
git add src/lib/model-router/providers/registry.ts public/provider-icons/
git commit -m "feat(registry): add iconAsset field + wire builtin provider icons

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 注：`public/provider-icons/*.svg` 已落盘（Phase 前置），此 commit 把它们随 registry 一起纳入版本控制。

---

### Task 2: `<ProviderIcon>` 组件

**Files:**
- Create: `src/sidepanel/components/ProviderIcon.tsx`
- Test: `src/sidepanel/components/ProviderIcon.test.tsx`

需求：给定 `provider: ProviderRef` + `size`，有 `iconAsset` 渲染 `<img>`（外套圆角方块容器），否则渲染 monogram（首字 / 缩写）。custom provider 一律 monogram。颜色用 `currentColor`（`color` 由父控制；当前选中态父传 accent）。

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import ProviderIcon from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders an img for a builtin provider that has iconAsset", () => {
    render(<ProviderIcon provider="anthropic" size={22} />);
    const img = screen.getByRole("img", { hidden: true });
    expect(img).toHaveAttribute("src", expect.stringContaining("provider-icons/anthropic.svg"));
  });

  it("renders a monogram for a provider without iconAsset (bailian)", () => {
    render(<ProviderIcon provider="bailian" size={22} />);
    expect(screen.queryByRole("img", { hidden: true })).toBeNull();
    // 首字母 monogram（百炼 → 阿里百炼显示名首字，回退到 id 首字 "b"/"B"/"阿"）
    expect(screen.getByText(/./)).toBeInTheDocument();
  });

  it("renders a monogram for any custom provider", () => {
    render(<ProviderIcon provider="custom:abc" size={22} />);
    expect(screen.queryByRole("img", { hidden: true })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/sidepanel/components/ProviderIcon.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现组件**

```tsx
import type { ProviderRef, BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";

interface Props {
  provider: ProviderRef;
  /** 方块边长 px */
  size: number;
  /** 当前选中态可传 accent 色；默认继承 */
  className?: string;
}

/** 内置 provider 图标；缺图标 / custom provider 回退到首字母 monogram。
 *  单色 svg 用 currentColor，由 `color`（className / 继承）控制主题色。 */
export default function ProviderIcon({ provider, size, className }: Props) {
  const isCustom = provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustom ? undefined : getProviderMeta(provider as BuiltinProvider);
  const box = Math.round(size);
  const wrap: React.CSSProperties = {
    width: box, height: box, borderRadius: Math.max(4, Math.round(box * 0.27)),
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  };
  if (meta?.iconAsset) {
    const url = chrome.runtime.getURL(meta.iconAsset);
    return (
      <span style={wrap} className={`bg-field border border-line ${className ?? "text-fg-2"}`}>
        <img src={url} alt="" aria-hidden width={Math.round(box * 0.62)} height={Math.round(box * 0.62)} style={{ color: "inherit" }} />
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

function monogram(provider: ProviderRef, name?: string): string {
  const src = (name ?? provider.replace(CUSTOM_PREFIX, "")).trim();
  if (!src) return "?";
  // 取首个字（中文取首汉字；英文取首字母大写）
  const ch = Array.from(src)[0]!;
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}
```

> 注：`<img>` 用 currentColor 着色需 svg 内联（mask）才严格生效；MVP 用 `<img>` + svg 自带 `fill="currentColor"` 在 Chrome 下对独立 svg 文件不会随父 color 变。**因此**：若手测发现 `<img>` 图标显示为黑（不可见），改用 CSS mask 方案——见 Step 3b。先按 `<img>` 实现跑通测试（测试只断言 src/monogram），手测阶段再决定是否切 mask。

- [ ] **Step 3b（按需）: 若手测图标不可见，切 CSS mask 着色**

把 `<img>` 分支替换为 mask（图标随 `currentColor` 变色，真正适配深/浅主题）：

```tsx
  if (meta?.iconAsset) {
    const url = chrome.runtime.getURL(meta.iconAsset);
    const inner = Math.round(box * 0.62);
    return (
      <span style={wrap} className={`bg-field border border-line ${className ?? "text-fg-2"}`}>
        <span
          aria-hidden
          style={{
            width: inner, height: inner, backgroundColor: "currentColor",
            WebkitMaskImage: `url(${url})`, maskImage: `url(${url})`,
            WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
            WebkitMaskSize: "contain", maskSize: "contain",
            WebkitMaskPosition: "center", maskPosition: "center",
          }}
        />
      </span>
    );
  }
```

测试需相应改为断言 mask 样式而非 img（若切换，更新 Step 1 第一个用例：查 `container.querySelector('[style*="mask-image"]')`）。**默认按 Step 3 的 `<img>` 实现提交，mask 留作手测后的优化项，在 spec §8 已记 currentColor 约定。**

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test src/sidepanel/components/ProviderIcon.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ProviderIcon.tsx src/sidepanel/components/ProviderIcon.test.tsx
git commit -m "feat(ui): add ProviderIcon with icon + monogram fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Phase 0 收尾:** `pnpm typecheck` 应 0 错。

---

## Phase 1 — 数据层解耦

### Task 3: `last-model-selection` 模块

**Files:**
- Create: `src/lib/last-model-selection.ts`
- Test: `src/lib/last-model-selection.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getLastModelSelection, setLastModelSelection } from "./last-model-selection";

describe("last-model-selection", () => {
  beforeEach(() => { (globalThis as any).chrome = makeChromeLocal(); });

  it("returns null when nothing stored", async () => {
    expect(await getLastModelSelection()).toBeNull();
  });

  it("round-trips instanceId + model", async () => {
    await setLastModelSelection({ instanceId: "i1", model: "gpt-4o" });
    expect(await getLastModelSelection()).toEqual({ instanceId: "i1", model: "gpt-4o" });
  });

  it("overwrites prior selection", async () => {
    await setLastModelSelection({ instanceId: "i1", model: "gpt-4o" });
    await setLastModelSelection({ instanceId: "i2", model: "claude-opus-4-7" });
    expect(await getLastModelSelection()).toEqual({ instanceId: "i2", model: "claude-opus-4-7" });
  });
});

function makeChromeLocal() {
  const store: Record<string, unknown> = {};
  return { storage: { local: {
    get: async (k: string) => ({ [k]: store[k] }),
    set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
    remove: async (k: string) => { delete store[k]; },
  } } };
}
```

> 注：项目已用 `fake-indexeddb` + happy-dom；若仓库已有 chrome.storage mock 工具（检查 `src/test-setup` 或现有 `*.test.ts` 的 mock 写法，如 `instances.test.ts`），复用之，删掉本地 `makeChromeLocal`。先按现有测试惯例对齐。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/lib/last-model-selection.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
/**
 * 全局「上次选择的模型」。取代旧的「默认 instance（active_instance_id）」语义：
 * 新会话从这里继承 (instanceId, model)。每次用户在 Composer 选定模型时更新。
 * 一 provider 一 key（D1），instanceId ↔ provider 一一对应。
 */
export interface LastModelSelection {
  instanceId: string;
  model: string;
}

const KEY = "last_model_selection";

export async function getLastModelSelection(): Promise<LastModelSelection | null> {
  const r = await chrome.storage.local.get(KEY);
  const v = r[KEY] as LastModelSelection | undefined;
  return v && v.instanceId && v.model ? v : null;
}

export async function setLastModelSelection(sel: LastModelSelection): Promise<void> {
  await chrome.storage.local.set({ [KEY]: sel });
}
```

- [ ] **Step 4: 运行确认通过** → `pnpm test src/lib/last-model-selection.test.ts` PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/last-model-selection.ts src/lib/last-model-selection.test.ts
git commit -m "feat(model): add global last_model_selection store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `StoredInstance` 去 `model` + `resolveModelConfig(instanceId, model)`

**Files:**
- Modify: `src/lib/instances.ts`
- Modify: `src/lib/instances.test.ts`
- Modify: `src/background/eval-bridge.ts`

这是核心数据层改动。`model` 从 instance 移除，解析改为显式传 model。

- [ ] **Step 1: 改 `instances.ts` 类型与函数**

`StoredInstance`：删除 `model: string;` 行。

`createInstance` 入参：删除 `model: string;`；删除 `inRegistry`/`resolvedCustomModels` 中对 `input.model` 的依赖——改为：`customModels` 仅来自显式入参（不再 auto-detect model）。新版：

```ts
export async function createInstance(input: {
  provider: ProviderRef;
  nickname: string;
  apiKey: string;
  customModels?: string[];
}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("API key cannot be empty");
  const id = crypto.randomUUID();
  const key = await getOrCreateEncryptionKey();
  const stored: StoredInstance = {
    id,
    provider: input.provider,
    nickname: input.nickname,
    encryptedKey: await encrypt(input.apiKey, key),
    ...(input.customModels && input.customModels.length > 0 && { customModels: input.customModels }),
    createdAt: Date.now(),
  };
  const idx = await readIndex();
  idx.push(id);
  await chrome.storage.local.set({ [INSTANCE_KEY(id)]: stored, [INDEX_KEY]: idx });
  return id;
}
```

> 注意：删除原 `if (idx.length === 1 && !(await getActiveInstance())) await setActiveInstance(id);`——「active」概念废弃。`getActiveInstance`/`setActiveInstance`/`ACTIVE_KEY` **保留**（eval-bridge 仍用，且迁移读它），但不再在 create 时自动设。

`updateInstance` patch 类型：删除 `model: string;`，并删除函数体内 `if (patch.model !== undefined) next.model = patch.model;`。

新增 `resolveModelConfig(instanceId, model)` 取代 `resolveInstanceToModelConfig(id)`：

```ts
export async function resolveModelConfig(instanceId: string, model: string): Promise<ModelConfig | null> {
  const inst = await getInstance(instanceId);
  if (!inst) return null;
  const meta = await resolveProviderMeta(inst.provider);
  if (!meta) return null;
  let vision: boolean | undefined;
  if (inst.provider.startsWith("custom:")) {
    vision = await resolveCustomModelVision(inst.provider, model);
  } else {
    vision = resolveModelVision(inst.provider as BuiltinProvider, model, inst.fetchedModels);
    if (vision === undefined) {
      vision = (await resolveModelMeta(inst.provider, model))?.vision;
    }
  }
  return {
    provider: inst.provider,
    providerName: meta.name,
    model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
    ...(vision !== undefined && { vision }),
  };
}
```

`resolveActiveInstanceModelConfig`（eval 用）：改为需要 model。eval 的语义是「用 active instance + 其 provider 第一个 model」。改：

```ts
export async function resolveActiveInstanceModelConfig(): Promise<ModelConfig | null> {
  const id = await getActiveInstance();
  if (!id) return null;
  const inst = await getInstance(id);
  if (!inst) return null;
  const model = await firstModelForProvider(inst.provider);
  if (!model) return null;
  return resolveModelConfig(id, model);
}
```

新增辅助 `firstModelForProvider`（D3 fallback 也复用——见 Task 8 resolver，但此处 instances.ts 内部需要一份；为 DRY，把它放进 `model-selection-resolver.ts`（Task 8）并从这里 import。**执行顺序提示**：先做 Task 8 的 resolver 纯函数中的 `firstModelForProvider`，再回填这里的 import。或在本 task 临时内联，Task 8 抽走）。临时内联版：

```ts
async function firstModelForProvider(provider: ProviderRef): Promise<string | null> {
  const meta = getProviderMeta(provider as BuiltinProvider);
  if (meta && meta.models.length > 0) return meta.models[0]!.id;
  // custom provider / lazy provider: fall back to first custom-pool / fetched id
  const inst = await listInstances();
  const self = inst.find((i) => i.provider === provider);
  return self?.customModels?.[0] ?? self?.fetchedModels?.[0]?.id ?? null;
}
```

（需 `import { getProviderMeta } from "@/lib/model-router/providers/registry";`——已 import `resolveProviderMeta` 等，补 `getProviderMeta`。）

- [ ] **Step 2: 更新 `instances.test.ts`**

- 所有 `createInstance({ ..., model: "x" })` 调用去掉 `model`；改用 `customModels: ["x"]` 表达自定义模型场景。
- `resolveInstanceToModelConfig(id)` 调用改为 `resolveModelConfig(id, "<model>")`，传入对应 model。
- `resolveActiveInstanceModelConfig` 的用例：因现在需要 provider 有 registry model，确保测试用 builtin provider（如 anthropic）使其 `firstModelForProvider` 命中；断言 `cfg.model` = registry 第一个 model。
- vision via pcmm 用例：`resolveModelConfig(id, customModelId)`，pcmm 仍按 (provider, model) 命中。

逐个改，保持每个用例语义。运行：

Run: `pnpm test src/lib/instances.test.ts`
Expected: 全绿（改完后）。

- [ ] **Step 3: 更新 `eval-bridge.ts`**

`eval-bridge.ts` import 的 `resolveActiveInstanceModelConfig` 签名未变（仍无参），但其 `createInstance` 调用（L52 附近）若传了 `model`，去掉 model 改 `customModels`。检查 `eval-bridge.ts` 第 40–60 行的 createInstance 调用：若形如 `createInstance({ provider, nickname, apiKey, model })`，改为 `createInstance({ provider, nickname, apiKey, customModels: [model] })` 并确保 eval 后续用 `resolveActiveInstanceModelConfig`（已会选 provider 第一个 registry model）。同步更新 `eval-bridge.test.ts` 的 mock（`resolveActiveInstanceModelConfig` mock 返回值保持 `{provider, model, apiKey}` 即可）。

Run: `pnpm test src/background/eval-bridge.test.ts` → 绿。

- [ ] **Step 4: 全量 typecheck（会暴露所有 `resolveInstanceToModelConfig` / `inst.model` 引用）**

Run: `pnpm typecheck`
Expected: 报错集中在 `background/index.ts`（resolveInstanceToModelConfig 调用）、`Settings.tsx`/`InstancesList.tsx`/`InstanceForm.tsx`/`App.tsx`（`inst.model` / model 入参）、`Chat.tsx`。**这些在后续 task 修复**——本 task 只需 instances.ts + eval-bridge + 各自测试自洽。若想保持 typecheck 绿，可在本 task 末尾顺手把 `background/index.ts` 的两处调用临时改为 `resolveModelConfig(id, "")`（占位，Task 7 修正），但**更推荐**按 task 顺序推进、阶段末再 typecheck。

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts src/background/eval-bridge.ts src/background/eval-bridge.test.ts
git commit -m "refactor(instances): drop model from instance; resolveModelConfig(instanceId, model)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 一次性迁移（合并同-provider 多 instance + 剥离 model）

**Files:**
- Create: `src/lib/migrate-instance-model.ts`
- Test: `src/lib/migrate-instance-model.test.ts`

按 D7：同 provider 多 instance → 保留 active 指向的；无 active 则保留 `createdAt` 最新的；其余删除。被保留 instance 的旧 `model` 用于初始化 `last_model_selection`（保证迁移后首个会话仍用老模型）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { migrateInstanceModel } from "./migrate-instance-model";
import { listInstances, INSTANCE_KEY, INDEX_KEY } from "./instances";
import { getLastModelSelection } from "./last-model-selection";

// 复用仓库现有 chrome.storage mock 惯例（见 instances.test.ts）。

describe("migrateInstanceModel", () => {
  beforeEach(() => { /* reset chrome.storage.local mock + encryption key */ });

  it("merges multiple instances of same provider, keeping the active one", async () => {
    // seed: two openai instances (i1 active, i2), one anthropic (i3)
    // active_instance_id = i1, i1.model = "gpt-4o", i3.model = "claude-opus-4-7"
    await migrateInstanceModel();
    const list = await listInstances();
    const providers = list.map((i) => i.provider).sort();
    expect(providers).toEqual(["anthropic", "openai"]); // i2 dropped
    expect(list.find((i) => i.provider === "openai")!.id).toBe("i1");
    // model stripped from instances
    expect((list[0] as any).model).toBeUndefined();
  });

  it("seeds last_model_selection from the kept active instance's old model", async () => {
    // i1 active, model gpt-4o
    await migrateInstanceModel();
    expect(await getLastModelSelection()).toEqual({ instanceId: "i1", model: "gpt-4o" });
  });

  it("keeps newest by createdAt when no active set", async () => {
    // two openai: i1 createdAt 100, i2 createdAt 200, no active
    await migrateInstanceModel();
    const list = await listInstances();
    expect(list.map((i) => i.id)).toContain("i2");
    expect(list.map((i) => i.id)).not.toContain("i1");
  });

  it("is idempotent (second run no-op)", async () => {
    await migrateInstanceModel();
    const before = await listInstances();
    await migrateInstanceModel();
    const after = await listInstances();
    expect(after.map((i) => i.id).sort()).toEqual(before.map((i) => i.id).sort());
  });

  it("no-op when no instances have legacy model field", async () => {
    // seed instances already without model
    await migrateInstanceModel();
    expect(await getLastModelSelection()).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** → `pnpm test src/lib/migrate-instance-model.test.ts` FAIL。

- [ ] **Step 3: 实现**

```ts
import { INSTANCE_KEY, INDEX_KEY, getActiveInstance } from "./instances";
import { setLastModelSelection, getLastModelSelection } from "./last-model-selection";

interface LegacyStored {
  id: string; provider: string; nickname: string; encryptedKey: string;
  model?: string; customModels?: string[]; createdAt: number; [k: string]: unknown;
}

/** 一次性迁移：① 同 provider 多 instance → 保留 active / 最近，其余删；
 *  ② 剥离 instance.model，把保留的 active instance 旧 model 写入 last_model_selection。
 *  幂等：所有 instance 已无 model 字段时直接返回。 */
export async function migrateInstanceModel(): Promise<void> {
  const idxR = await chrome.storage.local.get(INDEX_KEY);
  const ids: string[] = (idxR[INDEX_KEY] as string[]) ?? [];
  if (ids.length === 0) return;

  const stored: LegacyStored[] = [];
  for (const id of ids) {
    const r = await chrome.storage.local.get(INSTANCE_KEY(id));
    const s = r[INSTANCE_KEY(id)] as LegacyStored | undefined;
    if (s) stored.push(s);
  }
  const anyHasModel = stored.some((s) => typeof s.model === "string");
  if (!anyHasModel) return; // 幂等：已迁移

  const activeId = await getActiveInstance();

  // 按 provider 分组，选保留者
  const byProvider = new Map<string, LegacyStored[]>();
  for (const s of stored) {
    const g = byProvider.get(s.provider) ?? [];
    g.push(s); byProvider.set(s.provider, g);
  }
  const kept: LegacyStored[] = [];
  for (const [, group] of byProvider) {
    let keep = group.find((s) => s.id === activeId);
    if (!keep) keep = group.slice().sort((a, b) => b.createdAt - a.createdAt)[0]!;
    kept.push(keep);
  }

  // last_model_selection ← active 保留者的旧 model（无 active 用第一个保留者）
  if (!(await getLastModelSelection())) {
    const seed = kept.find((s) => s.id === activeId) ?? kept[0];
    if (seed?.model) await setLastModelSelection({ instanceId: seed.id, model: seed.model });
  }

  // 写回：保留者去 model；删除非保留者
  const keptIds = new Set(kept.map((s) => s.id));
  const writes: Record<string, unknown> = {};
  const removes: string[] = [];
  for (const s of stored) {
    if (keptIds.has(s.id)) {
      const { model: _m, ...rest } = s;
      writes[INSTANCE_KEY(s.id)] = rest;
    } else {
      removes.push(INSTANCE_KEY(s.id));
    }
  }
  writes[INDEX_KEY] = kept.map((s) => s.id);
  await chrome.storage.local.set(writes);
  if (removes.length) await chrome.storage.local.remove(removes);
}
```

- [ ] **Step 4: 运行确认通过** → `pnpm test src/lib/migrate-instance-model.test.ts` PASS。

- [ ] **Step 5: 接线触发点**

迁移须在扩展启动早期、任何读 instance 之前跑一次。定位现有 V1→V2 迁移触发点（`src/lib/migration-v2.ts` 的调用方，grep `migrateV1` / `runMigration` 在 `background/index.ts` 或 `App.tsx`）。在其后追加 `await migrateInstanceModel();`。

Run: `pnpm test src/lib/migration-v2.test.ts`（确保未破坏既有迁移）→ 绿。

- [ ] **Step 6: Commit**

```bash
git add src/lib/migrate-instance-model.ts src/lib/migrate-instance-model.test.ts src/background/index.ts
git commit -m "feat(migrate): merge same-provider instances + strip model into last_model_selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Phase 1 收尾:** 跑 `pnpm test src/lib/` 确认数据层全绿（typecheck 此时仍有 UI 层红，Phase 2+ 修）。

---

## Phase 2 — 会话与路由集成

### Task 6: `SessionMeta.model` 字段

**Files:**
- Modify: `src/lib/sessions/types.ts`

- [ ] **Step 1: 加字段**

在 `SessionMeta` 的 `instanceId?: string;` 之后追加：

```ts
  /**
   * 本会话选中的 model（与 instanceId 配对）。Composer 选模型时写入。
   * 缺省（老 session / 仅 instanceId）→ 由 model-selection-resolver 按
   * provider 第一个 registry model 兜底（D3）。task start 时 (instanceId,
   * model) snapshot 进 checkpoint（C1 不变量）。
   */
  model?: string;
```

- [ ] **Step 2: typecheck（仅类型，新增可选字段不破坏）**

Run: `pnpm typecheck` → 该文件无新错（仍有其他 task 待修的红）。

- [ ] **Step 3: Commit**

```bash
git add src/lib/sessions/types.ts
git commit -m "feat(sessions): add SessionMeta.model paired with instanceId

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 选择解析纯函数 + background 路由集成

**Files:**
- Create: `src/lib/model-selection-resolver.ts`
- Test: `src/lib/model-selection-resolver.test.ts`
- Modify: `src/background/index.ts`
- Modify: `src/lib/instances.ts`（把 Task 4 内联的 `firstModelForProvider` 抽到 resolver 并 re-import）

按 §5.4 解析顺序：`session.(instanceId,model)` → `last_model_selection` → 第一个 instance 的 provider 第一个 registry model → null（零配置）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resolveSelection, firstModelForProvider } from "./model-selection-resolver";

describe("resolveSelection", () => {
  beforeEach(() => { /* reset chrome.storage.local mock */ });

  it("prefers session's own instanceId+model", async () => {
    // seed instance i1 (anthropic)
    const sel = await resolveSelection({ instanceId: "i1", model: "claude-opus-4-7" });
    expect(sel).toEqual({ instanceId: "i1", model: "claude-opus-4-7" });
  });

  it("falls back to last_model_selection when session has none", async () => {
    // last_model_selection = {i1, gpt-4o}
    const sel = await resolveSelection({});
    expect(sel).toEqual({ instanceId: "i1", model: "gpt-4o" });
  });

  it("falls back to first instance's first registry model", async () => {
    // no session sel, no last_model_selection, one anthropic instance i1
    const sel = await resolveSelection({});
    expect(sel).toEqual({ instanceId: "i1", model: "claude-opus-4-7" }); // registry[0]
  });

  it("returns null when no instances configured", async () => {
    expect(await resolveSelection({})).toBeNull();
  });

  it("session instanceId but no model → backfills model via firstModelForProvider", async () => {
    const sel = await resolveSelection({ instanceId: "i1" });
    expect(sel).toEqual({ instanceId: "i1", model: "claude-opus-4-7" });
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 实现 resolver**

```ts
import type { ProviderRef } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router/providers/registry";
import { getInstance, listInstances } from "./instances";
import { getLastModelSelection } from "./last-model-selection";

export interface Selection { instanceId: string; model: string; }

/** provider 的「第一个可用 model」：registry[0] → custom-pool[0] → fetched[0]。 */
export async function firstModelForProvider(provider: ProviderRef, instanceId?: string): Promise<string | null> {
  const meta = getProviderMeta(provider as any);
  if (meta && meta.models.length > 0) return meta.models[0]!.id;
  const inst = instanceId ? await getInstance(instanceId) : (await listInstances()).find((i) => i.provider === provider);
  return inst?.customModels?.[0] ?? inst?.fetchedModels?.[0]?.id ?? null;
}

/** 按 D3 优先级解析 (instanceId, model)。session 入参来自 SessionMeta。 */
export async function resolveSelection(session: { instanceId?: string; model?: string }): Promise<Selection | null> {
  // 1) session 自带且 instance 仍存在
  if (session.instanceId) {
    const inst = await getInstance(session.instanceId);
    if (inst) {
      const model = session.model ?? (await firstModelForProvider(inst.provider, inst.id));
      if (model) return { instanceId: inst.id, model };
    }
  }
  // 2) 全局上次选择（instance 仍存在）
  const last = await getLastModelSelection();
  if (last) {
    const inst = await getInstance(last.instanceId);
    if (inst) return { instanceId: inst.id, model: last.model };
  }
  // 3) 第一个 instance 的 provider 第一个 model
  const all = await listInstances();
  if (all.length > 0) {
    const first = all[0]!;
    const model = await firstModelForProvider(first.provider, first.id);
    if (model) return { instanceId: first.id, model };
  }
  // 4) 零配置
  return null;
}
```

把 Task 4 在 `instances.ts` 内联的 `firstModelForProvider` 删除，改 `import { firstModelForProvider } from "./model-selection-resolver";`（注意循环依赖：resolver import instances，instances import resolver——若 vitest/vite 报循环，把 `firstModelForProvider` 单独留在 instances.ts 并由 resolver import 它，反向即可。**推荐**：`firstModelForProvider` 定义在 `instances.ts`、export；resolver 从 instances import。改 resolver 的 import 行为 `import { getInstance, listInstances, firstModelForProvider } from "./instances";` 并删 resolver 内的本地定义）。

- [ ] **Step 4: 运行确认通过** → `pnpm test src/lib/model-selection-resolver.test.ts` PASS。

- [ ] **Step 5: 改 `background/index.ts`**

两处解析点 + snapshot：

**Chat 路径（L983/L992 附近）：** 现状
```ts
const chatInstanceId = chatSessionMeta?.instanceId ?? (await getActiveInstance());
// ...
const chatModelConfig = await resolveInstanceToModelConfig(chatInstanceId);
```
改为：
```ts
const sel = await resolveSelection({ instanceId: chatSessionMeta?.instanceId, model: chatSessionMeta?.model });
// sel 为 null 时沿用既有「无 config」分支（保持原 null 处理路径）
const chatModelConfig = sel ? await resolveModelConfig(sel.instanceId, sel.model) : null;
```

**Resume 路径（L768/L777 附近）：** 现状
```ts
const resumeInstanceId = meta.instanceId ?? (await getActiveInstance());
const resumeModelConfig = await resolveInstanceToModelConfig(resumeInstanceId);
```
改为：
```ts
const resumeSel = await resolveSelection({ instanceId: meta.instanceId, model: meta.model });
const resumeModelConfig = resumeSel ? await resolveModelConfig(resumeSel.instanceId, resumeSel.model) : null;
```

**Snapshot（L789-793 / L1126-1132）：** 现在要把 `(instanceId, model)` 一起 snapshot 进 session meta。把原先只写 `instanceId` 的两处，改为同时写 `model`：
```ts
// resume 持久化
...(meta.instanceId ? {} : { instanceId: resumeSel!.instanceId, model: resumeSel!.model }),
```
```ts
// synth 持久化（L1130 附近）
if (synthMeta && !synthMeta.instanceId && sel) {
  await setSessionMeta({ ...synthMeta, instanceId: sel.instanceId, model: sel.model }).catch(...);
}
```

更新 import：`import { resolveModelConfig } from "@/lib/instances";` + `import { resolveSelection } from "@/lib/model-selection-resolver";`；删除不再用的 `resolveInstanceToModelConfig`（`getActiveInstance` 若 chat/resume 不再用且无其他引用则一并删 import）。

- [ ] **Step 6: typecheck + 跑 background 相关测试**

Run: `pnpm typecheck`（background/index.ts 应消红）；`pnpm test src/background/` → 绿。若 `index.ts` 有针对解析的既有测试，更新其 mock（`resolveSelection`/`resolveModelConfig`）。

- [ ] **Step 7: Commit**

```bash
git add src/lib/model-selection-resolver.ts src/lib/model-selection-resolver.test.ts src/lib/instances.ts src/background/index.ts
git commit -m "feat(routing): resolve (instanceId, model) by precedence; snapshot model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Chat.tsx 选择状态（instanceId + model）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`
- Modify: `src/sidepanel/components/Chat.test.tsx`

把 Chat 里「当前 instanceId」状态扩展为 `(instanceId, model)`，并改用 `resolveSelection` 兜底（取代 `getActiveInstance` fallback）。本 task 只做状态与持久化；UI 渲染（ModelPicker）在 Task 10。

- [ ] **Step 1: 改状态与加载逻辑**

- 现有 `currentInstanceId` state（L225 区）→ 增加 `currentModel` state。
- 加载（L257 区）：把 `const fallback = meta?.instanceId ?? (await getActiveInstance());` 改为
  ```ts
  const sel = await resolveSelection({ instanceId: meta?.instanceId, model: meta?.model });
  setCurrentInstanceId(sel?.instanceId ?? null);
  setCurrentModel(sel?.model ?? null);
  ```
- 持久化 helper（L229-233）：`setSessionMeta({ ...existing, instanceId: id, model })` —— 增加 model 参数。
- storage onChanged 监听（L265-267）：同时读 `newMeta.model` 并 `setCurrentModel`。
- 选择变更时同时写全局 `last_model_selection`（import `setLastModelSelection`）。

- [ ] **Step 2: 更新 `Chat.test.tsx`**

- mock `@/lib/model-selection-resolver`（`resolveSelection`）取代对 `getActiveInstance` 的依赖；现有「InstanceSelector chip fallback」用例（L1106 区）改为断言 `resolveSelection` 的结果驱动 chip。
- 保留语义：新 session 无 pin 时，chip 显示 resolver 兜底的 instance+model。

Run: `pnpm test src/sidepanel/components/Chat.test.tsx` → 绿（可能需配合 Task 10 的渲染改动；若本 task 仅改状态、UI 仍是 InstanceSelector，先让相关断言通过最小改动，Task 10 再替换 UI 并最终修测试）。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat(chat): track (instanceId, model) via resolveSelection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Phase 2 收尾:** `pnpm typecheck` —— 数据+路由+会话应全消红，剩 Settings/InstanceForm/InstancesList/App（Phase 4）与 Composer UI（Phase 3）。

---

## Phase 3 — Composer ModelPicker（手风琴）

### Task 9: `<ModelPicker>` 组件

**Files:**
- Create: `src/sidepanel/components/ModelPicker.tsx`
- Test: `src/sidepanel/components/ModelPicker.test.tsx`

设计见 spec §6 + Paper 终稿「FINAL — Composer · Model Picker Open」。手风琴：一级 Provider 行（图标 + 上次 model 提示），点开就地展开 model 子列表（`max-height` 内部滚动）+ Provider 内搜索 + 能力胶囊 + 选中 ✓。

**Props 契约：**
```ts
interface Props {
  instances: DecryptedInstance[];          // 已配置的 provider 列表（一 provider 一 instance）
  currentInstanceId: string | null;
  currentModel: string | null;
  locked: boolean;                          // task 进行中
  /** 选定回调：写 session + last_model_selection 由父负责 */
  onSelect: (instanceId: string, model: string) => void;
  onManage: () => void;                     // 跳设置页
  /** lazy provider（openrouter）首展开拉取 /v1/models */
  onRefreshModels?: (instanceId: string) => void;
}
```

**每个 provider 的 model 来源（与设置页一致）：** registry models（`getProviderMeta(provider)?.models`）→ fetchedModels（`inst.fetchedModels`）→ 自定义（builtin: `pcm` 池 / custom provider: 实体 models）。MVP 可先用 `inst.customModels`（back-compat 已含池合并）+ registry + fetched，dedup。能力胶囊 vision/tools 从 ModelMeta 读。

- [ ] **Step 1: 写失败测试（行为级，RTL）**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import ModelPicker from "./ModelPicker";
import type { DecryptedInstance } from "@/lib/instances";

const insts: DecryptedInstance[] = [
  { id: "a", provider: "anthropic", nickname: "Anthropic", apiKey: "k", createdAt: 1 },
  { id: "o", provider: "openai", nickname: "OpenAI", apiKey: "k", createdAt: 2 },
];

function open(ui = <ModelPicker instances={insts} currentInstanceId="a" currentModel="claude-opus-4-7" locked={false} onSelect={() => {}} onManage={() => {}} />) {
  render(ui);
  fireEvent.click(screen.getByRole("button", { name: /claude-opus-4-7|Anthropic/i }));
}

describe("ModelPicker", () => {
  it("lists providers at top level", () => {
    open();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
  });

  it("expands a provider to show its models (accordion, one at a time)", () => {
    open();
    fireEvent.click(screen.getByText("OpenAI"));
    expect(screen.getByText("gpt-4o")).toBeInTheDocument(); // registry model
  });

  it("filters models within the expanded provider only", () => {
    open();
    fireEvent.click(screen.getByText("OpenAI"));
    fireEvent.change(screen.getByPlaceholderText(/OpenAI/i), { target: { value: "mini" } });
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.queryByText("gpt-4o")).toBeNull(); // 非匹配隐藏
  });

  it("calls onSelect with (instanceId, model) on model click", () => {
    const onSelect = vi.fn();
    render(<ModelPicker instances={insts} currentInstanceId="a" currentModel="claude-opus-4-7" locked={false} onSelect={onSelect} onManage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Anthropic|claude-opus-4-7/i }));
    fireEvent.click(screen.getByText("OpenAI"));
    fireEvent.click(screen.getByText("gpt-4o"));
    expect(onSelect).toHaveBeenCalledWith("o", "gpt-4o");
  });

  it("does not open when locked", () => {
    render(<ModelPicker instances={insts} currentInstanceId="a" currentModel="claude-opus-4-7" locked={true} onSelect={() => {}} onManage={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("OpenAI")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 实现组件**

参考 `InstanceSelector.tsx` 的 popover 骨架（向上弹、click-outside、locked 锁）+ `ModelDropdown.tsx` 的 model 列表/搜索/胶囊逻辑，合并为手风琴。要点：
- 顶层 chip：`<ProviderIcon provider={current.provider} size={16}/>` + `provider · short(model)` + chevron。
- 弹层 header + 每个 instance 一行 Provider（`<ProviderIcon size={22}/>` + name + 上次 model 弱色 / 当前 accent + chevron）。
- `expandedId` state：同时只展开一个；展开区含搜索 `input`（placeholder 含 provider 名）+ model 子列表（`max-h-[240px] overflow-y-auto`）。
- model 列表构建复用 ModelDropdown 的 `registry → fetched → customModels` dedup 逻辑（抽成本组件内辅助 `modelsFor(inst)`；返回 `{id, meta?, isCustom}[]`）。
- 选中项 ✓；点 model 调 `onSelect(inst.id, model)` 并关闭。
- lazy provider（`getProviderMeta(p)?.models.length === 0`）首展开调 `onRefreshModels?.(inst.id)`。
- 底部「管理 / 新建 Provider」→ `onManage`。
- `short(model)`：复用 InstanceSelector 的 `shortModel`。

（完整 JSX 按上述结构编写；样式 token 沿用 `bg-surface`/`bg-field`/`border-line`/`text-fg-1/2/3`/`text-accent`，字号 `text-[12px]`/`text-[10px]`，model 用 `font-mono`。）

- [ ] **Step 4: 运行确认通过** → `pnpm test src/sidepanel/components/ModelPicker.test.tsx` PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ModelPicker.tsx src/sidepanel/components/ModelPicker.test.tsx
git commit -m "feat(composer): add ModelPicker accordion (provider → model, in-provider search)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Chat.tsx 用 ModelPicker 取代 InstanceSelector + 删旧组件

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`
- Delete: `src/sidepanel/components/InstanceSelector.tsx`, `src/sidepanel/components/InstanceSelector.test.tsx`

- [ ] **Step 1: 替换渲染（L1844 区）**

把 `<InstanceSelector .../>` 换成：
```tsx
<ModelPicker
  instances={instances}
  currentInstanceId={currentInstanceId}
  currentModel={currentModel}
  locked={taskLocked /* 沿用原 InstanceSelector locked 表达式 */}
  onManage={/* 沿用原 onManage */}
  onSelect={(instanceId, model) => {
    setCurrentInstanceId(instanceId);
    setCurrentModel(model);
    void persistSelection(instanceId, model);        // 写 session meta（Task 8 helper）
    void setLastModelSelection({ instanceId, model }); // 写全局上次选择
  }}
  onRefreshModels={(instanceId) => { /* openrouter: 复用 Settings 的 fetchOpenRouterModels + updateInstance */ }}
/>
```
更新 import：删 `import InstanceSelector` → 加 `import ModelPicker`，`import { setLastModelSelection } from "@/lib/last-model-selection";`。

- [ ] **Step 2: 删旧组件 + 测试**

```bash
git rm src/sidepanel/components/InstanceSelector.tsx src/sidepanel/components/InstanceSelector.test.tsx
```

- [ ] **Step 3: 修 Chat.test.tsx 残留断言**

把 Chat.test.tsx 中 InstanceSelector 相关断言（L1106 区）改为针对 ModelPicker chip 文案。

Run: `pnpm test src/sidepanel/components/Chat.test.tsx` → 绿。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(composer): wire ModelPicker into Chat, remove InstanceSelector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Phase 3 收尾:** `pnpm typecheck`；Composer 链路消红。

---

## Phase 4 — 设置页改造

### Task 11: `ProviderModelList` 组件（模型列表区）

**Files:**
- Create: `src/sidepanel/components/ProviderModelList.tsx`
- Test: `src/sidepanel/components/ProviderModelList.test.tsx`

从 `ModelDropdown.tsx` 重构：不再是「选当前 model 的下拉」，而是「展示+管理 provider 的模型列表」。内置模型只读（带胶囊，无操作）；自定义模型可 ✎ 编辑 / × 删除；底部「+ 添加自定义模型」（弹 `ModelMetaEditor`）。**不含「选中当前 model」语义**（选模型已移到 Composer）。

**Props：**
```ts
interface Props {
  provider: ProviderRef;
  customModels: string[];
  customModelMetas?: Record<string, StoredCustomModelMeta>;
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  onAddCustom?: (id: string, meta: StoredCustomModelMeta) => void;
  onUpdateCustomMeta?: (id: string, meta: StoredCustomModelMeta) => void;
  onRemoveCustom?: (id: string) => void;
  onRefresh?: () => void;
}
```

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import ProviderModelList from "./ProviderModelList";

describe("ProviderModelList", () => {
  it("renders builtin models read-only (no edit/remove buttons)", () => {
    render(<ProviderModelList provider="openai" customModels={[]} />);
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.queryByLabelText("edit")).toBeNull();
    expect(screen.queryByLabelText("remove")).toBeNull();
  });

  it("renders custom models with edit + remove", () => {
    render(<ProviderModelList provider="openai" customModels={["ft-x"]} onRemoveCustom={() => {}} onUpdateCustomMeta={() => {}} />);
    expect(screen.getByText("ft-x")).toBeInTheDocument();
    expect(screen.getByLabelText("edit")).toBeInTheDocument();
  });

  it("calls onRemoveCustom when × clicked", () => {
    const onRemove = vi.fn();
    render(<ProviderModelList provider="openai" customModels={["ft-x"]} onRemoveCustom={onRemove} />);
    fireEvent.click(screen.getByLabelText("remove"));
    expect(onRemove).toHaveBeenCalledWith("ft-x");
  });

  it("opens ModelMetaEditor on + add", () => {
    render(<ProviderModelList provider="openai" customModels={[]} onAddCustom={() => {}} />);
    fireEvent.click(screen.getByText(/添加自定义模型|Add custom model/));
    expect(screen.getByLabelText(/model id|模型 id/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 实现** —— 复制 `ModelDropdown.tsx` 的列表/dedup/ModelMetaEditor 接线，删掉 `value`/`onChange`/选中 ✓ 逻辑与外层 toggle button，改为常驻列表 + 内置/自定义分组（内置只读）。`onAddCustom`/`onUpdateCustomMeta`/`onRemoveCustom`/`onRefresh` 透传 ModelMetaEditor（沿用 ModelDropdown 中的 editing state 与 ModelMetaEditor 用法）。

- [ ] **Step 4: 运行确认通过** → `pnpm test src/sidepanel/components/ProviderModelList.test.tsx` PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ProviderModelList.tsx src/sidepanel/components/ProviderModelList.test.tsx
git commit -m "feat(settings): add ProviderModelList (builtin read-only + custom CRUD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `InstanceForm` 去 model 字段，内嵌 ProviderModelList

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`

- [ ] **Step 1: 改 payload 与字段**

- `InstanceFormPayload`：删除 `model: string;`（保留 `nickname`/`apiKey`/`customModels`）。
- 删除 `model` state、`initialModel` prop、`canSave` 里 `model.trim().length > 0` 条件（改为仅 key 条件）。
- 删除 `<Field label={model}>` 整块 `<ModelDropdown .../>`；替换为 `<Field label={t("instanceForm.models")}>` 包 `<ProviderModelList .../>`，透传 `provider/customModels/customModelMetas/fetchedModels/fetchedAt/isFetching/onAddCustom/onUpdateCustomMeta/onRemoveCustom/onRefresh`（这些回调 InstanceForm 已从父接收，原先转发给 ModelDropdown 的接线照搬到 ProviderModelList；删去 onChange/setModel 相关）。
- `payload` 去掉 model。
- import：删 `ModelDropdown` → 加 `ProviderModelList`；在头部加 `<ProviderIcon>` 到 provider 字段（可选美化）。

- [ ] **Step 2: typecheck（暴露 Settings 调用处的 model 入参）**

Run: `pnpm typecheck` → InstanceForm 自身无错；Settings.tsx 报 model 相关（Task 13 修）。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx
git commit -m "refactor(settings): InstanceForm drops model field, embeds ProviderModelList

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: `Settings.tsx` 去 ActiveSection / Activate / model

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`

- [ ] **Step 1: 改编排**

- 删除 `<ActiveSection .../>` 渲染 + `ActiveSection` 函数定义 + `activeId` state 相关「无 active 警告」。`activeId` state 可删（InstancesList 不再需要 active 概念——见 Task 14）。
- `reload()`：删 `setActiveId(await getActiveInstance())`（连同 state）。
- `handleCreate`：`createInstance({ provider, ...payload })` —— payload 已无 model，保持。
- `handleSaveEdit`：删 `model: payload.model`，patch 仅 `nickname`（+ 条件 apiKey）。
- `handleTest`：`payload.model` 不再存在 —— test 需要一个 model 做连通性校验。改为用该 provider 第一个 model：`const model = await firstModelForProvider(provider, id ?? undefined);` 然后 `cfg.model = model ?? ""`（import `firstModelForProvider`）。
- `<InstancesList>` props：去 `activeId`/`onSetActive`（Task 14 改 props）。`renderForm` 里 `initialModel={inst.model}` 删除；InstanceForm 调用去 model。
- `FeedbackSection` 的 `providerModel`：`activeInstance` 概念没了 —— 改用 `last_model_selection` 或简化为 `(no model context)`；MVP：传第一个 instance 的 provider，model 留空。或读 `getLastModelSelection()`。简化处理并在注释说明。

- [ ] **Step 2: typecheck + 跑 Settings 相关测试** → 绿。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/Settings.tsx
git commit -m "refactor(settings): drop active/model; provider-only config orchestration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: `InstancesList` 去 model/Activate + 加图标

**Files:**
- Modify: `src/sidepanel/components/InstancesList.tsx`

- [ ] **Step 1: 改 props 与渲染**

- Props：删 `activeId`/`onSetActive`。
- 行渲染：删 active 圆点 + Activate 按钮 + `inst.model` 显示。改为：左侧 `<ProviderIcon provider={inst.provider} size={26}/>`，主行 `nickname`，副行 `maskKey(inst.apiKey)`（去掉 `inst.model · `），右侧展开 chevron。
- 见 Paper 终稿「FINAL — Settings · Providers」折叠行。

- [ ] **Step 2: typecheck（Settings 已在 Task 13 去掉 activeId/onSetActive 传参，应匹配）** → 绿。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/InstancesList.tsx
git commit -m "refactor(settings): InstancesList provider rows (icon, no model/activate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: `App.tsx` provider label 去 model + 删 ModelDropdown

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Delete: `src/sidepanel/components/ModelDropdown.tsx`, `src/sidepanel/components/ModelDropdown.test.tsx`

- [ ] **Step 1: 改 App.tsx（L173 区）**

`getActiveInstance` + `getInstance` 构造的 provider label（`${nickname} · ${inst.model}`）—— `inst.model` 不存在了。改为用 `resolveSelection({})` 取兜底 `(instanceId, model)`，label = `${nickname} · ${model}`；或简化为仅 provider/nickname。按 App.tsx 该 label 的实际用途（grep 使用处）决定最简表达，保持 UI 不崩。

- [ ] **Step 2: 删 ModelDropdown（已被 ProviderModelList 取代）**

```bash
git rm src/sidepanel/components/ModelDropdown.tsx src/sidepanel/components/ModelDropdown.test.tsx
```
确认无其他引用：`grep -rn ModelDropdown src`（应只剩 0 处）。

- [ ] **Step 3: typecheck + test** → 绿。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(app): provider label without model; remove ModelDropdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Phase 4 收尾:** `pnpm typecheck` 全绿。

---

## Phase 5 — i18n + 全量验证

### Task 16: i18n 文案（中英双语同步）

**Files:**
- Modify: i18n 文件（grep `instanceForm.model`、`instancesList.activate`、`settings.active`、`instanceSelector.*` 定位中英两份；见 `src/lib/i18n`）

- [ ] **Step 1: 新增/调整 key（中英都改）**

- 新增：`instanceForm.models`（"模型列表" / "Models"）、`modelPicker.*`（标题/搜索 placeholder/未使用/manage 等，参考被删的 `instanceSelector.*` 复用文案）、`providerModelList.*`（添加自定义模型/自定义分组标题，复用旧 `modelDropdown.*`）。
- 删除（或保留无害）：`instancesList.activate`、`settings.active`、`settings.noActiveConfig`、`instanceForm.model`、`instanceSelector.*`、`modelDropdown.*` 中已无引用者。grep 确认无残留引用再删。
- **双语必须各自用对应语言**（见项目约定 dual i18n）。

- [ ] **Step 2: typecheck + 全量 test**

Run: `pnpm typecheck && pnpm test`
Expected: 0 type 错；全部测试绿。修复任何因文案 key 改动导致的测试断言。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "i18n: model picker / provider model list copy; drop active/model strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: 全量验证 + 构建

**Files:** 无（验证）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（含新增 ProviderIcon/ModelPicker/ProviderModelList/last-model-selection/model-selection-resolver/migrate-instance-model 测试；删掉的 InstanceSelector/ModelDropdown 测试已移除）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 3: 构建（验证 build-time invariants + public/ 拷贝）**

Run: `pnpm build`
Expected: 成功；确认 `dist/provider-icons/*.svg` 存在（`ls dist/provider-icons | wc -l` = 10）。

- [ ] **Step 4: 手动验证清单（加载 dist/ 到 Chrome）**

- [ ] 设置页：Provider 列表无 model/无 Activate；展开编辑卡有「模型列表」（内置只读 + 自定义可增删改）；图标显示正确（深色背景可见——若不可见，回 Task 2 Step 3b 切 mask）。
- [ ] Composer：模型选择器手风琴展开；Provider 内搜索；选 model 后 chip 更新；新开会话继承上次选择。
- [ ] 迁移：用旧版数据（同 provider 多 key + instance.model）升级后，合并正确、首会话沿用老模型。
- [ ] bailian 走 monogram（无图标）。

- [ ] **Step 5: 最终 commit（若手测有微调）**

```bash
git add -A
git commit -m "chore: provider/model decouple — final verification fixes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

实现完成、全部验证通过后，用 `superpowers:finishing-a-development-branch` 决定合并/PR。spec §11 测试要点与本计划 Task 17 手测清单是验收依据。

## 风险与备注

- **迁移不可逆 + 丢 key**（D7）：个人 BYOK 可接受；Task 5 已做幂等 + last_model_selection 种子保证模型连续性。
- **图标 currentColor 着色**：`<img>` 对独立 svg 不随父 color 变；若深色不可见走 Task 2 Step 3b 的 CSS mask（spec §8 已记约定）。
- **循环依赖**：`firstModelForProvider` 定义在 `instances.ts`、resolver import 它（Task 7 Step 3 已说明方向），避免 resolver↔instances 循环。
- **lazy provider（openrouter）**：ModelPicker 首展开 fetch，复用 Settings 既有 `fetchOpenRouterModels` + `updateInstance({fetchedModels,fetchedAt})` 接线。
- **eval-bridge**：`active_instance_id` + `resolveActiveInstanceModelConfig` 保留（eval 专用），其语义改为「active instance + provider 第一个 model」。
