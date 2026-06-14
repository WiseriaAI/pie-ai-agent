# P3-A 多模型切换 · 客户端实施计划（pie-ai-agent）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 managed（Pie 官方订阅）在现有聊天级 `ModelPicker` 里展开成 N 个模型（数据来自 `entitlement.models[]`），按会话切换、按模型正确判定 vision/上下文，渲染为「名字 + 描述 + vision 徽标 + 消耗点」两行式。

**Architecture:** 契约 `ModelInfo` 扩字段（description?/vision/maxContextTokens/costLevel）。`getEntitlement` 带客户端 locale。模型源对 managed 改读进程内缓存 entitlement（P2 已有 `getCachedEntitlement`）；一个中心助手 `cachedManagedModel(apiKey,id)` 把 vision/上下文解析在 `instances.ts` 与 `Chat.tsx` 两处 DRY 复用；缓存未就绪回退 registry 单条；持久化的失效 alias 回退 `models[0]`。

**Tech Stack:** React 19 + TS · Tailwind v4（CSS-first，语义 class 自动明暗）· vitest + @testing-library/react。

**前置依赖：** 后端计划（契约 v2.1 + `?locale=`）已落。spec：`/Users/wenkang/repos/pie/docs/brainstorming/2026-06-14-managed-provider-p3-multi-model-design.md`。Paper 原型 artboard `P3 — Model Picker · Managed Expanded (Modern A)`。

**测试命令：** `pnpm test <file>`（单测）；提交前 `pnpm test` + `pnpm build`（构建期不变量会 throw）。

**约束：** managed 模型名/描述来自后端（不进客户端字典）；客户端只新增 chrome 文案「消耗」。`tools` 对 managed 一律视 true。`costLevel` 是相对档（非美元）。

---

## 文件结构（先锁定职责）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/lib/managed-auth.ts` | 改 | `ModelInfo` 扩 `{description?,vision,maxContextTokens,costLevel}` |
| `src/lib/managed-account.ts` | 改 | `getEntitlement` 带 `?locale=`；`normalizeEntitlement` 补每模型默认；新增 `cachedManagedModel(apiKey,id)` 中心助手 |
| `src/lib/managed-format.ts` | 改 | 新增纯函数 `consumptionDots(costLevel)` |
| `src/sidepanel/components/ModelPicker.tsx` | 改 | `modelsFor` managed 分支读缓存；`ModelRow.managed`；`ExpandedModels` managed 渲染（名/描述/vision/消耗点、无搜索框）；折叠态/触发器显示模型名 |
| `src/lib/instances.ts` | 改 | `resolveModelConfig` managed vision + 失效 alias 回退；`firstModelForProvider` managed 默认 = `models[0]` |
| `src/sidepanel/components/Chat.tsx` | 改 | vision/maxContextTokens 解析对 managed 走 `cachedManagedModel` |
| `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts` | 改 | `managed.models.consumption` 6 语 |
| 各 `*.test.ts(x)` | 改/加 | 见各 Task |
| `CLAUDE.md`（本仓相关段，如有 managed 说明） | 改 | 备注 managed 多模型来自 entitlement |

类型契约（贯穿全程）：

```ts
// managed-auth.ts —— 与后端契约 v2.1 对齐
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  vision: boolean;
  maxContextTokens: number;
  costLevel: 1 | 2 | 3;
}
```

---

## Task 1: 契约类型扩展 + locale 入参 + normalize 默认 + 中心助手

**Files:**
- Modify: `src/lib/managed-auth.ts`
- Modify: `src/lib/managed-account.ts`
- Test: `src/lib/managed-account.test.ts`

- [ ] **Step 1: 改测试（先失败）**

在 `src/lib/managed-account.test.ts`：

1) 顶部 import 增 `cachedManagedModel`：

```ts
import { getCachedEntitlement, getEntitlement, openCheckout, openPortal, cachedManagedModel } from "./managed-account";
```

2) 第一个用例替换为带 locale + 全模型字段：

