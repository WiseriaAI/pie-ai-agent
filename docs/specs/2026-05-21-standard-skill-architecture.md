# 标准 SKILL 架构 — Design

**Status**: Draft · 待用户确认
**Date**: 2026-05-21
**Scope**: `src/lib/skills/**`、`src/lib/agent/tools.ts`、`src/lib/agent/loop.ts`、`src/lib/agent/prompt.ts`、新增 sandbox/offscreen 运行时;CLAUDE.md skill 相关描述

## Goal

把现状「skill 实际上是一个返回 prompt 的 tool」(`resolveSkillToTools`) 演进为对齐 Anthropic Agent Skills 的**标准 SKILL 设计**:skill 成为**渐进披露的知识包**(多文件知识 + 可选纯计算脚本),与 tool(能力)彻底分层,不再共用同一个扁平工具命名空间。

核心诉求(用户原话):"需要捆绑脚本和多文件知识,就是标准的 SKILL 设计,而不是现在这种把 tool 和 skill 混为一谈的设计。"

## Non-Goals

- **不引入 Python / Pyodide**(SP-2 沙箱只跑 JS 纯函数;WASM 重计算明确排除)。
- **不在本版做网络能力(SP-3)**:`http_request` / 外部 API 访问标记为后续,本设计只预留 frontmatter `capabilities.hosts` 字段位,不实现执行路径。
- **不做确定性 recipe / 工作流引擎(SP-4)**:多步页面编排继续走 LLM 驱动(agent 读 skill 知识后用内置 tool 一步步做),在其被证明不够前不建引擎。
- **不让 skill 脚本直接操作页面 DOM 或调 `chrome.*`**:页面动作的唯一通道永远是内置 tool。
- **不保留 skill 的 typed parameters**(见下「关键决策 2」)。

## 关键约束(MV3 物理边界)

Anthropic 标准 Skills 的「捆绑脚本能跑」依赖一个代码执行容器(跑 Python)。MV3 Chrome 扩展没有该容器,因此:

1. 扩展上下文禁 `eval` / `new Function`(CSP),禁远程代码。skill 存的 JS 字符串不能在 SW / 普通扩展页直接执行。
2. 唯一能合法 `eval` 任意 JS 的地方是 manifest `sandbox` 声明的 iframe——但它 opaque origin、**碰不到页面 DOM、碰不到 `chrome.*`、用不了 host_permissions 绕 CORS**。
3. 没有真文件系统;多文件只能做成虚拟文件树存 IndexedDB。

**推论**:本架构里 skill 脚本只能是「纯计算」`(input) => output`,不是「手」。三者分工:

```
Tool   = 手(能力)        扩展自带、可信、有副作用。基本不变。
Skill  = 手册 + 算盘(专长) 安装为数据:知识(多文件)+ 纯计算脚本 + 能力声明。渐进披露。
Loop   = 编排者            读 skill、驱动 tool。
```

## 关键决策

### 决策 1:skill 退出 tool 命名空间(方案 A,已确认)

现状 `allTools = [...BUILT_IN_TOOLS, ...skillTools, ...keyboardTools]` —— skill 和 tool 平铺混同。

新模型:

```
allTools = [...BUILT_IN_TOOLS, use_skill, read_skill_file, run_skill_script, ...keyboardTools]
```

skill **从工具表里消失**,变成「中介工具背后的数据」。模型看到的工具表里只有「动作」(tool)和「查手册 / 跑脚本」(固定中介工具)。`resolveSkillToTools` 删除。这是字面意义上化解「tool/skill 混同」的关键。

### 决策 2:去掉 typed parameters(已确认)

现状 skill 有 `toolSchema.parameters`(JSON Schema)+ `promptTemplate` 的 `{{key}}` 模板注入。新模型**取消两者**:

- `use_skill(skillId)` 无业务入参,只加载 SKILL.md 正文。
- skill 需要的输入由 agent 从上下文(用户请求 + 对话 + 页面 snapshot)自行推断并通过后续 tool 调用填入。
- SKILL.md 正文用散文说明「需要哪些信息、如何获取」;frontmatter 可选 `inputs:` 文档字段(仅文档、不强制、不模板化)。

**理由(用户)**:去参数化后自由度更高,LLM 自行决定的空间更大;且这正是 Anthropic 标准 Skills 的做法(无 typed args)。

**取舍**:丢失 ① schema 强校验 ② `{{}}` 动态模板 ③ 一次性调用契约 ④ UI 自动表单。但这些参数本就是 LLM 从上下文现填的,schema 只是把「现填」结构化成检查点;删掉的是检查点不是信息。唯一会疼的场景:skill 必须拿严格结构化 payload 才能起步——此时结构改写进正文散文,靠模型遵守,无硬保险。评估为可接受。

### 决策 3:存储迁到 IndexedDB(已确认)

多文件 + 脚本字节不适合 `chrome.storage.local`(K/V、10MB)。skill 包存 IndexedDB;`enabled_skills` 索引仍留 `chrome.storage`。

## 组件架构

### SP-0 — 包格式 & 存储(地基)

虚拟文件树:

```
<skill-id>/
  SKILL.md          # frontmatter + 指令正文
  references/*.md   # 附加知识,按需加载
  scripts/*.js      # 纯计算脚本(SP-2)
```

