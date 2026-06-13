# 渐进式工具披露（Progressive Tool Disclosure）设计

- 日期：2026-06-13
- 状态：设计稿（规划中精化，待转 plan 落地）
- 关联：#175（prompt cache 修复）、`filterToolsByVision`、skill catalog pattern、未来 MCP 接入

## 1. 背景与动机

当前 agent 每一轮把**全部 ~52 个工具**的 schema（合计 ~11K tokens）一次性塞给模型（仅受 `filterToolsByVision` / keyboard / editor / `excludeToolNames` 四处弱门控）。工具在 `loop.ts:1648–1662` **每轮重新组装**，且组装发生在 `interpretPinnedTabUrl()` 解析完当前 tab URL（`loop.ts:1424`）之后——组装那一刻，代码已经知道当前 tab 是 PDF / 网页 / `file://` / restricted、CDP 是否可用、是否有启用的 skill。环境信号是现成的，但没有被用来裁剪工具。

这带来三个问题，按本设计的优先级排序：

1. **工具选择质量 / 可靠性**（首要）：~52 个工具里真正高频核心的约一半。长尾工具（PDF、scratchpad、schedule、skill 编辑）始终在场，增加模型选错 / 混淆概率，尤其拖累长程任务。
2. **MCP 铺路**：若未来接入 MCP（工具数量级膨胀），全量披露不可持续。需要"按需披露"地基。
3. **首字延迟 / 上下文占用**：更小的 tools 前缀 = 更快 prefill、更多 context 余量留给页面内容与历史。

> **明确不以"省 token 成本"为首要目标**。#175 后 tools 数组是缓存前缀的一部分：Anthropic 显式标 cache、DeepSeek/OpenAI 自动缓存整段前缀，对这些 provider 工具 schema 只在首轮付全价、之后每轮只付 0.1x cache read，边际省钱有限。真正每轮省钱的只有 mimo/minimax/stepfun（不缓存）。Token 是顺带收益，不是设计驱动——这点决定了下面在缓存上做的取舍（§7）。

## 2. 目标与非目标

### 目标
- 把"已有的弱版条件披露"（vision/keyboard/editor 门控）统一成一套机制。
- 核心工具集从 ~52 降到 ~30（v1，见 §4 分期），长尾按**环境点亮**或**LLM 按需 `load_tools`** 进场。
- 披露**单调粘性**：能力一旦激活保留到 session 结束。
- 为 MCP server 接入预留"一个 server = 一个懒加载能力包 = 目录一行"的扩展点。

### 非目标
- 不做语义检索 / embedding（目录足够小，按名加载即可；MCP 撑大隐藏集后再加 search 薄层，见 §9）。
- 不改 provider 层缓存机制（#175 的缓存边界保持不变）。
- 不动工具 read/write 分类（R7 跨 session 锁继续用 `TOOL_CLASSES`）。
- 不引入运行时 confirm / risk 层。
- **不让 system prompt 变成每轮重建**（保 #175 静态前缀缓存命中，见 §5）。

## 3. 核心抽象：能力包（capability bundle）

披露单位是**能力包**，而非单个工具：一组工具 + 一段引导文本（usage guidance）。每个工具在构建期被静态归入恰好一个能力包（§8 不变量保证全覆盖）。

但**工具 schema 与引导文本的投放渠道不同**（这是规划中关键精化）——因为 system prompt 在 task 开始时只构建一次、全程静态（`loop.ts:1261`，#175 缓存设计），而工具数组每轮重组（`loop.ts:1648`）：

| 内容 | 投放渠道 | 时机 |
|---|---|---|
| 工具 schema | 每轮组装的 `tools` 数组 | 激活当轮即生效（env 同轮 / load_tools 次轮） |
| 引导文本（开局即激活的包） | **静态 system prompt** | task 开始一次性写入 |
| 引导文本（开局未激活、中途激活的包） | **激活通知**：env → 注入 trusted `<system_notice>`；load_tools → 工具结果文本 | 激活那一刻随观察消息进入对话（动态后缀，本就不在缓存前缀内） |
| 隐藏能力目录 | **静态 system prompt**（开局列出所有"开局未激活"的可加载包，全程不变） | task 开始一次性写入 |

这样 system prompt 全程字节恒定（#175 缓存不破），中途激活的引导文本走 `<system_notice>` 这条**现有**的 trusted runtime 通道（与导航 notice 同机制），逻辑一致且 MCP-ready（MCP 工具的 guidance 不可能全静态塞 system prompt，必须走激活投放）。