```ts
  it("getEntitlement GETs /me/entitlement?locale= with Bearer and parses v2.1", async () => {
    const v2 = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
      quota: { weekly: { usedFraction: 0.5, resetAt: 1750400000 } },
      models: [{ id: "default", name: "标准", description: "快", vision: false, maxContextTokens: 128000, costLevel: 1 }],
    };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => v2 })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/me/entitlement?locale=en", {
      headers: { authorization: "Bearer sk-virtual" },
    });
    expect(res).toEqual(v2);
  });
```

3) normalize 用例追加「模型字段补默认」断言（替换原 normalize 用例）：

```ts
  it("normalizeEntitlement 容忍缺字段：plan 落 none、数组/对象补默认", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ email: "u@x.com" }) })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn, locale: "en" });
    expect(res).toEqual({ plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] });
  });

  it("normalizeEntitlement 给每个模型补 vision/maxContextTokens/costLevel 默认", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: null, quota: null,
      models: [{ id: "pro", name: "进阶" }, { id: "x", name: "X", vision: true, maxContextTokens: 200000, costLevel: 3, description: "d" }] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-n", { fetchFn, locale: "en" });
    expect(res.models).toEqual([
      { id: "pro", name: "进阶", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "x", name: "X", description: "d", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ]);
  });
```

4) 末尾追加 `cachedManagedModel` 用例：

```ts
  it("cachedManagedModel 按 id 命中缓存模型，未命中/无缓存返回 undefined", async () => {
    const raw = { plan: "active", email: "e", subscription: null, quota: null,
      models: [{ id: "pro", name: "进阶", vision: true, maxContextTokens: 200000, costLevel: 3 }] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    await getEntitlement("sk-cm", { fetchFn, locale: "en" });
    expect(cachedManagedModel("sk-cm", "pro")).toEqual({ id: "pro", name: "进阶", vision: true, maxContextTokens: 200000, costLevel: 3 });
    expect(cachedManagedModel("sk-cm", "nope")).toBeUndefined();
    expect(cachedManagedModel("sk-absent", "pro")).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test managed-account`
Expected: FAIL — URL 不含 `?locale=`；`cachedManagedModel` 未导出；模型默认未补。

- [ ] **Step 3: 实现 `managed-auth.ts` 类型**

把 `src/lib/managed-auth.ts` 的 `ModelInfo` 接口替换为：

```ts
export interface ModelInfo {
  id: string;
  name: string;
  /** 一行能力描述（已按 locale 由后端解析）。 */
  description?: string;
  /** 是否支持图片输入。tools 对 managed 一律视 true。 */
  vision: boolean;
  maxContextTokens: number;
  /** 相对周额度消耗档（1=最省），渲染为 N/3 实心点。 */
  costLevel: 1 | 2 | 3;
}
```

- [ ] **Step 4: 实现 `managed-account.ts`**

在 `src/lib/managed-account.ts`：

1) 顶部 import 增 `getLocale` 与 `ModelInfo`：

```ts
import { ACCOUNT_BASE } from "./managed-config";
import type { Entitlement, ModelInfo } from "./managed-auth";
import { getLocale } from "./i18n";
```

2) `ManagedAccountDeps` 增可选 `locale`：

```ts
export interface ManagedAccountDeps {
  fetchFn?: typeof fetch;
  openTab?: (url: string) => void;
  /** 缺省取当前 UI locale（getLocale()）。 */
  locale?: string;
}
```

3) `getEntitlement` 拼 locale 入参：

```ts
export async function getEntitlement(apiKey: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(`${ACCOUNT_BASE}/me/entitlement?locale=${encodeURIComponent(locale)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Failed to load entitlement (${resp.status})`);
  const ent = normalizeEntitlement(await resp.json());
  entitlementCache.set(apiKey, ent);
  return ent;
}
```

4) `normalizeEntitlement` 增模型逐条归一；新增 `normalizeModel` 与 `cachedManagedModel`：