frontmatter:

```yaml
name: Extract Structured Data
description: <何时用——触发判定就靠它>
version: 1.0.0
author: user | agent
inputs:                              # 可选,纯文档,不强制
  - fields:  哪些字段要抽取(从用户请求推断)
  - format:  json 或 csv,默认 json
capabilities:
  tools:   [get_tab_content, click]  # 它编排哪些内置 tool(文档 + 未来门禁用)
  scripts: [parse.js]                # 它带的纯计算脚本
  hosts:   ["api.example.com"]        # 它要访问的外部 host(SP-3,本版仅占位)
```

存储记录(IndexedDB)概念形状:`SkillPackage { id, frontmatter, files: Map<path, content>, author, createdAt }`。

### SP-1 — 多文件知识 + 渐进披露(第一个交付块,零代码执行)

三档披露,对齐 Anthropic:

```
① 永远在 context:  每个启用 skill 的 name+description → 注入 system prompt 当 catalog(便宜)
                    —— 不是 tool,只是清单
② 触发时加载:      use_skill(skillId) → 返回 SKILL.md 正文当 observation(包 <untrusted_*>)
                    —— "翻开手册"
③ 按需加载:        read_skill_file(skillId, path) → 返回某 reference 文件(包 <untrusted_*>)
                    —— "翻到附录某页"
```

迁移:现状 `promptTemplate` → `SKILL.md` 正文;`toolSchema.parameters` 取消。`prompt.ts` 新增 catalog 注入。

### SP-2 — 沙箱计算运行时

```
SW ──创建──> Offscreen Document ──内嵌──> sandboxed iframe(manifest sandbox 声明,松 CSP)
   <───────────────── postMessage RPC ─────────────────>

新工具 run_skill_script(skillId, path, input):
  SW → offscreen → sandbox: eval 脚本为 (input)=>output → 回传
  纯函数:无 DOM、无 chrome.*、无带 host 权限的 fetch
  护栏:执行超时(~5s)+ 输出大小上限
```

为何 Offscreen Document:SW 无 DOM 挂不了 iframe;Offscreen 是 MV3 官方「后台要 DOM」的机制。

### SP-3 — 网络能力(本版仅占位,不实现)

后续设计 `http_request`,由 SW 代发,门禁三连:host ∈ 当前 active skill 的 `capabilities.hosts` ∧ ∈ manifest host_permissions ∧ 首次新 host 用户确认。最高风险(SSRF / 外泄),`author:'agent'` skill 尤危,单独评审。

### SP-4 — 确定性 recipe 引擎(暂不做)

声明式 `[{tool,args}]` 序列由 SW 直跑、无 LLM round-trip。完整工作流引擎(分支 / 错误处理 / 步间传值)。在 LLM 驱动编排被证明不够前不建。

## 安全与信任

- 所有进 LLM 的 skill 内容(SKILL.md 正文、reference 文件、脚本输出)继续包 `<untrusted_*>` wrapper。
- 沙箱隔离兜住脚本危害(出不去);host 白名单 + 确认(SP-3)兜住网络。
- **分级授权**:`author:'agent'` 的 skill 可自由创建知识类;带 `scripts` / `hosts` 的需用户首次评审。

## 对现有代码 / Invariant 的冲击

- 删 `resolveSkillToTools`(`src/lib/skills/index.ts`)。
- `SkillDefinition`(promptTemplate + toolSchema)→ `SkillPackage`(文件树);`storage.ts` 从 chrome.storage 迁 IndexedDB。
- `BUILT_IN_TOOLS` 新增 `use_skill` / `read_skill_file` / `run_skill_script`。
- R3 anti-nest 语义变化:skill 不再在工具表里,「嵌套 skill 调用」的定义改为「`use_skill` 是否允许在已 use_skill 的 scope 内再次调用」。
- `prompt.ts` 新增 skill catalog 注入。
- 新增 manifest `sandbox` 声明 + Offscreen Document(SP-2)。
- CLAUDE.md 多处 skill 描述更新;**顺带修正已过时的 risk classifier 段**(confirm/risk 层已移除,见 `src/__tests__/cross-layer/no-confirm-*.test.ts`)。

## 建造顺序

1. **SP-0 + SP-1**(包格式 + 多文件知识 + 渐进披露 + 迁移现状 skill)—— 地基,零新执行权限,直接兑现「不混同」。
2. **SP-2**(沙箱计算)。
3. SP-3(网络)—— 后续、单独评审。
4. SP-4(recipe 引擎)—— 大概率不做。

每个子项目各自走 spec → plan → 实现。本文档是跨子项目的总体架构;落地时 SP-0+SP-1 先拆出独立实施 plan。

## Open Questions

- IndexedDB schema 版本管理 / 与现有 `chrome.storage` skill 数据的迁移脚本细节(SP-0 实施时定)。
- `use_skill` scope 生命周期:一个任务内能 use 几个 skill?是否允许中途切换?(沿用 / 改造现有 skill scope 状态机)
- skill 包的分发 / 安装格式(zip 导入?URL fetch?粘贴?)—— 本版假定沿用现有「SkillsList 手动创建 + meta tools agent 创建」,导入格式后续再议。
