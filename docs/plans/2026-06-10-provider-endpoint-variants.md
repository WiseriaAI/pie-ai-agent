# Provider Endpoint Variants（按量 / Plan API 切换）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 registry 声明 provider 的多端点变体（按量 / Plan），用户在 Settings 配置 instance 时用 segmented 控件切换；首批落地智谱 Coding Plan、Kimi Code、mimo 按量、StepFun Step Plan。

**Architecture:** `ProviderMeta.endpointVariants[]`（id/label/baseUrl + 可选 models/placeholder override）是唯一数据源；`StoredInstance.endpointVariant` 持久化用户选择（缺省 = 默认端点，零 migration）；`resolveModelConfig` 一处覆盖 baseUrl；`getModelMeta` 改 union 查找让 vision/maxOutputTokens 链路签名零改动；ModelPicker / `firstModelForProvider` 按 variant 过滤展示清单。

**Tech Stack:** React 19 + TS、vitest + happy-dom + @testing-library/react、IndexedDB（fake 由 `_resetForTests` 提供）。

**Spec:** `docs/specs/2026-06-10-provider-endpoint-variants.md`

**工作目录注意**：若在 worktree 中执行，所有命令必须先 `cd` 到 worktree 绝对路径（subagent cwd 不随 EnterWorktree 切换）。

---

## File Map

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/lib/model-router/providers/registry.ts` | Modify | EndpointVariant 类型 + 首批 variant 数据 + union 查找 + `resolveEndpointVariant` |
| `src/lib/model-router/index.ts` | Modify | barrel 再导出新类型/函数 |
| `src/lib/instances.ts` | Modify | endpointVariant 持久化 + baseUrl 覆盖 + firstModelForProvider |
| `src/sidepanel/components/ModelPicker.tsx` | Modify | variant-aware 模型清单（`modelsFor` 导出供测试） |
| `src/sidepanel/components/InstanceForm.tsx` | Modify | endpoint segmented 控件 + placeholder 跟随 + payload 透传 |
| `src/sidepanel/components/Settings.tsx` | Modify | create/edit/test 三处接通 variant |
| `src/sidepanel/components/InstancesList.tsx` | Modify | 行内 variant label 小标签 |
| `src/lib/i18n/dictionaries/en.ts` / `zh-CN.ts` | Modify | `instanceForm.endpoint` / `instanceForm.endpointDefault` |
| `manifest.json` | Modify | `api.kimi.com` / `api.xiaomimimo.com` host_permissions |
| `CLAUDE.md`（pie-ai-agent） | Modify | provider registry pattern 不变量补一句 |
| 测试 | Modify | `registry.test.ts` / `instances.test.ts` / `ModelPicker.test.tsx` / `InstanceForm.test.tsx` |

NewConfigWizard.tsx **零改动**（`handleSubmit` 原样透传 payload；InstanceForm 自带新字段）。

---

### Task 1: Registry — 类型、首批数据、union 查找

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts`
- Modify: `src/lib/model-router/index.ts:8-10`
- Test: `src/lib/model-router/providers/registry.test.ts`

- [ ] **Step 1: 写失败测试**

在 `registry.test.ts` 末尾追加：

