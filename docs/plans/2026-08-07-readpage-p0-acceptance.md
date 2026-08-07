# ReadPage P0 真机验收手册

对应 `docs/plans/2026-08-07-readpage-p0.md` 的六个切片（commit `a51ba852`…`a310250a`）。
目标：确认 token 降下来了，**并且任务成功率没降**。后者是硬门槛。

## 0. 准备

1. `dist/` 已同步到主仓库，去 `chrome://extensions` 点扩展卡片上的**刷新**按钮
2. 在同一张卡片上点 **"Service Worker"** 链接 → 打开 SW 的 DevTools console
   （`[read_page]` 和 `[ctx]` 两条日志都在 SW 里打，**不在侧栏的 console**）
3. console 右上角筛选框输入 `[read_page]` 或 `[ctx]` 可只看其一；建议先不筛，两条交替看

> SW 会被 Chrome 回收，console 会清空并显示 "Service worker was stopped"。任务跑起来后
> 它就活着，中途停了重新点开即可，不影响已跑完的任务。

## 1. 怎么读日志

### `[read_page]` — 单次返回体的构成

atlas 路径：

| 字段 | 含义 | 关注点 |
|---|---|---|
| `controls.n` | 页面上的控件总数 | 就是老问题的规模，实测能到 484 |
| `controls.shown` | top-K 后实际渲染的条数 | **应 ≤ 40**；`n - shown` 就是省掉的量 |
| `controls.chars` | 这些 `<control>` 行的字符数 | 改造前 484 条 ≈ 14483 tokens |
| `targets.n / chars / est` | data_surfaces 整块 | 上限 20 |
| `next_actions.chars` | 应恒为 **0**（已删） | 不是 0 说明代码没生效 |
| `action_surfaces.est` | forms + controls 段的估算 token | |
| `total_est` | 整条 observation 的估算 token | **最关键的一个数** |
| `query` | 本次用了什么关键词过滤 | 不传时为 `undefined` |

snapshot 路径（interactive / content / full）：

| 字段 | 关注点 |
|---|---|
| `interactive_index.chars` | `mode:"content"` 时应为 **0** |
| `page_blocks.n / chars` | `mode:"interactive"` 时应为 **0** |
| `budget_exhausted` | true 说明撞到 byte cap 被截断了 |

### `[ctx]` — 每轮请求的上下文成本

| 字段 | 含义 |
|---|---|
| `step` | 第几轮 |
| `est` | 本地估算的总 token（历史 + tools） |
| `prompt` | provider 实报的输入 token —— **真账单** |
| `tools` | 工具定义占的固定开销（约 6000） |
| `hist` / `tail` | 历史部分 / 本轮新增的 user turn |
| `cached` | 命中缓存的 token 数 |
| `hit` | `cached / prompt`，命中率 |
| `out` | 输出 token |

**怎么判断健康**：
- 没读页的轮次 `hit` 应稳在 **90%+**
- 读了页的轮次 `hit` 掉到 50% 左右是**正常**的 —— 新页面内容天然不可缓存
- `est` 与 `prompt` 的比值现在应落在 **0.85 ~ 1.15**（切片 6 校准后）；仍在 0.5 附近说明校准没生效

## 2. 基线（改造前实测值，用于对照）

| 指标 | 改造前 |
|---|---|
| 单份 atlas | 20881 tokens（其中 controls 14483，占 69%） |
| controls 条数 | 484 全量渲染 |
| next_actions | 54 个 target × 1388 tokens |
| read_page 那轮的 prompt 增量 | +106411（cached 只 +1280） |
| `est` / `prompt` | 0.53 ~ 0.60 |

## 3. 场景清单

每个场景记录 `[read_page]` 的 `total_est` 和该轮 `[ctx]` 的 `prompt`。

### S1 — 控件密集页（切片 1 主场）

**选页**：控件多的后台/管理界面、电商筛选页、GitHub 仓库首页、任意带长导航的门户站。

**做**：`read_page({mode:"atlas"})`（让 agent 自然调用即可，比如问「这个页面上有哪些操作」）

**看**：
- [ ] `controls.shown ≤ 40`，且 `controls.n` 明显更大
- [ ] observation 尾部有 `<omitted controls="N" targets="M" hint="…" />`
- [ ] `next_actions.chars === 0`
- [ ] `total_est` **< 4000**（目标；基线 20881）

**注意看被选中的是什么**：排序是「视口内 > 输入框 > 选择器 > 按钮 > 链接」。如果首屏的主要操作
（搜索框、主按钮）没进来，说明排序规则要调。

### S2 — top-K 漏召回（**本次最需要盯的风险**）

**做**：在 S1 那个页面上，让 agent 去点一个**藏在页面深处、不在首屏**的控件。
例：「把页脚的语言切换成 English」「点开第 3 个筛选器里的『仅看有货』」

**看**：
- [ ] agent 发现 atlas 里没有该控件后，**主动**用了 `read_page({mode:"atlas", query:"…"})`
      或 `mode:"interactive"`，而不是瞎猜索引、反复重读、或直接放弃