```ts
function normalizeModel(raw: unknown): ModelInfo {
  const m = (raw ?? {}) as Record<string, unknown>;
  const costLevel = m.costLevel === 2 || m.costLevel === 3 ? m.costLevel : 1;
  return {
    id: String(m.id ?? ""),
    name: typeof m.name === "string" && m.name ? m.name : String(m.id ?? ""),
    ...(typeof m.description === "string" ? { description: m.description } : {}),
    vision: m.vision === true,
    maxContextTokens: typeof m.maxContextTokens === "number" && m.maxContextTokens > 0 ? m.maxContextTokens : 128000,
    costLevel,
  };
}

/** 容忍后端缺字段/新激活边缘：补齐 v2.1 安全默认，绝不抛。 */
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: (r.subscription as Entitlement["subscription"]) ?? null,
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as unknown[]).map(normalizeModel) : [],
  };
}

/** managed 选中模型的元数据（从进程内缓存按 id 查），供 vision/上下文解析复用。无缓存/未命中 → undefined。 */
export function cachedManagedModel(apiKey: string, modelId: string): ModelInfo | undefined {
  return getCachedEntitlement(apiKey)?.models.find((m) => m.id === modelId);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test managed-account`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/lib/managed-auth.ts src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): entitlement v2.1 model fields + ?locale= + cachedManagedModel"
```

---

## Task 2: 消耗点纯函数 `consumptionDots`

**Files:**
- Modify: `src/lib/managed-format.ts`
- Test: `src/lib/managed-format.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/managed-format.test.ts` 末尾追加：

```ts
import { consumptionDots } from "./managed-format";

describe("consumptionDots", () => {
  it("costLevel → 3 个布尔（实心数 = level）", () => {
    expect(consumptionDots(1)).toEqual([true, false, false]);
    expect(consumptionDots(2)).toEqual([true, true, false]);
    expect(consumptionDots(3)).toEqual([true, true, true]);
  });
  it("越界值收敛到 1..3", () => {
    expect(consumptionDots(0)).toEqual([true, false, false]);
    expect(consumptionDots(9)).toEqual([true, true, true]);
  });
});
```

（若文件顶部已 import 过 `describe/it/expect`，复用即可，勿重复 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test managed-format`
Expected: FAIL — `consumptionDots` 未导出。

- [ ] **Step 3: 实现**

在 `src/lib/managed-format.ts` 末尾追加：

```ts
/** 相对消耗档 → 3 个点的实心/空布尔数组（实心数 = clamp(level,1,3)）。渲染「消耗 ●●○」。 */
export function consumptionDots(costLevel: number): [boolean, boolean, boolean] {
  const filled = Math.max(1, Math.min(3, Math.round(costLevel)));
  return [filled >= 1, filled >= 2, filled >= 3];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test managed-format`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/managed-format.ts src/lib/managed-format.test.ts
git commit -m "feat(managed): consumptionDots pure helper for costLevel rendering"
```

---

## Task 3: `modelsFor` managed 分支（读缓存 entitlement）

**Files:**
- Modify: `src/sidepanel/components/ModelPicker.tsx`
- Test: `src/sidepanel/components/ModelPicker.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `src/sidepanel/components/ModelPicker.test.tsx` 末尾追加：

```ts
import { getEntitlement } from "@/lib/managed-account";

describe("modelsFor managed", () => {
  it("从缓存 entitlement 出多模型行（携 managed 元数据）", async () => {
    const ent = { plan: "active", email: "e", subscription: null, quota: null, models: [
      { id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "pro", name: "进阶", description: "更强", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    await getEntitlement("sk-managed", { fetchFn, locale: "en" }); // 播种进程内缓存
    const rows = modelsFor(inst({ provider: "managed", apiKey: "sk-managed" }));
    expect(rows.map((r) => r.id)).toEqual(["default", "pro"]);
    expect(rows[1]!.managed).toMatchObject({ id: "pro", name: "进阶", vision: true, costLevel: 3 });
  });

  it("无缓存时回退 registry 单条 default", () => {
    const rows = modelsFor(inst({ provider: "managed", apiKey: "sk-cold" }));
    expect(rows.map((r) => r.id)).toEqual(["default"]);
    expect(rows[0]!.managed).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test ModelPicker`
Expected: FAIL — managed 行无 `managed` 字段 / 从 registry 而非缓存。

- [ ] **Step 3: 实现 `modelsFor`**

在 `src/sidepanel/components/ModelPicker.tsx`：