```ts
describe("endpoint variants", () => {
  it("zhipu declares a coding-plan variant with the Coding Plan base URL", () => {
    const meta = getProviderMeta("zhipu")!;
    expect(meta.defaultEndpointLabel).toBe("Pay-as-you-go");
    const v = meta.endpointVariants?.find((x) => x.id === "coding-plan");
    expect(v?.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(v?.models).toBeUndefined(); // 按量清单是超集，不 override
  });

  it("moonshot and moonshot-cn share the kimi-code variant (api.kimi.com/coding, model pinned)", () => {
    for (const id of ["moonshot", "moonshot-cn"] as const) {
      const v = getProviderMeta(id)!.endpointVariants?.find((x) => x.id === "kimi-code");
      expect(v?.baseUrl).toBe("https://api.kimi.com/coding");
      expect(v?.models?.map((m) => m.id)).toEqual(["kimi-for-coding"]);
      expect(v?.placeholder).toBe("sk-kimi-...");
    }
  });

  it("mimo default stays the Token Plan endpoint; payg is the variant", () => {
    const meta = getProviderMeta("mimo")!;
    expect(meta.defaultBaseUrl).toBe("https://token-plan-cn.xiaomimimo.com");
    expect(meta.defaultEndpointLabel).toBe("Token Plan");
    expect(meta.placeholder).toBe("tp-...");
    const v = meta.endpointVariants?.find((x) => x.id === "payg");
    expect(v?.baseUrl).toBe("https://api.xiaomimimo.com");
    expect(v?.placeholder).toBe("sk-...");
    expect(v?.models).toBeUndefined();
  });

  it("stepfun step-plan variant: base WITHOUT /v1 (SDK appends /v1/messages), plan model pool", () => {
    const v = getProviderMeta("stepfun")!.endpointVariants?.find((x) => x.id === "step-plan");
    expect(v?.baseUrl).toBe("https://api.stepfun.com/step_plan");
    expect(v?.models?.map((m) => m.id)).toEqual([
      "step-3.7-flash", "step-3.5-flash-2603", "step-3.5-flash", "step-router-v1",
    ]);
  });

  it("getModelMeta unions variant models after the default list", () => {
    expect(getModelMeta("moonshot", "kimi-for-coding")?.maxContextTokens).toBe(256_000);
    expect(getModelMeta("moonshot", "kimi-k2.6")).toBeDefined(); // 默认清单仍命中
    expect(getModelMeta("stepfun", "step-router-v1")?.vision).toBe(false);
    // 默认清单优先：step-3.7-flash 在默认清单与 variant 清单都存在 → 返回默认条目
    expect(getModelMeta("stepfun", "step-3.7-flash")?.vision).toBe(true);
  });

  it("resolveEndpointVariant: hit / miss / undefined", () => {
    const meta = getProviderMeta("zhipu")!;
    expect(resolveEndpointVariant(meta, "coding-plan")?.id).toBe("coding-plan");
    expect(resolveEndpointVariant(meta, "no-such")).toBeUndefined();
    expect(resolveEndpointVariant(meta, undefined)).toBeUndefined();
    expect(resolveEndpointVariant(getProviderMeta("anthropic")!, "coding-plan")).toBeUndefined();
  });

  it("providers without variants are untouched", () => {
    for (const id of ["anthropic", "openai", "minimax", "deepseek", "gemini", "bailian", "openrouter"] as const) {
      expect(getProviderMeta(id)!.endpointVariants).toBeUndefined();
    }
  });
});
```

同时在文件顶部 import 行加入 `resolveEndpointVariant`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: FAIL（`resolveEndpointVariant` 不存在 / variant 字段 undefined）

- [ ] **Step 3: 实现 registry 改动**

`registry.ts` — 在 `ModelMeta` 之后、`ProviderMeta` 之前加类型；`ProviderMeta` 加两个字段：

```ts
export interface EndpointVariant {
  /** 稳定 id，持久化进 StoredInstance.endpointVariant。 */
  id: string;
  /** 切换控件文案（与 provider name 一样不做 i18n）。 */
  label: string;
  /** 替换 defaultBaseUrl 进 ModelConfig.baseUrl；anthropic-wire 家族的
   *  baseUrlSuffix hook 照常在 core 层拼接。 */
  baseUrl: string;
  /** 可选：整体替换该变体下的展示模型清单（如 Kimi Code 只认 kimi-for-coding）。
   *  缺省沿用 ProviderMeta.models。getModelMeta 做 union 查找，元数据链路不感知。 */
  models?: ModelMeta[];
  /** 可选：替换 API key 输入框 placeholder（Plan key 前缀不同时）。 */
  placeholder?: string;
}
```

`ProviderMeta` 内追加：

```ts
  /** 额外端点变体（按量/Plan 双计费等）。缺省 = 无变体，UI 不渲染切换。 */
  endpointVariants?: EndpointVariant[];
  /** 有 endpointVariants 时，默认端点在切换控件里的文案。 */
  defaultEndpointLabel?: string;
```

`MOONSHOT_MODELS` 旁加共享 variant 常量（两个 moonshot 条目 lockstep，同 `MOONSHOT_MODELS` 模式）：

