# 官方托管服务档（Managed Service Tier）—— 设计文档

- 日期：2026-05-30
- 状态：Design（待 plan）
- 关联：BYOK 之外的第二个接入入口；目标是压低非技术用户的接入摩擦

## 1. 背景与目标

Pie 目前是纯 BYOK：用户必须自带上游 API key。BYOK 的转化漏斗杀手不是价格，而是 setup 流程（注册上游 → 绑卡 → 生成 key → 理解"什么是 API key"），会挡掉绝大多数非技术用户。

本设计在 BYOK 之外新增一个**官方托管 provider**：用户用邮箱 / Google 登录即获得免费额度，**零 API key** 即可体验 agent；额度耗尽后二选一——转 BYOK（技术用户，对我们零成本）或买 credit 包（懒人，Phase 2）。

托管不取代 BYOK，二者并存：BYOK 仍是端到端直连、隐私最优；托管是低摩擦入口。

## 2. 分期

| 阶段 | 内容 | KPI | 收钱 |
|---|---|---|---|
| **Phase 1 — 漏斗冷启动** | 邮箱轻账号 + 一次性免费额度池 + 单一便宜模型 + 硬限流 | 激活率 / 留存 | 否 |
| **Phase 2 — 营收线** | 同账号叠 Stripe credit 包（一次性）+ $1 引流试用包 + 高级思考强度档解锁 | 付费转化 / 单用户毛利 | 是 |

定位（对应 brainstorm 的"C：分阶段"）：先用免费池验证激活率，再叠付费转成营收线，两期共用同一套账号底座。

## 3. 成本模型

基准模型：Gemini 2.0 Flash（带 tool use，白送 vision；具体型号服务端可热切换，见 §7）。

- 单价 ≈ $0.10 / M 输入、$0.40 / M 输出。
- 典型 agent 任务累计 ≈ 200K 输入 + 10K 输出 ≈ **$0.025 / 任务**。
- **计量单位 = token（成本真相来自上游 usage 字段）**；对用户呈现为 **credits**，1 credit ≈ 固定 token 桶（如 10K token）。重度任务自然多扣 credit，根治"一个重度用户吃掉六个轻度用户"。
- **Phase 1 免费池**：注册一次性发 ≈ 20 个典型任务的 credits（最坏成本 ≈ $0.50 / 用户，作为激活 CAC 可接受）；**不循环、不每月续**。
- **Phase 2 credit 包**：按"原始推理成本 × 2–3 倍"定价保毛利；$5 主力包 + **$1 引流试用包**（近成本价，保留"$1 起"的低价获客心智）。

### 为什么不用 $1/月订阅（被否决的形态）
- $1 微额月费的 Stripe 手续费（≈ $0.30 + 2.9% ≈ 33%）效率最差，到手仅 ≈ $0.67。
- agent 是 token 黑洞，固定月费 + 重度用户长尾会持续亏。
- credit 包天然对齐成本、手续费友好、无订阅承诺心理门槛。

## 4. 架构

后端采用 **Supabase 一体化**（Auth + Postgres + Edge Function + Stripe），把"造一个后端"压缩成"一个 Supabase 项目 + 一个薄记账 Edge Function"。

```
┌─ Supabase ───────────────────────────────────┐
│  Auth        邮箱 + Google OAuth，签发 JWT       │
│  Postgres    accounts / credit_ledger / usage  │
│              / tier_config / entitlements      │
│  Edge Func   /v1/chat —— 薄记账代理（Deno，SSE） │
│              /stripe-webhook —— 充值入账         │
│  Secrets     上游 API key（只在服务端）           │
└──────────────────────────────────────────────┘
        ▲ JWT（Authorization: Bearer）
        │ SSE 流式
┌─ Chrome 扩展 ────────────────────────────────┐
│  managed provider instance：apiKey = JWT       │
│  baseUrl = https://<proj>.supabase.co/...      │
│  发 tier_id（不发 model 名）                     │
└──────────────────────────────────────────────┘
        ▲ 上游（服务端按 tier_config 解析）
   Gemini 2.0 Flash / 可热切换
```

### Edge Function `/v1/chat` 的全部职责
1. 验 JWT → user_id（无效/过期 → 401）。
2. 解析请求里的 `tier_id` → 查 `tier_config` → 拿到真实 `upstream_model` / `upstream_base` / `params` / `credit_rate` / `min_entitlement`。
3. 查该 user 的 entitlement，免费用户请求高级档 → **403**（服务端是权限真相，不信任客户端门控）。
4. 查 `credit_ledger` 余额 → 不足 → 402。
5. 查限流计数器 → 超限 → 429。
6. 代理请求到上游，**透传 SSE 流**给客户端。
7. 流结束拿到 usage（prompt/completion tokens）→ 按 `credit_rate` 换算 → 事务写 `usage` + 扣 `credit_ledger`。

