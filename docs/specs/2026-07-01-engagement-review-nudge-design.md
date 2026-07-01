# 活跃度触发的评价 / Star 引导卡片 — 设计

- 日期：2026-07-01
- 范围：pie-ai-agent 单仓库，**纯客户端，无后端改动，无奖励发放**
- 状态：设计定稿；浮窗样式待 Paper 原型（浅色 + 深色）定稿 → 再写实施计划

## 目标

用户在本机用到"够活跃"后，在侧栏弹一张卡片，引导他去 Chrome 商店写评价、去 GitHub 点 Star。提高商店评分与 star 数。

## 非目标（本期明确不做）

- **不发奖励、不生成兑换码、不动后端。** 用户基数还不够大、活跃度模型未验证，正式发奖是过早优化。奖励延后（见文末"后续"）。
- 不做登录/账号维度的活跃度。本扩展是 BYOK，大量用户自带 key、从不登录；活跃度**只能按单机（本地）统计**，用账号维度会漏掉他们。
- 不验证用户是否"真的"写了评价 / 点了 star——Chrome 商店无此 API，GitHub star 需先绑定身份（不值得）。**靠诚信**：点了 CTA 就当到位。

## 活跃度信号（纯本地）

单个 IndexedDB config key `engagement`（复用 `src/lib/idb/config-store.ts` 的 `getConfig`/`setConfig`），存一个对象：

```ts
type Engagement = {
  messageCount: number;      // 累计用户发出的消息数
  activeDays: number;        // 使用过的不同"天"数
  lastActiveDay: string;     // 上次活跃的本地日期 "YYYY-MM-DD"，用于识别跨天
  promptState: "pending" | "snoozed" | "done";
  snoozeUntil: number;       // snoozed 时的解冻时刻（epoch ms）
  timesSnoozed: number;      // 点过几次"稍后"
};
```

**计数挂点**：`src/sidepanel/hooks/useSession/index.ts` 的 `sendMessage`。用户消息入列后 **fire-and-forget** 自增一个 `bumpEngagement()`（不 await、不阻塞发送路径，计数近似即可）：

- `messageCount += 1`
- 计算本地今天日期 `today`（用 `toLocaleDateString` 或 `Intl`，按用户时区）；若 `today !== lastActiveDay`：`activeDays += 1`，`lastActiveDay = today`。

> 注：读-改-写并发下极端情况可能少计 1，对一个"要不要弹 nag"的阈值无所谓（ponytail: 近似计数够用，不加锁）。

**触发阈值（默认值，改一行常量即可调）**：

```ts
const MIN_ACTIVE_DAYS = 2;
const MIN_MESSAGES = 8;
```

即 `activeDays >= 2 && messageCount >= 8`。用"活跃天数"做主门槛是为了过滤"一天猛发几条就再不来"的用户。选激进档：触达面大、拿评价/star 优先。

## 浮窗 UX 与弹出时机

- **形态**：**底部浮窗（floating popup）**，不是嵌在消息流里的行内卡。浮在侧栏内容之上、贴近底部输入框，圆角 + 轻阴影，可整块关闭。样式**先在 Paper 画原型（含浅色 + 深色），定稿后再落地前端实现**（见"原型"一节）。
- **弹出时机**：在**达到阈值的那一轮 chat 结束之后**弹——即某轮助手回复流式结束（`streaming` 由 true → false）的回调里评估 `shouldShow`，满足则弹浮窗。绝不在用户输入中或回复流式进行中打断。
- **显示条件**：`shouldShow(engagement, now)`：
  - 阈值已达（`activeDays >= MIN_ACTIVE_DAYS && messageCount >= MIN_MESSAGES`），且
  - `promptState === "pending"`，或（`promptState === "snoozed"` 且 `now > snoozeUntil`），且
  - 该轮回复刚结束、当前 `!streaming`，且
  - 没有更高优先级的卡/浮窗在显示（错误卡 / 文件访问卡）——评价 nag 优先级最低；有冲突则本轮不弹，留待下轮回复结束再评估。
- **内容**：星标 + 标题 + 一句话 + 两个 CTA + 右上角 ×：
  - 「在商店评价」（主，实心）→ `chrome.tabs.create({ url: CHROME_STORE_REVIEW_URL })`
  - 「GitHub Star」（次级，描边）→ `chrome.tabs.create({ url: GITHUB_STAR_URL })`
  - 右上角 **×** → snooze（见收敛规则；即"稍后"）
