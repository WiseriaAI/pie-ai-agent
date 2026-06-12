# Managed Provider 客户端接入设计

**日期**：2026-06-12
**状态**：已批准（待写 plan）
**取代**：`docs/specs/2026-05-30-managed-service-tier.md`（已作废，旧 Supabase+JWT+402 方案）

## 目标

让 Pie 扩展用户**无需自带 API key**：在配置表单里切到「官方订阅」，用 Google 一键登录 → 订阅 → 自动得到一个可用的 provider 配置，聊天直连官方网关。BYOK 模式完全不受影响，二者并存。

## 背景与权威契约

后端已实现并联调（LiteLLM 网关 + `account` 胶水服务）。客户端只依赖一份 HTTP 契约，**不知道真实模型名、上游 key、定价**。

- 后端契约：`pie-managed-backend/docs/contract.md`
- 工作区设计 spec：`docs/brainstorming/2026-06-11-managed-provider-litellm-design.md`（工作区根）
- 跨项目契约摘要：工作区根 `CLAUDE.md`

两个基址（已在 Railway 绑定自定义域名）：

| 常量 | 值 | 宿主 |
|---|---|---|
| `ACCOUNT_BASE` | `https://account.pie.chat` | account 胶水服务（账号/订阅） |
| `GATEWAY_BASE` | `https://api.pie.chat` | LiteLLM 网关（聊天，OpenAI 兼容） |

用到的端点（详见 contract.md）：

| 端点 | 宿主 | 方法 | 请求 | 响应 |
|---|---|---|---|---|
| `/auth/start` | account | GET | `?redirect_uri=` | 302 → Google OAuth |
| `/auth/exchange` | account | POST | `{code, redirectUri}` | `{apiKey, entitlement}` |
| `/me/entitlement` | account | GET | Bearer apiKey | `{plan, email, budgetRemainingUsd}` |
| `/billing/checkout` | account | POST | Bearer apiKey | `{url}` |
| `/billing/portal` | account | POST | Bearer apiKey | `{url}` |
| `/v1/chat/completions` | gateway | POST | `{model:"default", ...}` + Bearer apiKey | OpenAI 兼容 SSE |

错误语义（已对 LiteLLM v1.88.1 实测）：
- `401` + `error.type:"auth_error"` = key 失效或被 block。
- `429` + `error.type:"budget_exceeded"` = 额度耗尽（**不是限流，没有 402**）。
- `429` 其它 = 真限流。
- `entitlement.plan`：`none`（未订阅）/ `active` / `blocked`（欠费）。

## 总体策略：复用 BYOK instance 框架

managed 在**底层**就是一个普通 builtin provider（`provider:"managed"`），virtual key 存进现有加密的 `StoredInstance`，聊天复用现成的 OpenAI-compat 管线。**不新建独立子系统。**

在 **UI 层**，managed 不出现在 ProviderDropdown 里，而是由配置表单顶部的【BYOK ↔ 官方订阅】切换驱动；选「官方订阅」时走登录+订阅流程，成功后落一个 `provider:"managed"` 的 instance。

## 详细设计

### 1. Provider 层（改动最小）

- `src/lib/model-router/index.ts`：`BuiltinProvider` union 增加成员 `"managed"`。
- `src/lib/model-router/providers/registry.ts`：新增一条 `ProviderMeta`：
  - `id: "managed"`，`name: "Pie 官方订阅"`（或类似）
  - `defaultBaseUrl: "https://api.pie.chat"`
  - `models`: 仅一档 `{ id: "default", ... }`（tier 别名；真实模型由后端 config.yaml 决定，客户端无感）
  - 不暴露 endpointVariants（单一形态）
- `src/lib/model-router/providers/managed.ts`（新）：薄 wrapper，复用 `streamChatOpenAICompat`，`Authorization: Bearer <virtual key>`，请求体 `model: "default"`。无特殊 header hook。
- `src/lib/model-router/providers/index.ts`：`streamChatByProvider` / `dispatchStreamChat` 增加 `managed` 分支。