### 关键数据流原则
- **计量真相 = 上游返回的 usage**，不信任客户端上报的任何数字（防伪造）。
- **扣费在流结束后结算**；流中途断了也按已消耗 token 扣（防薅半程）。
- 余额检查在请求前（粗粒度挡欠费），精确扣费在请求后（token 真相）；**允许单任务轻微透支一次**（下次请求才挡），换取实现简单。
- `credit_ledger` 是 **append-only 单一事实源**：signup grant / purchase / usage 都是流水，余额 = 流水求和（好审计、好对账）。

### 代码仓库隔离（重要）

服务端**不开源**，独立成一个 WiseriaAI org 下的**私有新仓库**（如 `pie-managed-backend`），与开源客户端 `pie-ai-agent` 物理隔离：

- **客户端仓库（`pie-ai-agent`，开源）**：只含 `managed` provider 的薄 wrapper。它需要的全部信息都是**公开可暴露的**——Supabase Function URL（`defaultBaseUrl`）+ Supabase anon key（设计上就是公钥）。**无任何 secret 落进开源仓库。**
- **服务端仓库（`pie-managed-backend`，私有）**：Edge Function 源码、`tier_config` schema / 迁移、上游 API key（走 Supabase secret，不进 git）、Stripe webhook 逻辑、限流/计量实现。
- 边界即"网络协议"：两仓库通过 `/v1/chat` 的请求/响应契约耦合，各自独立演进、独立发版。客户端发版（§Release 流程）完全不依赖服务端仓库。
- 远端 GH 操作前按项目约定 `gh auth switch --user WiseriaAI`（org 仓库需要 admin scope）。

## 5. 客户端接入

复用现有 instance / provider 抽象（已确认零阻力）：

- 新增 builtin provider `managed`：
  - `registry.ts` 加 entry，`defaultBaseUrl` 固定指向 Supabase Function URL。
  - 新建 `providers/managed.ts`：薄 wrapper，`authHeaders` hook 注入 JWT。
  - `providers/index.ts` dispatch 表加 `managed`。
  - `manifest.json` host_permission 加 Supabase 域名。
  - `BuiltinProvider` 类型加 `managed`。
- instance 的 `apiKey` 字段存 **JWT**；`createInstance` 的非空校验天然满足（JWT 非空），**无需改**。
- 请求体携带 `tier_id`（不携带 model 名）。
- **JWT 刷新模块（新增的唯一客户端复杂度）**：Supabase JWT ≈ 1h 过期，存 refresh token，在收到 401 时静默刷新并重试一次；仍失败才提示重新登录。作为独立模块，单测覆盖"过期 → 刷新 → 重试"路径。
- **登录 UI**：Settings 新增"用官方服务（免 key）"入口 → 触发 Supabase OAuth / 邮箱登录 → 成功后自动建一个 `managed` instance 并设为 active，同时拉取 entitlement。

## 6. 免费池、防滥用与限流（Phase 1）

### 免费额度发放
- 注册成功 → 一次性写入 ≈ 20 任务额度的 credits 到 `credit_ledger`，`grant_type=signup`。
- **不循环、不每月续**。耗尽 → 402 → 客户端弹"额度用尽，转 BYOK 或买 credit"卡片。

### 防滥用（分层，Phase 1 只做 L1–L4）
| 层 | 手段 | 防什么 |
|---|---|---|
| L1 邮箱验证 | 必须验证邮箱才发额度；Google OAuth 视为已验证 | 随手批量注册 |
| L2 一次性发放 | 额度跟 user_id 走、不续 | 同账号反复领 |
| L3 disposable 域名拦截 | 拒一次性邮箱域名（开源黑名单） | 10 分钟邮箱薅 |
| L4 硬限流 | 见下 | 单账号短时榨干 / 被当免费 API |
| L5（备用，不预建） | 设备指纹 / 注册速率限制 / 人机验证 | 真被规模化薅时再上 |

**YAGNI**：L5 是"被薅了再说"，不预先建——20 任务 / 账号、廉价模型兜底，单账号薅到顶 ≈ $0.50，规模化之前先有信号。

### 限流（L4，两道）
- **并发**：单 user 同时 1 个在途任务请求（防开多 tab 并行榨）。
- **速率**：滑动窗口，≤ N 请求 / 分钟、≤ M credits / 天；超限返 429 带 `Retry-After`。
- N / M 给默认值 + 配置项，上线后按真实分布调。免费档限得狠没关系（目的是体验到价值，不是当日常 API）；付费档放松。

## 7. 思考强度档位与服务端模型配置

### 模型全服务端配置 + 热更改
模型映射放进 Postgres 的 `tier_config` 表（**不放 env/secret**，那个改了要 redeploy）：