披露**单调粘性**：能力一旦激活保留到 session 结束，避免"按当前 tab 类型门控→切 tab 反复变 tools 数组"。

## 4. 工具分层与 group 划分

### 4.1 v1 分期（本期 plan 落地）

| 层 | group | 工具 | 触发 |
|---|---|---|---|
| **core**（~30，永远在） | `core` | click/hover/type/scroll/select/wait/done/fail、read_page、find_target/read_collection/read_table/read_target/extract_records、**全部 9 个 tab 工具**、search_web、output_file、**keyboard(dispatch_keyboard_input/press_key)**、**editor(read_editor/set_editor_value)**、`load_tools`(新增) | 永远 |
| **env 点亮**（粘性） | `screenshot` | capture_visible_tab / capture_fullpage_tab | `modelConfig.vision === true`（沿用现有 `filterToolsByVision`，开局即定） |
| | `skill-mediation` | use_skill / read_skill_file | `getEnabledSkillPackages()` 非空（开局即定；skill catalog 块随之出现） |
| | `pdf` | read_pdf / search_pdf / get_pdf_outline | 本 session 任一轮 `isPdfTab(currentTab)` 为真 |
| | `local-file` | read_local_file / request_local_file | 当前上下文 `file://` |
| **lazy**（目录 + load_tools） | `scratchpad` | save_records / update_notes / read_records / clear_scratchpad / query_scratchpad | LLM 按需加载 |
| | `schedule` | create_schedule / update_schedule / delete_schedule / list_schedules | LLM 按需加载（headless 不可加载） |
| | `skill-authoring` | create_skill / update_skill / delete_skill / list_skills | LLM 按需加载 |

> 普通网页任务（无 vision/无 skill）基础集 = core ~30；相比全量 ~52 砍掉 pdf(3)+local-file(2)+screenshot(2)+skill-mediation(2)+scratchpad(5)+schedule(4)+skill-authoring(4)=22 个。机制本身在这套安全分组上验证，无回归风险。

### 4.2 v2 分期（fast-follow，本期不做）

- **editor / keyboard 从 core 收紧为 env 点亮**：触发器 = read_page 交互快照检测到 `role="editor"` 宿主。v1 暂留 core，因为该信号需在 loop 内解析 read_page **工具结果**（当前是不透明观察），且会牵动"CDP 未授权时调用触发 consent"的现有流程——单独立项验证后再收紧，避免本期回归。
- **tab-advanced 从 core 拆出**：close/group/ungroup/move/unpin 拆成懒加载包。需拆分 `TAB_TOOLS_GUIDANCE` 一整块文本，本期不做。

分期理由：v1 先证明机制（目录 + load_tools + env 点亮 + 粘性状态 + 缓存行为），把"信号难取 / 文本需拆 / 有回归面"的三组留给 v2。

## 5. 发现机制：静态隐藏能力目录 + `load_tools`

与现有 `buildSkillCatalogBlock`（`prompt.ts:302`）以及 Claude Code harness 自身 "deferred tools 只列名、按需取 schema" 完全同构。

### 5.1 静态隐藏能力目录（system prompt 块）

task 开始时，按"开局未激活的可加载包"渲染一个静态目录块，每包一行：

```
<available_tools_catalog>
你当前可见的是常用核心工具。以下能力按需加载——判断需要时调 load_tools({groups:[...]})，下一轮即可用：
- pdf — 读取 / 搜索 PDF 文档（read_pdf / search_pdf / get_pdf_outline）
- scratchpad — 长程结构化抽取的持久记忆（save_records / query_scratchpad ...）
- schedule — 创建 / 管理定时 Agent 任务
- skill-authoring — 把可复用工作流持久化为 skill
- local-file — 读取本地文件
</available_tools_catalog>
```

- 目录只占几百 token（vs 完整 schema ~11K），且**全程静态**——它列"开局未激活"的包，task 内不增删（保 system prompt 字节恒定）。
- 某 env 包中途被环境点亮、或某 lazy 包被 load_tools 激活后，它仍留在目录里——再次 load 同名包是幂等 no-op（§5.2）；激活事实由"激活通知"（§3）告知 LLM，目录不需要反映动态状态。这是为 system prompt 字节恒定付出的极小代价（一行冗余文本）。

### 5.2 `load_tools` 工具（core 成员）

```
load_tools({ groups: string[] })
```