1) 顶部 import 增：

```ts
import { getCachedEntitlement } from "@/lib/managed-account";
import type { ModelInfo } from "@/lib/managed-auth";
```

2) `ModelRow` 接口加 `managed?`：

```ts
interface ModelRow {
  id: string;
  meta?: ModelMeta;
  isCustom: boolean;
  /** 仅 managed provider：承载 entitlement 模型元数据（名/描述/vision/costLevel）。 */
  managed?: ModelInfo;
}
```

3) `modelsFor` 开头加 managed 分支（在现有 registry/fetched/custom 逻辑之前）：

```ts
export function modelsFor(inst: DecryptedInstance): ModelRow[] {
  if (inst.provider === "managed") {
    const cached = getCachedEntitlement(inst.apiKey)?.models ?? [];
    if (cached.length > 0) return cached.map((m) => ({ id: m.id, isCustom: false, managed: m }));
    // 缓存未就绪：回退 registry 单条兜底（保证不空）。
  }
  const isCustom = inst.provider.startsWith(CUSTOM_PREFIX);
  // …（以下维持原实现不变）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test ModelPicker`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ModelPicker.tsx src/sidepanel/components/ModelPicker.test.tsx
git commit -m "feat(ModelPicker): modelsFor managed reads cached entitlement models"
```

---

## Task 4: ModelPicker managed 行渲染 + 折叠态显示名 + 隐藏搜索框

**Files:**
- Modify: `src/sidepanel/components/ModelPicker.tsx`
- Test: `src/sidepanel/components/ModelPicker.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `ModelPicker.test.tsx` 的 `describe("modelsFor managed")` 之后追加渲染测试（无需 I18nProvider——provider 外 `t()` 回退英文，与现有 ModelPicker 测试一致）：

```ts
describe("ModelPicker managed rendering", () => {
  async function seedManaged() {
    const ent = { plan: "active", email: "e", subscription: null, quota: null, models: [
      { id: "default", name: "标准", description: "快速经济", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "pro", name: "进阶", description: "推理更强", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    await getEntitlement("sk-m", { fetchFn, locale: "en" });
  }
  const managedInsts: DecryptedInstance[] = [{ id: "m", provider: "managed", nickname: "Pie", apiKey: "sk-m", createdAt: 1 }];

  it("展开 managed 显示模型名+描述，不显示原始 id，不显示搜索框", async () => {
    await seedManaged();
    render(<ModelPicker instances={managedInsts} currentInstanceId="m" currentModel="default" locked={false} onSelect={() => {}} onManage={() => {}} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByText("Pie 官方订阅"));
    expect(screen.getByText("标准")).toBeTruthy();
    expect(screen.getByText("推理更强")).toBeTruthy();
    // managed 列表无 provider 内搜索框（其 aria-label 含 provider 名）
    expect(screen.queryByRole("textbox", { name: /Pie/i })).toBeNull();
  });

  it("点选 managed 模型回传 alias id", async () => {
    await seedManaged();
    const onSelect = vi.fn();
    render(<ModelPicker instances={managedInsts} currentInstanceId="m" currentModel="default" locked={false} onSelect={onSelect} onManage={() => {}} />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    fireEvent.click(screen.getByText("Pie 官方订阅"));
    fireEvent.click(screen.getByText("进阶"));
    expect(onSelect).toHaveBeenCalledWith("m", "pro");
  });
});
```

> 注：`providerName(managedInst)` 走 `getProviderMeta("managed")?.name` = "Pie 官方订阅"（registry 的 locale-neutral 兜底名，与现状一致）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test ModelPicker`
Expected: FAIL — managed 行仍渲染 mono id「pro」而非「进阶」；仍有搜索框。

- [ ] **Step 3: 实现渲染**

在 `src/sidepanel/components/ModelPicker.tsx`：

1) 顶部 import 增消耗点助手：

```ts
import { consumptionDots } from "@/lib/managed-format";
```

2) `ExpandedModels` 内：当该 instance 是 managed 时，跳过搜索框、对每行走 managed 渲染。把 `ExpandedModels` 的 return 改为按 `isManaged` 分流。

在 `ExpandedModels` 顶部加：

```ts
  const isManaged = props.inst.provider === "managed";
  const rows = modelsFor(props.inst);
  const q = props.query.trim().toLowerCase();
  const list = isManaged
    ? rows
    : q
      ? rows.filter((r) => `${r.id} ${r.meta?.displayName ?? ""}`.toLowerCase().includes(q))
      : rows;
