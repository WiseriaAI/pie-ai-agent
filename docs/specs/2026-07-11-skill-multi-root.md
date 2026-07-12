# Skill 多根目录：`~/.agents/skills` 只读副根

- 日期：2026-07-11
- 状态：定稿（brainstorming 产出，用户已逐节确认）
- 前置：skill 体系 daemon 时代重设计（`docs/specs/2026-07-10-skill-system-with-local-daemon.md`，Slice 1–3 已全部合 main）

## 1. 背景与目标

daemon 连接且声明 `skill_fs` 时，磁盘是 skill 唯一真源，但目前只认单根 `~/.pie/skills`。业界正在收敛一个跨 agent 的通用 skill 目录约定 `~/.agents/skills`（Agent Skills 格式，与 Pie 磁盘 skill 同构）；用户放在那里的 skill，Pie 应当直接发现并复用——知识（SKILL.md + 引用文件）与脚本（`scripts/`）**全量复用**，不要求任何格式改造。

目标：daemon 在主根 `~/.pie/skills`（读写）之外挂载副根 `~/.agents/skills`（只读），合并成单一 skill 视图；扩展侧获得来源标识与一次性导入向导。安全模型（信封授权、srt 默认沙箱、audit）零改动。

## 2. 已拍板的决策

| 决策点 | 结论 |
|---|---|
| 真源结构 | 双根：`~/.pie/skills` 主写 + `~/.agents/skills` 只读（不迁移、不统一） |
| 副根位置 | `~/.agents/skills`（跨 agent 通用约定；**不是** `~/.claude/skills`） |
| 复用范围 | 全量（知识 + 脚本）。脚本执行机制已支持：`runnableScripts` = `scripts/` 目录文件列表，`interpreterFor` 已认 `.ts/.js/.mjs/.cjs`（bun）、`.py`（python3）、`.sh`（bash） |
| 默认启用 | 副根 skill 沿用「非内置默认关」语义；**首连导入向导**一次性多选启用 |
| 合并位置 | daemon skill-store 层（方案 A）；扩展侧只感知透传的 `source` 字段 |
| 同名冲突 | 主根遮蔽副根；被遮蔽版本不出现在列表，不做「N 个被遮蔽」提示（YAGNI） |
| 只读编辑 UX | v1 不做「复制到 Pie」按钮；copy-on-write 语义免费覆盖（见 §4） |

## 3. 架构总览

合并发生在 daemon 的 skill-store 层（离磁盘最近处），唯一新原语是 `resolveSkillRoot(name)`。wire 纯加法（PROTOCOL_VERSION 不动）。扩展侧只多一个透传字段和两块 UI（来源 badge + 首连向导）。信封授权、srt 沙箱、audit、IDB 回退（daemon-off）全部零改动。

```
~/.pie/skills   (主根，读写)  ─┐
                               ├─ daemon skill-store 合并（主根遮蔽同名）
~/.agents/skills (副根，只读) ─┘        │
                                listSkills → SkillSummary[] (+source)
                                resolveSkillRoot(name) → {root, source}
                                        │ wire（加法）
                        扩展 SkillSource 透传 → SkillsList badge / 首连向导
```

## 4. daemon 侧设计

### paths

`daemon/src/paths.ts` 新增 `agentsSkillsDir = join(homedir(), ".agents", "skills")`。Windows 期对应 `%USERPROFILE%\.agents\skills`，本期不做（挂 daemon Windows 适配 issue #268）。

### skill-store

- `listSkills()`：主根列表 + 副根列表，副根滤掉与主根同名的条目（主根遮蔽）；每条 `SkillSummary` 带 `source`（主根 `"pie"` / 副根 `"agents"`）。副根不存在 → 贡献空列表。
- 新增 `resolveSkillRoot(name): { root: string; source: "pie" | "agents" } | null`：主根优先查（`assertSkillName` 校验后查目录存在 + `SKILL.md` 存在），查不到落副根，都没有返回 null。`read_skill_file` / `run_skill_script` 统一经它定位 skill 目录。
- **写语义 = copy-on-write**：`writeSkill` 一律落主根（现有代码零改动）。对副根同名 skill 的写自然产生遮蔽副本，`~/.agents` 原文件永不被碰——这就是隐式的「复制到 Pie 编辑」。
- `deleteSkill`：只删主根副本（删掉遮蔽副本后副根版本重新露出——这是 CoW 的逆操作，行为自洽）。skill 只存在于副根 → 抛带 `code: "read_only"` 的错误，message 含该 skill 的磁盘路径（告诉用户文件真身在哪、要删去哪删）。
- `safeRelPath` 不动：skill 目录本身是 symlink → 跟随（根先 `realpathSync` 再限界），目录**内**文件是 symlink → 逐段拒。用户把别处 skill symlink 进 `~/.agents/skills` 的场景天然支持，逃逸面不变。

### skill-exec

定位 skill 目录改走 `resolveSkillRoot`；其余不动：grant 按 `name + envelopeHash` 记账（与来源根无关）、信封来自 SKILL.md 声明 + `scripts/` 列表、srt workspace = 该 skill 自己的目录、audit 照记。副根脚本首跑照弹信封授权卡。