```ts
// Kimi Code 订阅端点（api.kimi.com）。订阅 API 只接受统一 model id
// "kimi-for-coding"（官方要求请求体固定用它，不暴露真实模型名）。
// TODO(vision): 官方未明确 kimi-for-coding 是否收图片输入，fail-closed false，核实后更新。
const KIMI_CODE_VARIANT: EndpointVariant = {
  id: "kimi-code",
  label: "Kimi Code Plan",
  baseUrl: "https://api.kimi.com/coding",
  placeholder: "sk-kimi-...",
  models: [
    { id: "kimi-for-coding", vision: false, tools: true, maxContextTokens: 256_000 },
  ],
};
```

registry 条目改动（其余条目不动）：

zhipu 条目 `models: [...]` 之后追加：
```ts
    defaultEndpointLabel: "Pay-as-you-go",
    // Coding Plan 专属 OpenAI-compat 端点（FAQ：走通用端点不扣套餐额度）。
    // Plan 限 GLM-5.1/5-Turbo/4.7/4.5-Air，但按量清单是超集 → 不 override，
    // 选错模型由运行期报错自纠，免维护两份清单。
    endpointVariants: [
      { id: "coding-plan", label: "Coding Plan", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
    ],
```

mimo 条目：`placeholder: "API key"` 改为 `placeholder: "tp-..."`，并追加：
```ts
    // 注意：mimo 的 defaultBaseUrl 本就是 Token Plan（订阅）端点 —— 保持不动，
    // 存量 instance（tp- key）零破坏；按量（sk- key）才是 variant。
    defaultEndpointLabel: "Token Plan",
    endpointVariants: [
      { id: "payg", label: "Pay-as-you-go", baseUrl: "https://api.xiaomimimo.com", placeholder: "sk-..." },
    ],
```

moonshot 与 moonshot-cn 两个条目各追加：
```ts
    defaultEndpointLabel: "Pay-as-you-go",
    endpointVariants: [KIMI_CODE_VARIANT],
```

stepfun 条目追加：
```ts
    defaultEndpointLabel: "Pay-as-you-go",
    endpointVariants: [
      {
        id: "step-plan",
        label: "Step Plan",
        // Anthropic SDK 会自动在 base_url 后拼 /v1/messages，故 base 不带 /v1
        // （官方 Step Plan 文档明示；OpenAI SDK 才用 .../step_plan/v1）。
        baseUrl: "https://api.stepfun.com/step_plan",
        // Step Plan 限定池（¥49–699/月档位）。maxOutputTokens 官方未披露，
        // 留空退回 ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS（同默认清单的 TODO）。
        models: [
          { id: "step-3.7-flash", vision: true, tools: true, maxContextTokens: 256_000 },
          { id: "step-3.5-flash-2603", vision: false, tools: true, maxContextTokens: 256_000 },
          { id: "step-3.5-flash", vision: false, tools: true, maxContextTokens: 256_000 },
          { id: "step-router-v1", vision: false, tools: true, maxContextTokens: 256_000 },
        ],
      },
    ],
```

`getModelMeta`（registry.ts:246-248）改为 union 查找：

```ts
export function getModelMeta(provider: BuiltinProvider, modelId: string): ModelMeta | undefined {
  const meta = getProviderMeta(provider);
  if (!meta) return undefined;
  // 默认清单优先；未命中再扫各 variant 的 override 清单（union 查找）。
  // 这样 resolveModelMeta / resolveModelVision / resolveModelConfig 的
  // vision、maxOutputTokens 链路对 variant 模型零改动自动覆盖。
  const direct = meta.models.find((m) => m.id === modelId);
  if (direct) return direct;
  for (const v of meta.endpointVariants ?? []) {
    const hit = v.models?.find((m) => m.id === modelId);
    if (hit) return hit;
  }
  return undefined;
}
```

文件末尾加 helper：

```ts
/** instance 选中的 endpoint variant；id 悬空（registry 已删）或未选 → undefined（落回默认端点）。 */
export function resolveEndpointVariant(
  meta: Pick<ProviderMeta, "endpointVariants">,
  variantId: string | undefined,
): EndpointVariant | undefined {
  if (!variantId) return undefined;
  return meta.endpointVariants?.find((v) => v.id === variantId);
}
```

