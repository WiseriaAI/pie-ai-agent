---
date: 2026-05-08
topic: skill-tool-convention
status: brainstormed
related:
  - docs/ROADMAP.md  # §13 P3 第 4 项 "skill 与 tool 命名空间隔离"，本 spec 是其前置规范层
  - src/lib/skills/builtin.ts  # 7 个 builtin skill 定义；本 spec 审计删 2 个
  - src/lib/skills/index.ts  # getAllSkills / getEnabledSkills merge 逻辑，migration 影响点
  - src/lib/skills/storage.ts  # enabledIds 数组语义（plain id / "!id"），migration 入口
  - src/lib/agent/tool-names.ts  # KNOWN_BUILT_IN_TOOL_NAMES + TOOL_CLASSES，本 spec 不动
  - src/lib/agent/tools.ts  # tool description（英文），本 spec 固化为约定
  - https://github.com/WiseriaAI/Pie/issues/44  # 反馈源 §1（工具体系重叠）
  - https://github.com/WiseriaAI/Pie/issues/45  # 反馈源 §2 / §9（命名空间）
---

# Skill vs Tool 规范

## Problem Frame

issue #44 / #45 反馈"工具体系重叠 → 模型决策负担偏大"。ROADMAP §13 校准后发现：60% 是对 skill / tool 分层的误读（把 built-in skill 当 tool 看），但 **暴露一个真问题** —— 当前 7 个 builtin skill 中有 2 个是 "包一个 tool + 参数透传" 的薄壳（`take_screenshot` 包 `capture_visible_tab` / `open_url_in_tab` 包 `open_url`），让 LLM 在 tool 列表里同时看到 skill 名 与 tool 名命名相近，造成命名空间认知摩擦。