### 2. 配置表单：BYOK ↔ 官方订阅 切换

在新增配置入口（`NewConfigWizard`，配合 `Settings.tsx` 的 configs tab）顶部加一个二选一切换组件：

- **BYOK 档**（默认）：完全保持现状 —— provider 下拉 → 填 apiKey → 选 model → test → 保存。**ProviderDropdown 必须过滤掉 `managed`**（managed 虽在 `PROVIDER_REGISTRY` 里供底层 dispatch/instance 复用，但只通过本切换的「官方订阅」档进入，绝不出现在 BYOK 下拉中）。
- **官方订阅 档**：表单主体替换为「官方订阅流程」（见 §3、§4），不显示 provider 下拉、不显示 apiKey 输入框、不显示 model 选择器（单一 tier）。

切换组件本身是纯客户端状态，不持久化。

### 3. 登录流程（新模块 `src/lib/managed-auth.ts`）

`manifest.json` 的 `permissions` 增加 `"identity"`。

```
startManagedLogin():
  redirectUri = chrome.identity.getRedirectURL()        // https://<EXTENSION_ID>.chromiumapp.org/
  authUrl    = `${ACCOUNT_BASE}/auth/start?redirect_uri=${encodeURIComponent(redirectUri)}`
  resultUrl  = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true })
  // resultUrl 形如 https://<id>.chromiumapp.org/?code=...  或  ?error=access_denied
  code = new URL(resultUrl).searchParams.get("code")      // 无 code → 抛"登录已取消/失败"
  resp = await fetch(`${ACCOUNT_BASE}/auth/exchange`, {
           method: "POST",
           headers: { "content-type": "application/json" },
           body: JSON.stringify({ code, redirectUri }),
         })
  // 200 → { apiKey, entitlement }
  return { apiKey, entitlement }
```

要点：
- `redirectUri` 在 start 与 exchange 两处必须**完全一致**（含尾斜杠）；`getRedirectURL()` 保证一致。
- extension ID 已通过 manifest `key` 固定 → redirect 域稳定 → Google Console 的 Authorized redirect URI 只需登记一次。
- virtual key **长期有效，无 JWT/refresh**。
- **幂等**：同一 Google 账号重复登录，后端返回**同一把 key**；故客户端中途放弃、重登都安全，不会产生孤儿配置。

### 4. 账号 / 订阅（新模块 `src/lib/managed-account.ts` + UI）

封装三个账号调用：

```
getEntitlement(apiKey)  -> GET  ${ACCOUNT_BASE}/me/entitlement   (Bearer)  -> {plan,email,budgetRemainingUsd}
openCheckout(apiKey)    -> POST ${ACCOUNT_BASE}/billing/checkout (Bearer)  -> {url}  -> chrome.tabs.create({url})
openPortal(apiKey)      -> POST ${ACCOUNT_BASE}/billing/portal   (Bearer)  -> {url}  -> chrome.tabs.create({url})
```

**官方订阅档的创建流程（§2 选中后）：**

1. 显示「用 Google 登录」按钮 → 调 `startManagedLogin()`。
2. 登录成功，内存持有 `apiKey` + `entitlement`：
   - `plan === "active"`（老用户已订阅）→ 直接 `createInstance({provider:"managed", encryptedKey: apiKey, nickname: email})` 并设 active，完成。
   - `plan !== "active"`（首订或欠费）→ 显示订阅卡片：`email` + 「订阅」按钮 → `openCheckout(apiKey)` 开新标签付款。
3. 付款在新标签完成后，后端 webhook 异步激活。表单提供「我已完成支付，刷新状态」按钮（并在 window focus 时自动重拉）→ `getEntitlement(apiKey)`；一旦 `plan === "active"` → 创建 instance、设 active、完成。
4. **instance 在订阅 active 后才落库**（符合「订阅后加上 provider config」）。中途退出靠 §3 的幂等重登恢复。