`src/lib/model-router/index.ts` barrel（现第 8-10 行）改为：

```ts
export { PROVIDER_REGISTRY, getProviderMeta, resolveProviderMeta, resolveModelMeta, resolveEndpointVariant } from "./providers/registry";
export type { ProviderMeta, ModelMeta, EndpointVariant } from "./providers/registry";
export { getModelMeta } from "./providers/registry";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: PASS（全文件，含既有用例——尤其 "every provider has a defaultBaseUrl..." 不受新字段影响）

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts src/lib/model-router/index.ts
git commit -m "feat(registry): endpoint variants (PAYG/Plan) + first-batch data + union model lookup"
```

---

### Task 2: instances — 持久化、baseUrl 覆盖、firstModelForProvider

**Files:**
- Modify: `src/lib/instances.ts`
- Test: `src/lib/instances.test.ts`

- [ ] **Step 1: 写失败测试**

`instances.test.ts` 末尾追加：

```ts
describe("endpoint variants", () => {
  it("endpointVariant round-trips through create/get and survives unrelated updates", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k", endpointVariant: "coding-plan" });
    expect((await getInstance(id))!.endpointVariant).toBe("coding-plan");
    await updateInstance(id, { nickname: "Z2" });
    expect((await getInstance(id))!.endpointVariant).toBe("coding-plan");
  });

  it("updateInstance: string sets, null clears back to default endpoint", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k" });
    await updateInstance(id, { endpointVariant: "coding-plan" });
    expect((await getInstance(id))!.endpointVariant).toBe("coding-plan");
    await updateInstance(id, { endpointVariant: null });
    expect((await getInstance(id))!.endpointVariant).toBeUndefined();
  });

  it("resolveModelConfig: no variant → defaultBaseUrl (legacy records unchanged)", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k" });
    const cfg = await resolveModelConfig(id, "glm-4.7");
    expect(cfg!.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
  });

  it("resolveModelConfig: variant overrides baseUrl", async () => {
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "kimi-code" });
    const cfg = await resolveModelConfig(id, "kimi-for-coding");
    expect(cfg!.baseUrl).toBe("https://api.kimi.com/coding");
    // union 查找把 variant 模型的 meta 也接通（vision fail-closed false）
    expect(cfg!.vision).toBe(false);
  });

  it("resolveModelConfig: dangling variant id falls back to defaultBaseUrl", async () => {
    const id = await createInstance({ provider: "zhipu", nickname: "Z", apiKey: "k", endpointVariant: "removed-variant" });
    const cfg = await resolveModelConfig(id, "glm-4.7");
    expect(cfg!.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
  });

  it("firstModelForProvider prefers the variant pool over the registry list", async () => {
    const id = await createInstance({ provider: "moonshot", nickname: "K", apiKey: "k", endpointVariant: "kimi-code" });
    expect(await firstModelForProvider("moonshot", id)).toBe("kimi-for-coding");
    // 无 variant 的 instance 仍取 registry[0]
    const id2 = await createInstance({ provider: "moonshot", nickname: "K2", apiKey: "k" });
    expect(await firstModelForProvider("moonshot", id2)).toBe("kimi-k2.6");
    // customModels 仍最优先
    const id3 = await createInstance({ provider: "moonshot", nickname: "K3", apiKey: "k", endpointVariant: "kimi-code", customModels: ["my-model"] });
    expect(await firstModelForProvider("moonshot", id3)).toBe("my-model");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/instances.test.ts`
Expected: FAIL（createInstance 不收 endpointVariant；resolveModelConfig 返回 defaultBaseUrl）

- [ ] **Step 3: 实现 instances.ts 改动**

import 行（第 2 行）追加 `resolveEndpointVariant`：

```ts
import { resolveProviderMeta, getProviderMeta, resolveModelVision, resolveModelMeta, resolveEndpointVariant } from "@/lib/model-router/providers/registry";
```

`StoredInstance`（instances.ts:9-19）追加字段：

```ts
  /** EndpointVariant.id（见 registry.endpointVariants）。缺省 = 默认端点。 */
  endpointVariant?: string;
```

`createInstance` input 类型追加 `endpointVariant?: string;`，`stored` 对象构造（instances.ts:48-55）追加一行：