更根本的问题：**当前没有写在文档里的 "什么时候做 tool / 什么时候做 skill" 判定标准**。新功能加进 builtin.ts 还是 tools/*.ts 全靠惯例 + reviewer 直觉。

本 spec 目的：

1. **文档化** tool / skill 分层判定准则（固化已落地的事实，不引入新设计）
2. **审计** 现有 7 个 builtin skill，删除不符合规范的薄壳

## Decisions Locked During Brainstorm

| 锁定项 | 取值 | 替代方案被弃理由 |
|---|---|---|
| 规范 scope | 文档化 + 审计现有 builtin skill | "纯文档化不动 builtin"被否，否则规范立完没消除 LLM 命名空间摩擦；"额外加命名空间隔离 (`skill__` prefix / description tag)" 推 backlog（§13 P3 #4） |
| 单步薄壳 skill 立场 | 禁用 — skill 必须是真组合 | "允许作为 UI 语义入口"被否（`enabled:false` 默认禁用已是隐式回避，但留着拖累 LLM）；"双重要求二选一" 被否（避免审计环节主观讨论） |
| skill 真组合判据 | ≥ 2 底层 tool 调用 **OR** LLM 推理参数化 | "必须 ≥ 2 tool 调用"被否（会牵连 `extract_structured_data` —— 它只调 1 个 tool 但靠 LLM 把 fields → JSON，是真推理价值） |
| 中文语义入口替代方案 | 不另做（用户在 chat 自然语言触发） | "未来 sidepanel 快捷按钮"留口子但不进本 PR；UI 入口与 LLM tool 列表是两条管线，删 skill 不损 UI 入口选项 |
| 命名空间隔离 (skill__ prefix) | 留 backlog | 删完 2 个薄壳后剩余 5 个真组合 skill 名（`auto_group_tabs` 等）与 tool 名（`group_tabs` 等）依然有相似性，但因都是真组合，description 能让 LLM 区分；prefix 是更大设计决策（storage migration / prompt 改造），不在本 spec |

## 规范本体

### 1. Tool —— `src/lib/agent/tools.ts` + `src/lib/agent/tools/*.ts`

**判定**（满足任一即应做成 tool）：

- 调用 chrome.* API / DOM op / CDP 的原子操作，单步不可再拆
- 需要 `risk.ts` classifier 介入（确认卡 / 风险升级路径）
- 需要 `tool-names.ts` 的 read/write class 介入（M3 R7 跨 session 锁）
- 需要 manifest host_permission

**规范要求**：

- description 用 **英文**（LLM-facing wire；进 system prompt 的 tool 列表）
- 必须在 `KNOWN_*_TOOL_NAMES` 注册 + `TOOL_CLASSES` 声明 read/write
- always-high 风险工具必须在 `risk.ts` `ALWAYS_HIGH_*` 集合声明
- 跨 tab 工具必须在 `risk.ts` `ALWAYS_HIGH_TAB_TOOLS` 或 `ARGS_CONDITIONAL_TAB_TOOLS` 二选一登记（G-1 build-time check）

**典型例**：`click` / `type` / `capture_visible_tab` / `open_url` / `list_tabs` / `group_tabs` / `dispatch_keyboard_input`

### 2. Skill —— `src/lib/skills/builtin.ts`（builtin）+ user-authored

**判定**（**必须同时**满足两条）：

1. **真组合**：promptTemplate 描述的 workflow 满足 ≥ 2 个底层 tool 调用 **OR** 需要 LLM 推理参数化（如 `extract_structured_data` 把"用户描述的 fields"→ JSON 字段映射；`create_skill_from_recording` 把 trace → 参数化 promptTemplate）
2. **用户语义入口价值**：在 SkillsList 上有"人话任务名"意义（"分组打开的标签"、"清理重复标签"），不是裸 tool 别名

**规范要求**：

- description 用 **中文**（用户-facing；SkillsList UI + LLM tool 列表都看得到）
- promptTemplate 必须显式列步骤（"Steps: 1. ... 2. ...")，不能仅"call X with Y"
- 真有 sensitive 参数（密码 / token）需写 `{{placeholder}}` 让 trace 时自动占位
- builtin skill 必须 `builtIn: true`（import-time assertion 已守）

**典型例**：`auto_group_tabs`（list_tabs → 分类推理 → 多次 group_tabs）/ `extract_structured_data`（snapshot 读取 + 字段推理 + 格式化）/ `create_skill_from_recording`（trace 解析 + 参数化推理 + create_skill 调用）

### 3. 反规范模式 —— 不允许新建

**单步薄壳 skill**：promptTemplate 仅"call ToolX with these args"+ 参数 schema 与 tool 参数 1:1 透传。

为什么禁：

- 不是真组合，没引入 LLM 推理价值
- 让 LLM tool 列表同时出现 skill 名 + tool 名（命名空间摩擦）
- "中文 UI 入口"的诉求应该走其他渠道（用户 chat 自然语言 / 未来 sidepanel 快捷按钮注入），不该挤占 LLM context

**用户 chat 自然语言**已能触发底层 tool（无 skill 中介）—— 用户输入 "截屏当前页"，agent 直接调 `capture_visible_tab` 出 confirm 卡，体验与 skill 路径等价。

## 现有 7 个 builtin skill 审计

| Skill ID | 判据 1：真组合 | 判据 2：用户语义入口 | 处置 |
|---|---|---|---|
| `extract_structured_data` | ✅ snapshot 读 + LLM 字段推理 + JSON/CSV 格式化 | ✅ "提取页面字段" | **保留** |
| `auto_group_tabs` | ✅ list_tabs → 主题分类推理 → 多次 group_tabs | ✅ "自动分组标签" | **保留** |
| `close_duplicate_tabs` | ✅ list_tabs → URL 归一化推理 + 去重选择 → close_tabs | ✅ "关闭重复标签" | **保留** |
| `close_inactive_tabs` | ✅ list_tabs → idle 阈值推理 + 跳过保护 → close_tabs | ✅ "关闭不活跃标签" | **保留** |
| `take_screenshot` | ❌ 单步包 capture_visible_tab，参数 `focus` 仅注入到 prompt 文案 | n/a（判据 1 已 fail，short-circuit） | **删除** |
| `open_url_in_tab` | ❌ 单步包 open_url，参数 `url`/`active` 1:1 透传 | n/a（判据 1 已 fail，short-circuit） | **删除** |
| `create_skill_from_recording` | ✅ trace 解析 + 参数化推理 + create_skill 调用 | ✅ "录制创建 skill"（由 RecordingMode "Finish" 流程触发） | **保留** |

## 实施动作

### Code

| # | 改动 | 文件 |
|---|---|---|
| C-1 | 删 `take_screenshot` skill entry（约 L148-186）| `src/lib/skills/builtin.ts` |
| C-2 | 删 `open_url_in_tab` skill entry（约 L187-227）| `src/lib/skills/builtin.ts` |
| C-3 | 启动 migration：`enabledIds` 数组 filter 掉 `take_screenshot` / `open_url_in_tab` / `!take_screenshot` / `!open_url_in_tab`，silent 写回 | `src/lib/skills/storage.ts` 或新增 `src/lib/skills/migration.ts` |
| C-4 | 启动 migration：清理 user-skill storage 中 id ∈ {take_screenshot, open_url_in_tab} 的条目（用户曾对 builtin 调过 saveSkill 的兜底）| 同 C-3 |

> Migration 触发点：side-panel 启动 / SW 启动时 lazy 跑一次（与 V1→V2 migration 同模式，silent + idempotent）。

### 测试

| # | 测试 | 类型 |
|---|---|---|
| T-1 | storage migration：模拟 stale `enabledIds = ["take_screenshot", "!open_url_in_tab", "auto_group_tabs"]` → migration 后剩 `["auto_group_tabs"]` | 单元 |
| T-2 | storage migration：模拟 stale user-skill 副本（saveSkill 写过 take_screenshot）→ migration 后 listUserSkills 不含它 | 单元 |
| T-3 | `BUILT_IN_SKILLS` 长度 = 5（保留 5 项）+ ID 集合断言 | 单元 |
| T-4 | （可选不做）build-time guard：检测 builtin.ts 里出现"参数 schema 1:1 透传给 1 个 tool"的薄壳模式 → throw | 静态 |

> T-4 punt：判定准则程序化难度大（怎么判 promptTemplate 是不是"仅 call X"？怎么判参数透传？）+ 误判风险高，靠规范文档 + code review 足够。

### 文档

| # | 改动 | 文件 |
|---|---|---|
| D-1 | 新建本规范 spec | `docs/specs/2026-05-08-skill-tool-convention-design.md` |
| D-2 | ROADMAP §13 P1 表追加 closeout note：删 2 个薄壳 + spec 链接 | `docs/ROADMAP.md` |
| D-3 | 历史 narrative 不改 | ROADMAP §5 #4 / §13 P3 P5 / `docs/solutions/2026-05-05-record-and-replay-v1-invariant-trace.md` 保留 ship 当时事实 |

落地后是否需要 `docs/solutions/` trace doc：**不需要**。改动很轻（删 ~80 行 + 1 storage migration），ROADMAP §13 P1 closeout note 足够追溯。

## 验收

- [ ] `pnpm test` 全过（含 T-1 / T-2 / T-3）
- [ ] `pnpm build` 全过（builtin.ts import-time assertion 仍守住保留 5 项）
- [ ] 启动后 `getAllSkills()` 返回 5 项 builtin（无 take_screenshot / open_url_in_tab）
- [ ] 用户在 chat 输入"截屏当前页"，agent 仍能直接调 `capture_visible_tab` 出 confirm 卡（无 skill 中介路径）
- [ ] Migration idempotent：第二次启动 storage 不再有清理动作

## 不在本 spec scope（明确 punt）

| 项 | 推到哪 |
|---|---|
| skill / tool 命名空间 prefix（`skill__` / description tag）| ROADMAP §13 P3 第 4 项 backlog；删完薄壳后再评估剩余命名摩擦 |
| 业务按钮语义风险识别（issue #44 §9）| ROADMAP §13 P2 第 2 项；独立 brainstorm |
| 任务级 / scope 级授权（issue #44 §5）| ROADMAP §13 P3 第 2 项；独立 brainstorm |
| 输入工具自适应编辑器（issue #44 §6）| ROADMAP §13 P4；punt（fail-fallback 已 honest signaling） |
| 高层意图工具合并（read_page / interact_with_page）| ROADMAP §13 P4；punt（违反"不预设抽象"原则）|
| 强制 description 中英文规范的 build-time check | 不做。当前所有 tool description 已英文、所有 skill description 已中文，固化事实即可，不引入静态校验 |

## 开放问题（plan 阶段确认）

- **Q1**：`saveSkill` 是否允许覆盖 builtIn skill？读 `storage.ts` 确认（影响 C-4 migration 是否有非空集需清）
- **Q2**：migration 触发点选 side-panel mount 还是 SW startup？两者跑一次都 OK（idempotent），但需统一一处避免双次写
- **Q3**：是否在 `BUILT_IN_SKILLS` import-time assertion 旁加一条断言"长度 == 5"作为本次审计的回归守卫？YAGNI 倾向 + 但成本极低，倾向加一条 `expectedIds = new Set([...])` 比较，新加 builtin 时不会无意中破规范