- 校验每个名字 ∈ 已知可加载 group（pdf/local-file/scratchpad/schedule/skill-authoring/screenshot；headless 下 schedule 不可加载）；未知 → 错误并回列合法名字。
- 合法且未激活的 group 加入 `activeToolGroups` 并持久化（§6）。
- 幂等：已激活 → 计入 `alreadyActive`，不重复。
- 返回 `{ loaded: string[]/*新可用工具名*/, alreadyActive, unknown }`，并在结果文本里附上该包的引导文本（§3 激活通知）。
- **一轮延迟**：因工具按轮组装，新加载工具在**下一轮** assistant turn 的 schema 出现；结果文案显式说明，契合 ReAct 流。

env 包也允许被 load_tools 按名加载（覆盖"环境探测漏了"的失败模式，服务可靠性首要目标）。

## 6. 状态与组装改造

### 6.1 状态
`SessionAgentState`（`src/lib/sessions/types.ts`）新增 `activeToolGroups?: string[]`，经 `buildSessionAgentSnapshot` / `buildSessionAgentTombstone` 跨步持久化（SW 重启可恢复，复用现有 snapshot 机制）。
- 开局 seed = `["core", ...开局即满足 env 触发的包]`（vision→screenshot、skills→skill-mediation；若开局 currentTab 已是 PDF/file 则 pdf/local-file 也在）。
- 之后单调增长：每轮 env 探测命中 → 加包并持久化；load_tools → 加包。只增不减。

### 6.2 组装（`loop.ts:1648–1662`）
现有"拼平全部工具 → filterToolsByVision → excludeSet → toolsToDefinitions" 改为：
1. 每轮先跑 env 探测（读已算好的 `currentTab` / `modelConfig.vision` / `skillCatalog`），把新命中的 env 包并入 `activeToolGroups`（持久化）；新并入时记下"本轮新激活包"以便注入 `<system_notice>`（§3，warn-once 复用现有 noticeKey 去重）。
2. `tools = allTools.filter(t => activeToolGroups 含 TOOL_GROUPS[t.name])`。
3. `filterToolsByVision` 退化为 `screenshot` 包的 env 触发器（语义不变、fail-closed 保持）；`excludeSet` 保留（headless 的 schedule 由"不在 seed、且 load_tools 拒绝加载"自然达成，excludeSet 作额外保险）。
4. `toolsToDefinitions(tools)` 不变。

### 6.3 system prompt（`prompt.ts`，构建一次）
`buildAgentSystemPrompt(...)` 入参增加 `startActiveGroups: string[]`：
- **core 引导**（READ_PAGE / FRAME_AWARENESS / TAB / SEARCH，外加 v1 留在 core 的 KEYBOARD/EDITOR/META... 不——见下）始终在。
- **开局即激活的 env 包引导**（如有）拼接：screenshot 无引导块；skill-mediation 即现有 skill catalog 块（保持）。pdf/local-file 引导仅当开局即激活才进 system prompt，否则走激活通知。
- 末尾渲染 §5.1 目录块（列开局未激活的可加载包）。
- 其余（STATIC_AGENT_SYSTEM_PROMPT / pinnedContext）不变，仍在缓存前缀内。
- KEYBOARD_SIM_GUIDANCE / EDITOR_TOOLS_GUIDANCE / META_TOOL_GUIDANCE / PDF_TOOLS_GUIDANCE / SCRATCHPAD_GUIDANCE 等**非 core 包的引导常量**从 prompt.ts 迁入能力包注册表（`disclosure.ts`），由"开局激活则进 system prompt / 中途激活则进通知"两条路按需取用。v1 中 keyboard/editor 属 core，其引导随 core 常驻 system prompt（不迁）。

## 7. 缓存行为（含诚实成本警示）

- **system prompt 全程字节恒定**——目录静态、引导走通知、task 不重建 → #175 的 system 前缀缓存命中**完整保留**。
- **tools 数组在激活时变化**。⚠️ Anthropic 缓存层级顺序是 **tools → system → messages**，tools 在最前；改 tools 会让整段前缀（含 system）在该轮 **整体重写一次缓存**（1.25x write）。即每次能力激活 = 一次全前缀 re-cache。
- 但激活是**罕见且单调有界**事件（v1 至多 ~7 个非 core 包，一个 session 通常激活 0–2 个）。对 Anthropic：换来更小的首轮 tools（更快首字 + 更省首轮 write）+ 更好的工具选择质量；代价是每次激活一次 re-cache。**因首要目标是可靠性/MCP/延迟而非 token 成本，这个取舍可接受**；且对不缓存的 mimo/minimax/stepfun 是纯赚。
- 绝不出现反复 churn：env 包只加不撤，切 tab 不移除已激活包。
- `<current_time>` / `<user_task>` 已在缓存边界外（#175），与本机制正交。