```ts
    ...(input.endpointVariant && { endpointVariant: input.endpointVariant }),
```

`updateInstance` patch 类型（instances.ts:194-201）追加 `endpointVariant: string | null;`，RMW 逻辑追加：

```ts
  if (patch.endpointVariant !== undefined) {
    // null = 显式清除（切回默认端点）；string = 设置。沿用可选字段不留空值的存储习惯。
    if (patch.endpointVariant === null) delete next.endpointVariant;
    else next.endpointVariant = patch.endpointVariant;
  }
```

`resolveModelConfig`（instances.ts:136-169）：在 `const meta = ...; if (!meta) return null;` 之后加一行，并改 baseUrl：

```ts
  const variant = resolveEndpointVariant(meta, inst.endpointVariant);
```
```ts
    baseUrl: variant?.baseUrl ?? meta.defaultBaseUrl,
```

`firstModelForProvider`（instances.ts:174-182）：在 customModels 分支之后、registry 分支之前插入 variant 分支（注释同步更新优先级描述）：

```ts
export async function firstModelForProvider(provider: ProviderRef, instanceId?: string): Promise<string | null> {
  const inst = instanceId
    ? await getInstance(instanceId)
    : (await listInstances()).find((i) => i.provider === provider);
  if (inst?.customModels && inst.customModels.length > 0) return inst.customModels[0]!;
  const meta = getProviderMeta(provider as BuiltinProvider);
  // variant 带 models override → 该 instance 的默认模型来自 variant 池
  const variant = meta ? resolveEndpointVariant(meta, inst?.endpointVariant) : undefined;
  if (variant?.models && variant.models.length > 0) return variant.models[0]!.id;
  if (meta && meta.models.length > 0) return meta.models[0]!.id;
  return inst?.fetchedModels?.[0]?.id ?? null;
}
```

（`DecryptedInstance` 是 `Omit<StoredInstance, "encryptedKey">`，自动带上新字段，无需改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/instances.test.ts`
Expected: PASS（含既有全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(instances): persist endpointVariant; variant-aware baseUrl + first-model resolution"
```

---

### Task 3: ModelPicker — variant-aware 模型清单

**Files:**
- Modify: `src/sidepanel/components/ModelPicker.tsx:39-53`
- Test: `src/sidepanel/components/ModelPicker.test.tsx`

- [ ] **Step 1: 写失败测试**

`ModelPicker.test.tsx` 追加（`modelsFor` 改为具名导出后直接做纯函数测试，不走 DOM；`makeInst` 若文件内已有等价 helper 则复用）：

```ts
import { modelsFor } from "./ModelPicker";
import type { DecryptedInstance } from "@/lib/instances";

function inst(over: Partial<DecryptedInstance>): DecryptedInstance {
  return { id: "i1", provider: "moonshot", nickname: "K", apiKey: "k", createdAt: 0, ...over };
}

describe("modelsFor with endpoint variants", () => {
  it("variant with models replaces the registry list (custom pool still appended)", () => {
    const rows = modelsFor(inst({ endpointVariant: "kimi-code", customModels: ["my-model"] }));
    expect(rows.map((r) => r.id)).toEqual(["kimi-for-coding", "my-model"]);
  });

  it("variant without models keeps the default list (zhipu coding-plan)", () => {
    const rows = modelsFor(inst({ provider: "zhipu", endpointVariant: "coding-plan" }));
    expect(rows.map((r) => r.id)).toContain("glm-5.1");
  });

  it("no variant → unchanged registry list", () => {
    const rows = modelsFor(inst({}));
    expect(rows[0]!.id).toBe("kimi-k2.6");
  });

  it("dangling variant id falls back to the default list", () => {
    const rows = modelsFor(inst({ endpointVariant: "gone" }));
    expect(rows[0]!.id).toBe("kimi-k2.6");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ModelPicker.test.tsx`
Expected: FAIL（`modelsFor` 未导出 / variant 不生效）

- [ ] **Step 3: 实现**

`ModelPicker.tsx`：import 行（第 5 行）追加 `resolveEndpointVariant`；`modelsFor`（第 39-53 行）改为具名导出 + variant 逻辑：

```ts
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
```