- **收敛规则（防烦）**：
  - 点任一 CTA（评价或 star）→ `promptState = "done"`，永不再弹。
  - 点右上角 **×**（= "稍后"，浮窗唯一的关闭入口）→ `promptState = "snoozed"`，`snoozeUntil = now + 30 天`，`timesSnoozed += 1`；若 `timesSnoozed >= 2` → 直接 `done`。
  - 结果：一个用户**最多被打扰约 2 次**。

## URL 常量

新建 `src/lib/engagement-urls.ts`（或直接放进已有 `feedback.ts`，那里已有 `GITHUB_REPO`）：

```ts
export const GITHUB_STAR_URL = "https://github.com/WiseriaAI/pie-ai-agent";
export const CHROME_STORE_REVIEW_URL =
  "https://chromewebstore.google.com/detail/gpccjhdgjkmalnepmeclooflliiocfed/reviews";
```

> ⚠️ 实施时**手动验证** `.../detail/<extensionId>/reviews` 深链能直达评价 tab（Chrome 偶尔改路径格式）。extensionId `gpccjhdgjkmalnepmeclooflliiocfed` 来自现网 Web Store。如深链失效，退化为详情页 URL（用户自己滚到评价区）。

## i18n

在 5 个语言字典（`src/lib/i18n/dictionaries/*.ts`）新增 `engagement.reviewCard.*`：`title` / `body` / `rateButton` / `starButton` / `laterButton`。缺键自动回退英文。

## 原型（Paper）

浮窗样式在 Paper 里先画原型，**浅色 + 深色两版**，与现有侧栏设计语言（tokens：`bg-field`/`text-fg-1`/`text-fg-2`/`border-line`/`bg-fg-1 text-canvas` 按钮等）对齐。定稿后再落地前端，实现须与原型一致。

**原型已完成**（Paper 文件 "Pie Frontend"，`https://app.paper.design/file/01KQH5T49RW8RTNMMSTKD1EQEZ`）：

- artboard「P6 — 评价引导浮窗 · Dark」
- artboard「P6 — 评价引导浮窗 · Light」

结构（两版一致，配色取生产 token 真值）：底部浮窗 = field/白 surface + hairline 描边 + 轻阴影，浮在 composer 之上。头部 = 星标（accent tint 圆角块）+ 标题「觉得 Pie 好用吗？」+ 右上角 **×**（即"稍后"）；正文「希望您花一分钟时间，给我们一个评价反馈，或在 GitHub 点一个 Star，这对我们改进产品有很大的帮助」；双按钮 **在商店评价**（fg-1 实心主）+ **GitHub Star**（描边次级 + 星）。落地时按钮文案走 i18n。

## 涉及文件

新增 2：

- `src/sidepanel/hooks/useEngagementPrompt.ts`（读 `engagement`、算 `shouldShow`、在流式结束时触发、暴露 `snooze`/`markDone`）
- `src/sidepanel/components/EngagementReviewPopup.tsx`（浮窗 UI，按 Paper 原型实现）

改动 ~3 处：

- `useSession/index.ts` — `sendMessage` 里挂 `void bumpEngagement()`（计数逻辑放进小工具 `src/lib/engagement.ts`）；并在**流式结束回调**里触发一次浮窗评估
- `Chat.tsx`（或侧栏根 `App.tsx`）— 渲染底部浮窗
- i18n 字典 + URL 常量文件

## 测试（最小）

纯函数抽出来单测，避免碰 chrome/DOM（沿用 `feedback.ts` 的"注入 env、纯函数"风格）：

- `bumpEngagement`：跨天 `activeDays` +1、同天不 +1、`messageCount` 每次 +1。
- `shouldShow` / 状态机：pending 达阈值→显示；点 CTA→done 不再显示；snooze→30 天内不显示、之后再显示一次；第二次 snooze→done。

## 后续（延后，不在本期）

活跃度模型跑一段时间、验证 nag 转化正常、用户量起来后，再设计"评价换 3 天订阅"的发奖。后端兑换码系统已现成，接入很轻：

- `POST /admin/codes`（批量生码）/ `POST /admin/users/:id/grant-pro`（直接加时长）/ `/redeem` 均已实现。
- 届时若走"登录用户直接发放"，新增一个幂等 `POST /rewards/claim`（每账号一生一次 + 服务端校验真实用量防刷）比"生成码给用户再粘回来"更简单也更安全（码会被截图转发）。
- 领奖必然要求登录（本期 nag 不要求）；未登录用户仍可被 nag，只是拿不到奖励。

```

```