副根 skill 执行时 `workspace/` 运行产物目录同样创建在该 skill 目录内（与主根一致）；这不修改任何既有文件，且 `workspace`/`.runs` 本就被 files 清单与可执行集排除。

### daemon.ts

`delete_skill` case 的错误映射补 `read_only`（与现有 `needs_authorization` 同模式：`code` 进错误信封）。

## 5. wire（全加法，PROTOCOL_VERSION=1 不动）

`src/types/local-bridge.ts`：

- `SkillSummary.source?: "pie" | "agents"`（optional）
- 错误码新增 `"read_only"`（`delete_skill` 对副根 skill）

兼容矩阵：旧 daemon 不给 `source` → 扩展当 `"pie"` 处理（无 badge）；旧扩展收到多余字段 → 忽略。任意新旧组合不炸。

## 6. 扩展侧设计

- `SkillSource` 透传 `source`；IDB 后端（daemon-off）永远 undefined（视同 `"pie"`）。
- SkillsList：`source === "agents"` 的行显示只读来源 badge，隐藏编辑/删除入口。daemon 拒写是权威，面板隐藏只是礼貌。
- **首连导入向导**：
  - 触发条件（四要素全满足）：桥 ready ∧ `skill_fs` capability ∧ 列表含 `source === "agents"` 条目 ∧ IDB config 无 `agents_import_prompted` 标记
  - 形态：skills 列表顶部一次性「发现 N 个本地 skill」卡 → 展开多选（默认全不勾 + 全选按钮）→ 确认把勾选项以 plain id 写入 `enabled_skills` 并落 `agents_import_prompted` 标记
  - **关闭卡同样落标记**（用户选择了「以后手动开」），之后新增的副根 skill 走列表手动开关
  - 纯面板本地状态，**不是** HITL panel-request（无 agent loop 挂起）
- `enabled_skills` marker 语义（plain id=开、`!id`=关）零改动；**默认规则改一条**：daemon 模式的启用过滤在 `src/lib/skills/source.ts` 的 `filterEnabled`（非 `index.ts`——那是 IDB 路径），现行「磁盘 skill 默认开」收窄为仅主根（`source !== "agents"`）；副根 skill 无 marker 时默认关。
- i18n：六字典（en / zh-CN / zh-TW / ja / es-419 / pt-BR）补 key——badge 文案、向导标题/正文/按钮（确认/全选/关闭）、`read_only` 错误文案。键 parity 由 typecheck 强制。

## 7. 错误处理与边界

- 副根不存在 → 空列表（`existsSync` 守卫已有模式）
- 副根坏 SKILL.md → 跳过该 skill、不炸整个 list（现有韧性逻辑覆盖）
- 目录名不合 `NAME_RE`（`^[a-z0-9][a-z0-9-]*$`，大写/下划线不合）→ 跳过（现有行为，此处明示）
- `FILES_CAP = 200` 逐 skill 生效，副根大 skill 不拖垮 list
- symlink：目录级跟随、文件级拒（见 §4）

## 8. 测试要求

- daemon（bun test）：两根合并；同名遮蔽；`resolveSkillRoot` 主根优先/落副根/双无 null；副根删除抛 `read_only`（message 含路径）；CoW 写落主根且副根文件不变；删遮蔽副本后副根版本重新露出；副根缺失/坏 SKILL.md 韧性
- 扩展（vitest）：`source` 透传；badge 渲染；agents 行无编辑/删除入口；向导触发条件四要素（缺一不弹）；确认写 `enabled_skills` + 落标记；关闭落标记后不再弹
- 跨层：旧 daemon 无 `source` 字段时扩展按 `"pie"` 处理不炸（wire 加法演进断言）

## 9. 明确不做（YAGNI）

- 不做可配置根列表（硬编码一个副根；将来真有第三根再加）
- 不做 `~/.claude/skills` 扫描（用户可自行 symlink 进 `~/.agents/skills`）
- 不做「复制到 Pie 编辑」按钮（CoW 语义已覆盖）
- 不做「N 个被遮蔽」提示
- 不做副根文件监听 / 自动刷新（`listSkills` 每次现读，无缓存可失效）
- 不动 IDB 回退路径（daemon-off 时副根概念不存在）

## 10. 验收标准

1. `~/.agents/skills` 下的合法 skill 出现在 Pie skills 列表，带来源 badge，默认禁用
2. 首连（四要素满足）弹导入向导；勾选确认后所选 skill 启用、进 system-prompt 目录；关闭后不再弹
3. 副根 skill 的 SKILL.md / 引用文件经 `read_skill_file` 可读；`scripts/` 脚本经授权卡批准后可跑（py/sh/ts 各验一）
4. `~/.pie/skills` 放同名 skill 后遮蔽副根版本；删除遮蔽副本后副根版本重新露出
5. 对副根 skill 的删除报 `read_only` 错误且 message 含磁盘路径；`~/.agents` 下文件在任何操作后字节不变
6. daemon-off（IDB 模式）行为与现状完全一致
7. `pnpm test` / `pnpm typecheck` / `pnpm build` + daemon `bun test` 全绿