```ts
/** Build the dedup'd model list for an instance: registry → fetched → custom.
 *  带 models override 的 endpoint variant 整体替换 registry 段（fetched 仅
 *  openrouter 使用、与 variant 不相交，但同样跳过以保持「替换」语义）。
 *  Exported for unit tests. */
export function modelsFor(inst: DecryptedInstance): ModelRow[] {
  const isCustom = inst.provider.startsWith(CUSTOM_PREFIX);
  const meta = isCustom ? undefined : getProviderMeta(inst.provider as BuiltinProvider);
  const variant = meta ? resolveEndpointVariant(meta, inst.endpointVariant) : undefined;
  const registry = variant?.models ?? meta?.models ?? [];
  const fetched = variant?.models ? [] : ((inst.fetchedModels ?? []) as ModelMeta[]);
  const custom = inst.customModels ?? [];
  const rows: ModelRow[] = [
    ...registry.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...fetched.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...custom.map((id) => ({ id, isCustom: true })),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ModelPicker.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ModelPicker.tsx src/sidepanel/components/ModelPicker.test.tsx
git commit -m "feat(model-picker): variant-aware model list"
```

---

### Task 4: InstanceForm — endpoint segmented 控件

**Files:**
- Modify: `src/sidepanel/components/InstanceForm.tsx`
- Modify: `src/lib/i18n/dictionaries/en.ts:234-250` / `src/lib/i18n/dictionaries/zh-CN.ts:235-251`
- Test: `src/sidepanel/components/InstanceForm.test.tsx`

- [ ] **Step 1: 写失败测试**

`InstanceForm.test.tsx` 追加（render 方式沿用文件内既有用例的 props 写法；`onSave`/`onTest` 用 `vi.fn()`）：

```tsx
describe("endpoint variant switch", () => {
  const noop = () => {};
  const base = {
    mode: "create" as const,
    initialNickname: "n",
    onTest: noop,
  };

  it("renders the segmented switch only for providers with variants", () => {
    const { rerender } = render(<InstanceForm {...base} provider="zhipu" onSave={noop} />);
    expect(screen.getByRole("button", { name: "Pay-as-you-go" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Coding Plan" })).toBeInTheDocument();
    rerender(<InstanceForm {...base} provider="anthropic" onSave={noop} />);
    expect(screen.queryByRole("button", { name: "Pay-as-you-go" })).toBeNull();
  });

  it("selecting a variant flows into the onSave payload; default = undefined", () => {
    const onSave = vi.fn();
    render(<InstanceForm {...base} provider="zhipu" onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("api key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Coding Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0].endpointVariant).toBe("coding-plan");
    // 切回默认 → undefined
    fireEvent.click(screen.getByRole("button", { name: "Pay-as-you-go" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[1]![0].endpointVariant).toBeUndefined();
  });

  it("edit mode pre-selects initialEndpointVariant", () => {
    const onSave = vi.fn();
    render(
      <InstanceForm {...base} mode="edit" provider="zhipu" existingApiKey="sk-x"
        initialEndpointVariant="coding-plan" onSave={onSave} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0].endpointVariant).toBe("coding-plan");
  });

  it("variant placeholder overrides the provider placeholder (mimo payg)", () => {
    render(<InstanceForm {...base} provider="mimo" onSave={noop} />);
    expect(screen.getByLabelText("api key")).toHaveAttribute("placeholder", "tp-...");
    fireEvent.click(screen.getByRole("button", { name: "Pay-as-you-go" }));
    expect(screen.getByLabelText("api key")).toHaveAttribute("placeholder", "sk-...");
  });
});
```

注意：测试环境 locale 为 en（既有用例同假设），"Save" / "api key" 文案以 `en.ts` 词条为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx`
Expected: FAIL（控件不存在）

- [ ] **Step 3: 实现**

i18n 两本词典的 `instanceForm` 块各加两条（en / zh-CN）：

```ts
    endpoint: "ENDPOINT",          // zh-CN: "端点"
    endpointDefault: "Default",    // zh-CN: "默认"