```

把搜索 `<input>` 包到 `{!isManaged && ( … )}`：

```tsx
      {!isManaged && (
        <input
          ref={inputRef}
          aria-label={props.placeholder}
          value={props.query}
          onChange={(e) => props.setQuery(e.target.value)}
          placeholder={props.placeholder}
          className="mx-3.5 mb-1 rounded border border-line bg-field px-2 py-1 text-[11px] text-fg-1 placeholder:text-fg-3"
        />
      )}
```

把每行的 `list.map(...)` 渲染改为分流：managed 行用两行式，否则维持原 mono 行。替换 `list.map` 块为：

```tsx
        {list.map((r) =>
          r.managed ? (
            <button
              key={r.id}
              onClick={() => props.onPick(r.id)}
              className={`flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-surface ${r.id === props.currentModel ? "bg-surface" : ""}`}
            >
              <span className="flex shrink-0 items-center justify-center" style={{ width: 22 }} aria-hidden>
                {r.id === props.currentModel && (
                  <svg width="11" height="11" viewBox="0 0 11 11">
                    <path d="M2 5.5L4.5 8L9 3" fill="none" stroke="#B8C8D6" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="truncate text-[13px] font-medium text-fg-1">{r.managed.name}</span>
                {r.managed.description && <span className="truncate text-[11px] text-fg-3">{r.managed.description}</span>}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-[3px]">
                <span className="flex h-4 items-center">
                  {r.managed.vision && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.vision")}</span>}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[9px] text-fg-3">{t("managed.models.consumption")}</span>
                  <span className="flex items-center gap-[3px]">
                    {consumptionDots(r.managed.costLevel).map((on, i) => (
                      <span key={i} className={`h-1 w-1 rounded-full ${on ? "bg-fg-3" : "bg-line"}`} />
                    ))}
                  </span>
                </span>
              </span>
            </button>
          ) : (
            <button
              key={r.id}
              onClick={() => props.onPick(r.id)}
              className={`flex items-center gap-2 px-3.5 py-1.5 pl-7 text-left hover:bg-surface ${r.id === props.currentModel ? "bg-surface" : ""}`}
            >
              <span className="flex shrink-0 items-center justify-center" style={{ width: 13 }} aria-hidden>
                {r.id === props.currentModel && (
                  <svg width="11" height="11" viewBox="0 0 11 11">
                    <path d="M2 5.5L4.5 8L9 3" fill="none" stroke="#B8C8D6" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-1">{r.id}</span>
              {r.meta?.vision && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.vision")}</span>}
              {r.meta?.tools && <span className="rounded bg-line px-1 text-[9px] text-fg-3">{t("modelDropdown.tools")}</span>}
            </button>
          ),
        )}
```

3) 折叠态/触发器显示模型名（managed 用 `name`）。在文件内 `shortModel` 旁加局部助手：

```ts
function displayModel(inst: DecryptedInstance | null, modelId: string | null): string {
  if (!inst || !modelId) return shortModel(modelId ?? "");
  if (inst.provider === "managed") return cachedManagedModel(inst.apiKey, modelId)?.name ?? modelId;
  return shortModel(modelId);
}
```

import 增 `cachedManagedModel`：

```ts
import { getCachedEntitlement, cachedManagedModel } from "@/lib/managed-account";
```

把触发器按钮的模型文案（约第 123 行）与展开列表里折叠 provider 行的当前模型（约第 164 行）从 `shortModel(props.currentModel ?? "")` / `shortModel(props.currentModel)` 改为 `displayModel(current, props.currentModel)`（触发器处 `current` 即 `props.instances.find(i=>i.id===props.currentInstanceId) ?? null`）。展开列表折叠行处用 `displayModel(inst, props.currentModel)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test ModelPicker`
Expected: PASS（含 Task 3 用例 + 本任务渲染用例 + 原有用例不回归）

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ModelPicker.tsx src/sidepanel/components/ModelPicker.test.tsx
git commit -m "feat(ModelPicker): managed two-line rows (name/desc/vision/consumption), no search, name in collapsed"
```

---

## Task 5: `instances.ts` managed vision + 默认 + 失效 alias 回退

**Files:**
- Modify: `src/lib/instances.ts`
- Test: `src/lib/instances.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/instances.test.ts` 顶层已有 `beforeEach(async () => { await _resetForTests(); _resetKeyForTests(); })`（文件级，作用于所有 describe），故每个 `it` 都是干净 IDB——连续建 managed 实例**不会**撞「同 provider 只能一个 config」守卫。`createInstance`/`firstModelForProvider`/`resolveModelConfig` 已在文件顶部 import，**勿重复 import**。

需要补两处 import：① 顶部 vitest import 加 `vi`（现为 `import { describe, it, expect, beforeEach } from "vitest"` → 加 `vi`）；② 新增 `import { getEntitlement } from "./managed-account";`。

> 注：`entitlementCache`（managed-account.ts 模块级）不被 `_resetForTests` 清；各用例用**不同 apiKey**（sk-im1/2/3）规避串扰。`createInstance` 加密、`getInstance` 解密用同一把（每测试重置但测试内一致）测试 key，故 `inst.apiKey` 原样回到明文 "sk-imN"，与播种缓存的 key 一致。

在 `src/lib/instances.test.ts` 末尾追加：

```ts
describe("instances managed multi-model", () => {
  async function seed(apiKey: string, models: unknown[]) {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      plan: "active", email: "e", subscription: null, quota: null, models,
    }) })) as unknown as typeof fetch;
    await getEntitlement(apiKey, { fetchFn, locale: "en" });
  }

  it("firstModelForProvider(managed) = 缓存 models[0]", async () => {
    const id = await createInstance({ provider: "managed", nickname: "Pie", apiKey: "sk-im1" });
    await seed("sk-im1", [
      { id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 },
      { id: "pro", name: "进阶", vision: true, maxContextTokens: 200000, costLevel: 3 },
    ]);
    expect(await firstModelForProvider("managed", id)).toBe("default");
  });

  it("resolveModelConfig(managed) vision 取自缓存所选模型", async () => {
    const id = await createInstance({ provider: "managed", nickname: "Pie", apiKey: "sk-im2" });
    await seed("sk-im2", [{ id: "pro", name: "进阶", vision: true, maxContextTokens: 200000, costLevel: 3 }]);
    const cfg = await resolveModelConfig(id, "pro");
    expect(cfg?.vision).toBe(true);
    expect(cfg?.model).toBe("pro");
  });

  it("resolveModelConfig(managed) 失效 alias 回退 models[0]", async () => {
    const id = await createInstance({ provider: "managed", nickname: "Pie", apiKey: "sk-im3" });
    await seed("sk-im3", [{ id: "default", name: "标准", vision: false, maxContextTokens: 128000, costLevel: 1 }]);
    const cfg = await resolveModelConfig(id, "gone-alias");
    expect(cfg?.model).toBe("default");
  });
});
```

> 若 `instances.test.ts` 现有用例运行在带 fake-IDB 的环境（vitest setup 提供），上面 `createInstance` 可直接用。若否，改用 `getInstance` mock——先读文件首部确认其测试基建后再定。**实现前先 `pnpm test instances` 跑一遍现状，确认 IDB 基建可用。**

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test instances`
Expected: FAIL — managed 默认仍回 registry "default" 即便缓存空时也对（首个用例可能因恰好回 default 而误过；第二、三用例必失败：vision 未取缓存、失效 alias 未回退）。

- [ ] **Step 3: 实现 `instances.ts`**

1) 顶部 import 增：

```ts
import { getCachedEntitlement, cachedManagedModel } from "@/lib/managed-account";
```

2) `resolveModelConfig`：在 `const inst = await getInstance(instanceId); if (!inst) return null;` 之后、解析 meta 之前，加 managed 失效 alias 回退；并在 vision 解析处加 managed 分支：

```ts
  // managed：失效 alias（缓存里没有且缓存非空）回退到 models[0]，保证送出的 model 合法。
  let effectiveModel = model;
  if (inst.provider === "managed") {
    const ms = getCachedEntitlement(inst.apiKey)?.models ?? [];
    if (ms.length > 0 && !ms.some((m) => m.id === model)) effectiveModel = ms[0]!.id;
  }
```

把后续所有用到 `model` 处改用 `effectiveModel`（vision 解析、`model` 字段、maxOutputTokens 解析）。vision 解析分支改为：

```ts
  let vision: boolean | undefined;
  if (inst.provider === "managed") {
    vision = cachedManagedModel(inst.apiKey, effectiveModel)?.vision;
  } else if (inst.provider.startsWith("custom:")) {
    vision = await resolveCustomModelVision(inst.provider, effectiveModel);
  } else {
    vision = resolveModelVision(inst.provider as BuiltinProvider, effectiveModel, inst.fetchedModels);
    if (vision === undefined) {
      vision = (await resolveModelMeta(inst.provider, effectiveModel))?.vision;
    }
  }
  const maxOutputTokens = (await resolveModelMeta(inst.provider, effectiveModel))?.maxOutputTokens;
  return {
    provider: inst.provider,
    providerName: meta.name,
    model: effectiveModel,
    apiKey: inst.apiKey,
    baseUrl: variant?.baseUrl ?? meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
    ...(maxOutputTokens != null && { maxOutputTokens }),
    ...(vision !== undefined && { vision }),
  };
```

3) `firstModelForProvider`：在函数体取得 `inst` 后、读 `customModels` 之前，加 managed 分支：

```ts
  if (provider === "managed" && inst) {
    const first = getCachedEntitlement(inst.apiKey)?.models[0]?.id;
    if (first) return first;
    // 缓存空 → 落到下方 registry 单条兜底
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test instances`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(instances): managed vision/default from cached entitlement + stale-alias fallback"
```

---

## Task 6: `Chat.tsx` 的 vision/上下文对 managed 走缓存

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（约 588–597 行的 vision/maxContextTokens 解析块）

> Chat 集成路径单测成本高，本任务为薄接线，正确性由 `cachedManagedModel`（Task 1 已测）+ 手动验证保证；不新增 Chat 单测。

- [ ] **Step 1: 实现**

在 `src/sidepanel/components/Chat.tsx`：

1) 顶部 import 增 `cachedManagedModel`（与现有 managed-account import 合并）：

```ts
import { cachedManagedModel } from "@/lib/managed-account";
```

2) 把 588–597 的 `if (inst) { … }` 块改为 managed 分流：

```ts
        if (inst) {
          if (inst.provider === "managed") {
            const mm = cachedManagedModel(inst.apiKey, sel.model);
            setSupportsVision(mm?.vision ?? false);
            setMaxContextTokens(mm?.maxContextTokens);
            return;
          }
          // Vision lookup consults registry first, then instance.fetchedModels
          // (OpenRouter lazy catalog). Fail-closed for unknown ids — the disabled
          // attach button is a visible UX cue.
          setSupportsVision(await resolveSupportsVision(inst.provider, sel.model, inst.fetchedModels));
          const mm = await resolveModelMeta(inst.provider, sel.model);
          setMaxContextTokens(mm?.maxContextTokens);
          return;
        }
```

- [ ] **Step 2: 验证不回归**

Run: `pnpm test Chat`
Expected: PASS（现有 Chat 测试不回归）

- [ ] **Step 3: typecheck**

Run: `pnpm build`
Expected: 构建成功（0 类型错）

- [ ] **Step 4: 提交**

```bash
git add src/sidepanel/components/Chat.tsx
git commit -m "feat(Chat): managed vision/maxContextTokens from cached entitlement model"
```

---

## Task 7: i18n —「消耗」标签 6 语

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`、`zh-CN.ts`、`zh-TW.ts`、`es-419.ts`、`ja.ts`、`pt-BR.ts`
- Test: i18n parity 测试自动覆盖（`src/lib/i18n/__tests__`）

- [ ] **Step 1: en.ts 加 `managed.models`（权威）**

在 `src/lib/i18n/dictionaries/en.ts` 的 `managed` 对象内（`cta` 之后、`}` 之前）加：

```ts
    models: {
      consumption: "Usage",
    },
```

- [ ] **Step 2: 跑 parity 测试确认失败**

Run: `pnpm test i18n`
Expected: FAIL — 其余 5 语缺 `managed.models.consumption`（parity/typecheck 报缺键）。

- [ ] **Step 3: 其余 5 语补同结构**

在每个文件的 `managed` 对象内加 `models: { consumption: "<译文>" }`：

- `zh-CN.ts`：`models: { consumption: "消耗" },`
- `zh-TW.ts`：`models: { consumption: "消耗" },`
- `es-419.ts`：`models: { consumption: "Uso" },`
- `ja.ts`：`models: { consumption: "消費" },`
- `pt-BR.ts`：`models: { consumption: "Uso" },`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test i18n`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/i18n/dictionaries/
git commit -m "i18n(managed): add managed.models.consumption (6 locales)"
```

---

## Task 8: 全量门禁 + 文档备注

**Files:**
- Modify: `CLAUDE.md`（本仓 managed 相关段，若有）
- 验证：全量测试 + 构建

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（含新增/改写用例）。

- [ ] **Step 2: 构建（含构建期不变量）**

Run: `pnpm build`
Expected: 成功输出到 `dist/`，0 类型错。

- [ ] **Step 3: 文档备注**

在 `CLAUDE.md`（pie-ai-agent）managed provider 相关说明处补一句：managed 模型列表来自 `entitlement.models[]`（服务端控制、按 locale 本地化），ModelPicker 对 managed 走专属两行式渲染（名/描述/vision/消耗点），vision/上下文经 `cachedManagedModel` 解析。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: note managed multi-model in ModelPicker (P3-A)"
```

- [ ] **Step 5: 手动联调验证（建议，过 PR 前）**

`pnpm build` 后把 `dist/` 载入扩展，用 managed 账号验证：ModelPicker 展开 managed 显示多模型（名/描述/vision/消耗点）、切换持久化按会话、选 vision 模型可传图、ContextRing 上下文窗口随模型变。

---

## 自检（写完计划后核对）

- **Spec 覆盖**：①ModelInfo 扩字段→Task1 ✓ ②getEntitlement locale→Task1 ✓ ③modelsFor managed 读缓存→Task3 ✓ ④两行式渲染（名/描述/vision/消耗点、无搜索框）→Task4 ✓ ⑤默认 models[0]→Task5 ✓ ⑥失效 alias 回退→Task5 ✓ ⑦缓存未就绪回退 registry 单条→Task3 ✓ ⑧vision/上下文按模型→Task5(instances)/Task6(Chat) ✓ ⑨折叠态显示名→Task4 ✓ ⑩消耗点 i18n→Task7 ✓。
- **类型一致**：`ModelInfo`（managed-auth.ts）在 managed-account/ModelPicker/instances/Chat 全程一致；`cachedManagedModel(apiKey,id): ModelInfo|undefined` 在 instances.ts/Chat.tsx 复用；`consumptionDots(level): [boolean,boolean,boolean]`；`ModelRow.managed?: ModelInfo`。
- **无占位**：每个改动步含完整代码。
- **DRY**：vision/上下文解析收口到 `cachedManagedModel`（两处复用），不散写缓存读取。
- **TDD/提交**：每任务先写失败测试→实现→过→提交。

## 完成定义

- [ ] 全量 `pnpm test` 绿 + `pnpm build` 0 错。
- [ ] ModelPicker 对 managed 展开多模型、两行式、无搜索框、选中回传 alias、折叠态显示名。
- [ ] vision/上下文按所选 managed 模型解析；失效 alias 回退 models[0]；缓存未就绪回退 registry 单条。
- [ ] 6 语 `managed.models.consumption` 对齐 + parity 测试过。
- [ ] 走 PR（pie-ai-agent main 受 ruleset 保护：需 owner UI approve+merge；用 worktree + `gh auth switch --user WiseriaAI`）。