## 8. 构建期不变量

沿用 `tool-names.ts` 既有"每个工具必须声明 read/write class 否则 throw"pattern，新增 `TOOL_GROUPS: Record<toolName, DisclosureGroup>` 与配套 throw：
- **每个已知工具名（KNOWN_BUILT_IN + KEYBOARD + EDITOR）必须恰好属于一个 group**，否则 module load 抛错（防新工具漏归类、悄悄退回全量披露或彻底不可见）。
- 每个非 core group 必须在注册表声明 `catalogLine`；可加载 group 必须可被 load_tools 解析。

## 9. MCP 就绪（扩展点，非本期）

一个 MCP server 天然是一个 `lazy` 包：目录加一行（server 名+描述），load_tools 拉该 server 工具 schema，guidance 走激活通知。机制零改动。隐藏集被 MCP 撑大到"目录列不下"时，在 load_tools 同一加载路径上加 `search_tools({query})` 语义薄层——届时 search 与 load 共用激活/持久化通路，不重写。本期仅保证抽象不挡路。

## 10. 回退 / 灰度

无独立"全量披露"代码路径——**全量披露 = activeToolGroups 含所有 group 的退化配置**。
- 实验开关 `progressiveToolDisclosure`（设置页「通用 / 实验」区，默认 **on**）：关 → seed `activeToolGroups` 为全部 group（system prompt 含全部引导、目录块省略），等价今日行为，便于 A/B 验证可靠性。
- 开关只影响 seed，不引入分支逻辑，维护成本近零。

## 11. 测试策略

- **group 全覆盖不变量**：所有工具名恰好归一个 group；构建期 throw 路径有测试。
- **selectTools**：activeGroups → 正确工具集；core 永远在；未激活包工具不出现。
- **env 触发**（纯函数 `groupsForEnv(signals)`）：vision/pdf/file/skills 各自点亮对应包、无信号不点亮。
- **单调粘性**：env 包点亮后即便信号消失仍保留；切 tab 不移除已激活包。
- **load_tools**：合法加载、未知名报错、幂等（alreadyActive）、返回新工具名 + 引导；env 包可手动 load 兜底；headless 拒绝 schedule。
- **目录渲染**：列开局未激活的可加载包；全激活时目录块省略。
- **system prompt 静态不变量**：同一组 startActiveGroups 下 `buildAgentSystemPrompt` 字节恒定（扩展现有 #175 静态测试）。
- **激活通知**：env 中途点亮注入一次 `<system_notice>`（warn-once）；load_tools 结果含引导。
- **回退开关**：`progressiveToolDisclosure=false` → 工具集与今日逐一致。
- 现有 `vision-tool-gating.test.ts` 适配为 `screenshot` 包 env 触发器测试。

提交前跑 `pnpm test` / `pnpm typecheck` / `pnpm build`（含构建期不变量）。

## 12. 影响面

| 文件 | 改动 |
|---|---|
| `src/lib/agent/tool-names.ts` | 新增 `TOOL_GROUPS` + `DisclosureGroup` 类型 + 构建期不变量 |
| `src/lib/agent/disclosure.ts`（新） | 能力包注册表（catalogLine/guidance/kind）+ `groupsForEnv` + `selectTools` + `buildToolCatalogBlock` + `buildActivationNotice` |
| `src/lib/agent/tools/disclosure.ts`（新） | `load_tools` 工具实现 |
| `src/lib/agent/prompt.ts` | 非 core 引导常量迁出；目录块；入参加 startActiveGroups；保字节恒定 |
| `src/lib/agent/loop.ts` | 组装段改 selectTools；每轮 env 探测并入 activeToolGroups + 注入激活 notice；system prompt 传 startActiveGroups |
| `src/lib/sessions/types.ts` | `SessionAgentState.activeToolGroups` + snapshot/tombstone 透传 |
| 设置页「通用/实验」 | `progressiveToolDisclosure` 开关 |

## 13. 待办 / 开放问题

- v2 fast-follow：editor/keyboard env 收紧、tab-advanced 拆分（§4.2）。
- `output_file` 归 core（v1 决定：单工具、产文件高频、避免与 scratchpad guidance "export with output_file" 的耦合不一致）。
- group 成员划分（§4）以 review 结论为准。