```

`InstanceForm.tsx`：

1. `InstanceFormPayload` 改为：

```ts
export interface InstanceFormPayload {
  nickname: string;
  apiKey: string;
  customModels: string[];
  /** EndpointVariant.id；undefined = 默认端点。 */
  endpointVariant?: string;
}
```

2. Props 追加 `initialEndpointVariant?: string;`（放在 `initialCustomModels` 旁）。

3. 组件内（`const [replacing, ...]` 之前）加状态与派生值：

```ts
  const [endpointVariant, setEndpointVariant] = useState<string | undefined>(props.initialEndpointVariant);
  const variants = meta?.endpointVariants ?? [];
  const selectedVariant = variants.find((v) => v.id === endpointVariant);
```

4. `payload` 构造改为：

```ts
  const payload: InstanceFormPayload = { nickname, apiKey, customModels, endpointVariant };
```

5. provider Field 之后、API key Field 之前插入 segmented 控件（样式仿 Settings.tsx 的 `SegmentedTabs`；`hideProviderField` 不影响本控件——wizard 里也要显示）：

```tsx
      {variants.length > 0 && (
        <Field label={t("instanceForm.endpoint")} hint={selectedVariant?.baseUrl ?? meta?.defaultBaseUrl}>
          <div className="flex w-full overflow-hidden rounded-[10px] border border-line">
            {[{ id: undefined as string | undefined, label: meta?.defaultEndpointLabel ?? t("instanceForm.endpointDefault") },
              ...variants.map((v) => ({ id: v.id as string | undefined, label: v.label }))].map((opt, i) => {
              const active = endpointVariant === opt.id;
              return (
                <button
                  key={opt.id ?? "_default"}
                  type="button"
                  onClick={() => setEndpointVariant(opt.id)}
                  className={`flex-1 py-2 text-[12px] ${i > 0 ? "border-l border-line" : ""} ${
                    active ? "bg-field font-medium text-fg-1" : "bg-transparent text-fg-2 hover:text-fg-1"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </Field>
      )}
```

6. API key input 的 placeholder（第 155 行）改为：

```tsx
                placeholder={selectedVariant?.placeholder ?? meta?.placeholder ?? ""}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/InstanceForm.test.tsx`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstanceForm.test.tsx src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "feat(instance-form): endpoint variant segmented switch + placeholder follow"
```

---

### Task 5: Settings / InstancesList 接线

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx:82-130, 185-196`
- Modify: `src/sidepanel/components/InstancesList.tsx`

- [ ] **Step 1: Settings.tsx 三处改动**

(a) `handleSaveEdit`（第 82-92 行）——payload 没带 variant 时显式清除（用户切回默认端点）：

```ts
  async function handleSaveEdit(id: string, payload: InstanceFormPayload) {
    const patch: { nickname: string; apiKey?: string; endpointVariant: string | null } = {
      nickname: payload.nickname,
      // undefined = 用户选了默认端点 → null 显式清除存储字段
      endpointVariant: payload.endpointVariant ?? null,
    };
    // Only re-encrypt the key if the user actually typed a new one.
    // An empty apiKey means "keep existing" — do NOT pass it to updateInstance.
    if (payload.apiKey.trim().length > 0) patch.apiKey = payload.apiKey;
    await updateInstance(id, patch);
    setExpandedId(null); // collapse after save
    await reload();
  }
```

（`handleCreate` 无需改：`createInstance({ provider, ...payload })` 的展开已携带 `endpointVariant`，Task 2 的 input 类型已收。）

(b) `handleTest`（第 101-130 行）——连接测试跟随表单当前选择的端点与模型池。import 行（第 20 行）追加 `resolveEndpointVariant`：

```ts
import { getProviderMeta, resolveProviderMeta, resolveEndpointVariant } from "@/lib/model-router/providers/registry";
```

`handleTest` 内 `const model = ...` 与 `cfg` 改为：

```ts
    // 端点与模型池跟随表单里未保存的 variant 选择（而非存量 instance 字段）
    const variant = resolveEndpointVariant(meta, payload.endpointVariant);
    const model = variant?.models?.[0]?.id
      ?? (await firstModelForProvider(provider, id ?? undefined))
      ?? "";
    const cfg = {
      provider,
      model,
      // If apiKey is empty (edit mode, user didn't retype), fall back to instance's stored key
      apiKey: payload.apiKey.trim() || (() => {
        if (!id) return payload.apiKey;
        const inst = instances.find((i) => i.id === id);
        return inst?.apiKey ?? payload.apiKey;
      })(),
      baseUrl: variant?.baseUrl ?? meta.defaultBaseUrl,
      maxTokens: 1,
    };
```

(c) 编辑表单回填（第 185-196 行 InstanceForm props）追加：

```tsx
                        initialEndpointVariant={inst.endpointVariant}
```

- [ ] **Step 2: InstancesList 行内 variant 标签**

`InstancesList.tsx` 顶部追加 import：

```ts
import type { BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
```

map 回调内（`const isOpen = ...` 之后）求 label：

```ts
        const variantLabel = (() => {
          if (!inst.endpointVariant || inst.provider.startsWith("custom:")) return null;
          const meta = getProviderMeta(inst.provider as BuiltinProvider);
          return meta ? resolveEndpointVariant(meta, inst.endpointVariant)?.label ?? null : null;
        })();
```

nickname 行（第 32-35 行）的 provider span 之后追加：

```tsx
                  {variantLabel && (
                    <span className="ml-1.5 rounded bg-line px-1 py-px text-[9px] font-normal text-fg-2">{variantLabel}</span>
                  )}
```

- [ ] **Step 3: 全量测试 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿、0 错（Settings/InstancesList 无独立测试文件，靠 InstanceForm/instances 层用例 + typecheck 把关）

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/components/Settings.tsx src/sidepanel/components/InstancesList.tsx
git commit -m "feat(settings): wire endpoint variant through create/edit/test + list badge"
```

---

### Task 6: Manifest、文档、全量验证

**Files:**
- Modify: `manifest.json:8-23`（host_permissions）
- Modify: `CLAUDE.md`（pie-ai-agent 仓库根，Architecture Invariants 的 provider registry pattern 条目）

- [ ] **Step 1: manifest host_permissions 追加两条**

在 `"https://api.stepfun.com/*",` 之后插入（`<all_urls>` 本就兜底，显式列出是 builtin 域名既有约定）：

```json
    "https://api.kimi.com/*",
    "https://api.xiaomimimo.com/*",
```

- [ ] **Step 2: CLAUDE.md provider registry pattern 不变量补一句**

在 "Provider registry pattern" 条目（"加 provider = registry entry + 模块文件 + manifest host_permission"句子之后）追加：

```
同一 provider 的按量/Plan 双端点走 `ProviderMeta.endpointVariants`（id/label/baseUrl + 可选 models/placeholder override），instance 存 `endpointVariant`，`resolveModelConfig` 单点覆盖 baseUrl；加新 Plan 端点 = registry 加一条 variant 数据（+新域名时补 manifest），不动机制代码。
```

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 测试全绿；typecheck 0 错；build 成功（`tool-names.ts`/`tools.ts` 构建期 invariant 不受影响）

- [ ] **Step 4: Commit**

```bash
git add manifest.json CLAUDE.md docs/specs/2026-06-10-provider-endpoint-variants.md docs/plans/2026-06-10-provider-endpoint-variants.md
git commit -m "feat(manifest): kimi.com + xiaomimimo.com host permissions; docs for endpoint variants"
```

---

## 合并前真机回归清单（人工）

1. 存量 instance（无 endpointVariant）升级后行为不变，编辑表单 segmented 显示在默认档。
2. 智谱 Coding Plan key：新建 instance 选「Coding Plan」→ glm-4.7 跑任务，确认计费走套餐。
3. Kimi Code key（`sk-kimi-`）：moonshot instance 选「Kimi Code Plan」→ picker 只出 `kimi-for-coding`，任务可跑。
4. StepFun Step Plan key：选「Step Plan」→ `step-3.5-flash` 跑任务（验证 `/step_plan` + SDK 自动拼 `/v1/messages` 不 404）。
5. mimo：持 `sk-` key 切「Pay-as-you-go」可跑；持 `tp-` key 默认档可跑。
6. 「测试」按钮在选中 variant 时按 variant 端点/模型测试（编辑态未保存的切换也生效）。
7. InstancesList 行内显示 variant 小标签；ModelPicker 行为正常。
8. TODO 核实：`kimi-for-coding` 是否支持图片输入（当前 fail-closed `vision:false`）。