**已有 managed instance 的编辑/详情视图**（`InstanceForm` 中 `provider === "managed"` 分支）：进入时 `getEntitlement` 展示 `plan` / `budgetRemainingUsd` / `email`；`active` 显示「管理订阅」→ `openPortal`，`blocked`/`none` 显示「续订/订阅」→ `openCheckout`。不显示 apiKey 输入框与 model 选择器。

### 5. 错误语义升级（关键改动，对所有 provider 无害）

现状：`src/lib/model-router/providers/_shared/openai-compat-core.ts:159-170` 把非 200 一律转成文案字符串，429 统一当"限流"。

改动：
- 解析错误响应体 JSON 的 `error.type`，据此打标。
- `src/lib/model-router/types.ts` 的 error 事件增加可选机读字段：
  ```ts
  | { type: "error"; error: string; kind?: "auth" | "budget" | "ratelimit" | "http" | "network" }
  ```
- 映射规则：
  - `401` → `kind:"auth"`（文案保持现状；BYOK=key 错，managed=失效/被封）
  - `429` 且 body `error.type === "budget_exceeded"` → `kind:"budget"`
  - `429` 其它 → `kind:"ratelimit"`
  - 其它非 200 → `kind:"http"`；fetch 失败 → `kind:"network"`
- 冒泡链路不变（`loop.ts` → port `chat-error` → `sidepanel/hooks/useSession/port-handlers.ts` → slot.error）。`kind` 一并透传到 slot。
- UI 据 `kind` 分流（仅 managed instance 时启用 CTA）：
  - `auth`：清除该 managed instance + 引导重新登录。
  - `budget`：提示「额度已用尽」+「管理订阅」CTA（`openPortal`/`openCheckout`）。**不是限流。**
  - `ratelimit`：提示稍后重试。
- BYOK 行为不变：无 `error.type` 时 `kind` 为 `ratelimit`/`http`，沿用原文案，不弹订阅 CTA。

### 6. Manifest

- `permissions` 增加 `"identity"`。
- `host_permissions` 增加 `"https://account.pie.chat/*"` 与 `"https://api.pie.chat/*"`（MV3 精确匹配；虽有 `<all_urls>` 兜底，显式声明更稳、利于审核可读性）。
- `key` 字段已 pin（commit `cb4f0cec`），extension ID 稳定。

### 7. 配置常量（`src/lib/managed-config.ts` 或并入现有 config）

```ts
export const ACCOUNT_BASE = "https://account.pie.chat";
export const GATEWAY_BASE = "https://api.pie.chat";
```

`registry.ts` 的 managed `defaultBaseUrl` 引用 `GATEWAY_BASE`，auth/account 模块引用 `ACCOUNT_BASE`。集中一处便于切换 staging/prod。

## 数据模型

完全复用 `src/lib/instances.ts` 的 `StoredInstance`：

- `provider: "managed"`
- `encryptedKey`: 加密后的 virtual key（与 BYOK key 同等加密）
- `nickname`: 登录返回的 `email`
- `endpointVariant`: 不用
- 不新增字段。`entitlement`（plan/budget/email）是**易变展示态**，每次按需 `getEntitlement` 实时拉取，不持久化（避免显示陈旧的订阅状态）。

## 刻意不做（YAGNI）

- **不做 tier 选择器**：当前只有 `default` 一档，managed instance 固定用它；将来多档再加。
- **不做 JWT / refresh / 402**：旧方案全弃。
- **不缓存 entitlement**：实时拉，避免陈旧。
- **未订阅不硬墙**：登录后即便 none 也不阻断 App；真正的拦截发生在聊天触发 `budget_exceeded` 时弹订阅 CTA（§5）。

## 测试策略

**单元测试（vitest）：**
- `managed-auth`：mock `chrome.identity.launchWebAuthFlow` 与 `fetch`；覆盖 成功 / 用户取消（无 code）/ exchange 非 200。
- `managed-account`：mock `fetch`；覆盖三端点的请求形状与返回解析。
- 错误解析：构造 401/429(budget)/429(ratelimit)/500/网络失败 响应，断言 `openai-compat-core` 产出的 `kind`。
- registry / dispatch：断言 `managed` 走 `streamChatOpenAICompat`，model 送 `"default"`。