```
tier_config
  tier_id          "default" | "advanced" | ...
  display_name     "标准" / "深度"（客户端显示用，不含模型名）
  upstream_model   真实模型 id（只在服务端）
  upstream_base    可选，换上游厂商时用
  params           JSON（temperature / reasoning effort 等）
  credit_rate      每 token 扣多少 credit（贵模型设高，成本自动对齐）
  min_entitlement  "free" | "paid"（谁能用这档）
  enabled          bool
```

Edge Function 每次请求读这张表（单行索引查询 ≈ ms；可加 30–60s 内存缓存）。**改模型 = 一条 UPDATE / 控制台改一格 → 几秒内全网生效，零 redeploy、客户端无感、无需发版。** 换更便宜的上游同理只动这一格。

### 客户端只露思考强度、不露模型名
- 客户端 UI：managed instance **不显示 model 下拉**，改成"思考强度"选择器，选项来自登录时服务端下发的 entitlement（用户能用哪些 tier 的 `display_name` + `tier_id`）。
- **免费用户：只有 `default` 一档**（选择器禁用或只显示一项）。**付费用户：解锁 `advanced` 等高级档。**
- 客户端**只发 `tier_id`，从不发模型名**；服务端用 `tier_config` 解析成真实模型。
- **权限真相在服务端**：免费用户请求高级档 → 403（客户端门控只是体验层，服务端是闸）。
- **credit 成本对齐**：高级档 `credit_rate` 更高，贵模型多扣 credit，营收/成本自动对齐。
- 高级档给 Phase 2 付费一个除"更多额度"之外的**第二个升级理由**。
- 非目标：不暴露"自选具体模型"；思考强度是有限的、服务端定义的离散档位，不是模型菜单。

## 8. Phase 2 计费（Stripe，一次性充值）

- 商品：**$1 引流试用包**（近成本价，获客钩子）+ **$5 主力包**（成本 ×2–3 定价）。**无订阅。**
- 流程：客户端开 Stripe Checkout（hosted 页面，零 PCI 负担）→ 付款成功 → Stripe webhook → `/stripe-webhook` Edge Function 验签 → 给 `credit_ledger` 加 credits + 必要时写 `entitlements`（解锁高级档）。
- credits **不过期**（一次性购买，过期招黑；真要控负债再说，YAGNI）。

## 9. 错误处理

| 情况 | 返回 | 客户端行为 |
|---|---|---|
| JWT 过期 | 401 | 静默刷新重试一次，仍失败才提示重新登录 |
| 余额不足 | 402 | 弹"额度用尽"卡片（BYOK / 买 credit） |
| 请求高级档但无权限 | 403 | 提示需升级（理论上客户端已门控，作 backstop） |
| 限流 | 429 | 提示"稍后再试"，带 Retry-After |
| 上游 5xx / 超时 | 502 / 504 | **不扣费**，提示重试 |
| 流中途断 | —— | 按已消耗 token 扣费（防薅半程） |

## 10. 测试策略（对齐项目 vitest 习惯）

- 客户端：`managed` provider 走现有 provider 测试套路（mock SSE）；JWT 刷新模块单测（过期 → 刷新 → 重试）；思考强度选择器按 entitlement 渲染/门控。
- 后端：Edge Function 用 Deno test —— 余额检查、token → credit 扣费结算、tier 解析、entitlement 门控、webhook 验签、限流计数，各覆盖。计量逻辑（token→credit 换算）重点测，直接挂钩成本与营收。
- 跨层：一条"登录 → 建 managed instance → 跑任务 → 扣费"happy path 端到端。

## 11. 风险与上线前置

- **【已评估，非 blocker】上游 ToS**：上游模型经 `tier_config` 服务端配置、可随时热切换——架构不绑定任何单一厂商（Gemini 只是候选默认之一）。本服务是 **Pie 应用代理自己的用户**（标准 SaaS-on-LLM 模式，主流厂商普遍允许），不是把 raw API 转售给第三方：`/v1/chat` 只服务 Pie agent，且强制 tier / 额度 / 限流，非裸 passthrough。因此 ToS **不作为上线硬门槛**。部署时按所选上游 skim 一遍其使用政策即可（如某家条款较严，default 换成 proxy-friendly 的 OpenRouter / DeepSeek）。注：此为产品/工程判断，非法律意见。
- **【告知】隐私姿态反转**：托管档用户的 agent 流量经过我们后端。需在 UI / 隐私说明里**明确告知**"官方档会经过我们服务器，BYOK 仍是端到端直连"，把选择权交给用户。

## 12. 非目标（Phase 1 / 2 都不做，进 backlog）

- 多上游成本套利、客户端自选具体模型
- 团队 / 企业账号
- 订阅制计费
- credit 过期 / 退款自动化
- L5 重度防滥用（设备指纹 / 人机验证）
- AI Gateway（缓存 / 可观测）—— 可作为 Phase 1.5 叠加