- [ ] 最终点到了正确的元素

**这一项失败 = 兜底机制没生效**，是 P0 唯一可能真正伤害任务成功率的地方。
失败请记下 agent 当时的原话（它是怎么理解 `<omitted>` 的），那决定 hint 措辞怎么改。

### S3 — 列表 / 表格抽取（切片 2）

**选页**：商品列表、邮箱收件箱、任意带表格的数据页。

**做**：「把这个列表的名称和价格整理成表格」

**看**：
- [ ] `read_struct` 的返回里，每条 record 是**一行** `<record id="…" evidence="…">{...}</record>`
- [ ] JSON 里是**裸引号** `"name":"…"`，不是 `&quot;name&quot;`
- [ ] 超过 50 条时有 `omitted="N"` 和 `range=50..N` 提示，且 agent 会照着翻页
- [ ] **抽出来的数据没缺字段** —— 尤其 collection 类的卡片，价格/状态应在 `_text` 里

### S4 — mode 表示面分离（切片 3）

**做**：手动让 agent 分别跑三个模式（可以直接说「用 read_page 的 content 模式读这一页」）

**看**：
- [ ] `mode:"interactive"` → `page_blocks.n === 0`，返回里没有 `<untrusted_page_content`
- [ ] `mode:"content"` → `interactive_index.chars === 0`，返回里没有 `<interactive_index`
- [ ] `mode:"full"` → 两者都有

### S5 — atlas 直接点击（切片 5）

**做**：一个「读页 → 点某个按钮 → 看结果」的任务，比如「搜索『xxx』并打开第一条结果」

**看**：
- [ ] agent 在 atlas 之后**直接** `click`，中间**没有**多插一次 `read_page({mode:"interactive"})`
- [ ] 点中了正确的元素（没有点错位）

**点错位是最严重的失败**（parity 测试已覆盖，但真机 iframe / shadow DOM 场景更复杂）。
一旦出现，记下页面 URL 和 `frame_id`，这说明 atlas 与 interactive 的编号在该页面上确实会漂移。

### S6 — target evidence 保留（切片 4）

**做**：长任务 —— 先 `read_struct` 抽一批数据，然后**继续操作页面若干轮**（翻页、点开详情、
再读别的页），最后问「刚才抽到的那些数据里，第一条是什么」

**看**：
- [ ] agent 能直接答上来，**不需要**重新抽一遍
- [ ] 改造前这里会失败：抽出来的记录被 elide 成 marker 了

### S7 — 长任务综合（切片 6 + 整体）

**做**：一个 30 轮以上、反复读页操作的真实任务。

**看**：
- [ ] `est / prompt` 落在 0.85 ~ 1.15
- [ ] compaction 触发后，后续轮次的 `hit` 能回到 90%+（不是每轮都掉）
- [ ] 整任务的累计 token 相比印象中的旧版本明显下降
- [ ] **没有出现 context 超窗报错**（切片 6 若校准过头会压得太频繁，但不会超窗；
      若仍超窗说明 2.5 还不够保守）

## 4. 记录表

| 场景 | 页面 | `total_est` | 该轮 `prompt` | 通过？ | 备注 |
|---|---|---|---|---|---|
| S1 | | | | | |
| S2 | | | | | |
| S3 | | | | | |
| S4 | | | | | |
| S5 | | | | | |
| S6 | | | | | |
| S7 | | | | | |

## 5. 出问题怎么办

六片各自是独立 commit，可以单独 revert 而不影响其它片：

| 症状 | 嫌疑片 | commit |
|---|---|---|
| 找不到控件 / 反复重读 | 切片 1 top-K | `a51ba852` |
| 抽取数据缺字段 | 切片 2 text 去重 | `db97a89b` |
| 拿不到需要的正文或索引 | 切片 3 mode 分离 | `b7a500e3` |
| 点错元素 | 切片 5 atlas 直点 | `3c0f5bfb`（prompt-only，改回描述即可） |
| 压缩过于频繁 | 切片 6 除数 | `a310250a`（调 `CHARS_PER_TOKEN`） |

只想调阈值不想 revert 的话，三个常量都在明处：
- `page-atlas/render.ts` 的 `MAX_CONTROLS` / `MAX_TARGETS`
- `page-atlas/target-tools.ts` 的 `DEFAULT_RECORD_LIMIT`
- `window-token-budget.ts` 的 `CHARS_PER_TOKEN` / `CJK_CHARS_PER_TOKEN`

## 6. 验收结论要回答的问题

1. **单次 atlas 降到多少？** 目标 20881 → < 4000
2. **任务成功率有没有降？** 特别是 S2 和 S5
3. **P0.6（collection/controls 去重）还要不要做？** 看 S1 的 `controls.chars` ——
   若已降到 1500 tokens 量级，这条就是无意义工作
4. **要不要继续 P1 Page Store？** 若 P0 后典型 read_page 已在 3~5k tokens，
   就不必付 MV3 生命周期那套复杂度