**真机联调（依赖下方后端补步完成后）：**
pin key 已固定 ID → 加载 unpacked → 配置表单切「官方订阅」→ 真 Google 登录 → entitlement=none → 订阅（Stripe 测试卡 `4242...`）→ webhook 激活 → 刷新转 active → 落 managed instance → 聊天直连 `api.pie.chat` 正常返回 → （可选）耗额度验 `budget_exceeded` → 订阅 CTA。

## 配套后端补步（联调前必须）

> 这些在 `pie-managed-backend/docs/deploy.md` 已覆盖大部分；此处汇总客户端联调的前置依赖。

1. **Railway 自定义域名**：`account.pie.chat` → account 服务、`api.pie.chat` → litellm 服务（**litellm 这次开公网入口**，管理端靠 master key 保护；后续可前置 Cloudflare 只放行 `/v1/*` 加固）。— 用户已配域名。
2. litellm 服务确认 `DEEPSEEK_API_KEY` 已配。
3. account 填**真** `GOOGLE_CLIENT_ID/SECRET`；Google Console 把 `https://<EXTENSION_ID>.chromiumapp.org/` 加进 Authorized redirect URIs。（当前 `/auth/start` 跳转里的 client_id 仍是占位值，必须替换。）
4. Stripe 建 webhook `https://account.pie.chat/stripe/webhook` → 真 `STRIPE_WEBHOOK_SECRET`。
5. `CHECKOUT_SUCCESS_URL`/`CANCEL`/`PORTAL_RETURN` 换成 pie.chat 正式落地页（「订阅成功，可关闭返回 Pie」）。
6. 把 `contract.md` 与工作区根 `CLAUDE.md` 里的 `ACCOUNT_BASE`/`GATEWAY_BASE` 具化为这两个域名。

## 文件改动清单

**新增：**
- `src/lib/model-router/providers/managed.ts`
- `src/lib/managed-auth.ts`
- `src/lib/managed-account.ts`
- `src/lib/managed-config.ts`
- 对应 `*.test.ts`

**修改：**
- `src/lib/model-router/index.ts`（`BuiltinProvider` 加 `"managed"`）
- `src/lib/model-router/providers/registry.ts`（managed 条目）
- `src/lib/model-router/providers/index.ts`（dispatch）
- `src/lib/model-router/types.ts`（error 事件加 `kind`）
- `src/lib/model-router/providers/_shared/openai-compat-core.ts`（解析 `error.type` → `kind`）
- `src/sidepanel/hooks/useSession/port-handlers.ts`（透传 `kind` 到 slot）
- `src/sidepanel/components/NewConfigWizard.tsx`（顶部 BYOK/官方订阅 切换 + 官方订阅流程）
- `src/sidepanel/components/InstanceForm.tsx`（managed 分支：订阅状态 + checkout/portal）
- 聊天错误展示组件（按 `kind` 渲染 CTA；具体组件在 plan 阶段定位）
- `manifest.json`（`identity` 权限 + 两个 host_permission）

## 风险 / 开放问题

- **订阅激活的时延**：Stripe webhook 异步，付款后到 `active` 有秒级延迟。靠「刷新状态」按钮 + focus 自动重拉兜住；若长期不 active，提示用户稍候或检查支付。
- **litellm 公网暴露面**：管理端点（`/key/*` 等）靠 master key 保护即可，但上线后应尽快前置网关只放行 `/v1/*`（deploy.md 已记）。
- **`error.type` 解析对流式响应**：budget/auth 错误在 LiteLLM 是 HTTP 状态码 + JSON body（非 SSE 帧内），openai-compat-core 的非 200 分支即可拿到 body，无需改 SSE 解析。plan 阶段需确认 v1.88.1 错误体结构（contract.md 已有样例）。
