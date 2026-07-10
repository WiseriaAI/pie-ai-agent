# Skill 体系（有本地 daemon 之后）— Design

> Brainstorming 产出。定义 daemon 启用后 Pie 的 skill 体系形态：磁盘为真源、对齐 Anthropic Agent Skills、用 Anthropic sandbox-runtime 做默认沙箱。落地按本 spec 拆 plan。

## Goal

daemon 启用并连接时，skill 以**本地文件系统为唯一真源**（`~/.pie/skills/<name>/`），能力与规范**完全对齐业界事实标准（Anthropic Agent Skills）与本地 Agent（Claude Code）**：skill 可捆绑脚本、以你本人权限在本机运行、经默认沙箱兜底 + 声明升级授权。daemon 未启用时，维持现状 IDB 存储 + MV3 sandbox 纯计算路径不变。

## Non-Goals（v1）

- 不做多根 skill 目录扫描（架构支持根列表，v1 只 `~/.pie/skills`；`~/.claude/skills` / 项目 `.claude/skills` 后续加一条根 + 开关）。
- 不做 syscall 级「跑到一半逐操作弹窗」——macOS OS 沙箱是加载时定策略，做不到；采「声明在前 + 授权卡逐项 + 沙箱强制」。
- 不做读-外泄的细致威胁建模（v1 靠 `denyRead` 默认清单 + 默认断网压制，细化留 follow-up）。
- 不自研沙箱（用 Anthropic sandbox-runtime）。
- 不动 daemon-关 的 IDB / MV3-sandbox 路径（2a 已交付，作纯 BYOK 回退）。

## Background / 问题

当前 skill 存 IndexedDB（`pie-skills` 库）。Slice 2b（PR #263，未合并）把 daemon 当哑执行器——扩展从 IDB 取脚本内容、随 wire 传给 daemon、写临时文件、`sandbox-exec` 跑。真机测试暴露**双真源 bug**：改本地文件不生效，运行时永远读 IDB 那份；且 authoring UI 塞不进 `scripts/*.js`。根因是「有了 daemon 的文件系统后，skill 真源在哪」这个决定从没拍板。本设计拍板：**daemon 在 → 磁盘为真源**。

## 已定决策

1. **真源双模式**：`isBridgeReady() && daemon 声明 skill_fs 能力` → 磁盘模式；否则 IDB 模式（现状不变）。
2. **磁盘 skill 格式对齐 Anthropic Agent Skills**：`SKILL.md`（标准 frontmatter）+ 附带文件；目录名 = id = `name`。
3. **执行完整能力**：脚本以用户本人权限跑（任意 fs / 网络 / 子进程），**不是纯计算**。
4. **默认沙箱 + 声明升级**：用 Anthropic sandbox-runtime（srt）兜底——默认写限工作区、默认断网、读默认开但拒敏感；skill 声明的网络/写路径经授权卡逐项批准后由 srt 强制放行。
5. **grant per-skill**：授权卡枚举该 skill 会跑的脚本 + 声明的高危能力；grant 按「能力信封」记，daemon 独占账本，可撤、审计。
6. **builtin 留扩展侧只读**；用户 IDB skill 首次进磁盘模式一次性迁盘。

## 架构

### 4.1 两种模式

| | 磁盘模式（daemon 开 + skill_fs） | IDB 模式（daemon 关/未装） |
|---|---|---|
| 真源 | `~/.pie/skills/<name>/`（daemon 拥有） | IndexedDB `pie-skills`（现状） |
| catalog / 正文 / 文件 / 执行 | 全走桥问 daemon | 扩展本地（现状） |
| 脚本执行 | daemon 经 srt 跑，完整能力 | MV3 sandbox 纯计算（2a） |
| builtin | 扩展侧只读，catalog 合并 | 扩展侧只读，catalog 合并 |

判定：`isBridgeReady() && bridgeCapabilities().includes("skill_fs")`。切换只影响 skill 层，其余不变；纯 BYOK 用户零感知。

### 4.2 磁盘 skill 格式（对齐 Anthropic Agent Skills）

- **目录 = 身份**：`~/.pie/skills/<name>/`，目录名即 id 即 `frontmatter.name`（kebab-case）。统一今天 IDB 里 `id` 与 `name` 两分。
- **SKILL.md frontmatter**（标准字段）：必填 `name`/`description`；可选 `license`/`allowed-tools`/`metadata`。正文 = markdown 指令（现状沿用）。
- **Pie 现字段映射**：`capabilities.tools`→`allowed-tools`；`capabilities.scripts`（2a/2b 的 fs/network 对象声明）→**删**；`capabilities.hosts`→**删**；`author`→`metadata.author`；`inputs`→并进正文。
- **可执行脚本集走约定**：`scripts/` 下的文件 = 可执行集（`run_skill_script` 的 allowlist + 授权卡枚举源）。不引入 Pie-only 必填字段——标准 skill 有 `scripts/` 就能跑。`references/`/`assets/` 按约定当只读资料（`read_skill_file` 取），不进可执行集。
- **升级能力声明**（Pie 扩展，放 `metadata.pie` 保持标准可解析）：
  ```yaml
  metadata:
    pie:
      network: [api.example.com]     # 允许出口域名
      write: [~/Documents/pie-out]   # 工作区外额外写路径
  ```
- **builtin**：保持扩展内代码常量表示，catalog 合并时按 `{name, description}` 同形呈现；builtin 是指令/纯计算，不落盘、不上 daemon。
- IDB 模式的 frontmatter 解析器保持现状（向后兼容），只有磁盘模式吃对齐后的规范。

### 4.3 执行 + 沙箱（srt）

**沙箱 = Anthropic sandbox-runtime**（`@anthropic-ai/sandbox-runtime`，Apache-2.0）。macOS `sandbox-exec` + 代理式网络过滤；Linux bubblewrap；无容器。经 Bun `import { SandboxManager }` 嵌进 pie 二进制。

**执行原语**：`run_skill_script(skillId, entry, args?)`
- `entry` 必须 ∈ 该 skill `scripts/` 集，否则拒（daemon 只跑自己磁盘上的文件，LLM 传不了内容）。
- cwd = skill 目录（脚本相对路径读自己的 bundled 文件）。解释器优先 shebang，退按扩展名映射，用用户本机装的解释器。
- `args` = CLI 风格参数；stdout 收回当结果，包 `<untrusted_skill_content>`。

**基线 srt settings（每个 skill 默认）**：
- 写：只准 skill 目录下的 `workspace/` 子目录（`allowWrite: <skilldir>/workspace/`）；skill 的 `SKILL.md`/`scripts/`/`references/` 保持不可写（运行脚本改不了自己代码，也防绕过 grant 自我改写）。
- 网络：`allowedDomains: []`，默认全断。
- 读：默认开 + `denyRead` 敏感目录（`~/.ssh`/`~/.aws`/`~/.pie/grants.json` 等）+ srt 自带 dotfile 保护。

**升级**：skill `metadata.pie.network`/`write` → daemon 并进 srt `settings.json` → 授权卡逐项列出 → 批准后 srt 强制。

**资源护栏**（非安全边界）：超时（防跑飞）+ 输出上限（防撑爆内存）。

### 4.4 grant 模型

- **per-skill**：首次跑某 ungranted skill 任一脚本 → daemon 回 `needs_authorization`（带 runnableScripts + declaredCaps）→ 授权卡展示 skill 名/描述 + **可执行脚本清单** + **声明的高危能力（联网域名/额外写）** + 「以你的完整权限在本机运行」诚实披露 → 批准 → daemon 写 grant + srt 跑；之后该 skill 免卡。
- **grant 身份 = skill 名 + 能力信封**（allowedDomains + 额外写路径 + 可执行脚本集），**不哈希脚本字节**。
- **重弹规则**：信封变（加域名/加写路径/脚本增删）才重弹；信封内改代码不重弹——containment 是沙箱的活，沙箱兜着（没声明就断网、写限工作区）。既顺手（调试随便改）又无洞。取代 2b 的 permsHash-含-脚本内容。
- daemon 独占 `~/.pie/grants.json`（原子写，扩展零 grant 存储）；设置页列出/撤销；每次执行写 `~/.pie/logs/audit.jsonl`（skill/entry/args/exit/耗时）。这三样是 2b 脊柱复用。
- **残余风险**（诚实）：信封内改的代码仍能读非拒绝清单的文件并带回对话上下文，配合另一个有网络的 granted skill 理论上可外泄；靠 `denyRead` 默认清单 + 默认断网压大头，细化留 follow-up。

### 4.5 桥协议 + 扩展 skill 层重构

**新桥方法**（全加法，PROTOCOL_VERSION 仍 1；新增 capability `skill_fs`）：
- `list_skills` → `[{name, description, runnableScripts[], declaredCaps:{network,write}}]`
- `read_skill_file(name, path)` → 文件内容（SKILL.md 正文 / reference）
- `run_skill_script(name, entry, args)` → §4.3/4.4 流程，返回 stdout
- `write_skill(name, files)` / `delete_skill(name)` → authoring / 迁移落盘
- `list_grants` / `revoke_grant` → 2b 复用（现 per-skill）

**扩展 `SkillSource` 抽象**（`list()`/`readFile()`/`runScript()`/`write()`/`delete()`）：
- `IdbSkillSource`（现状）+ `DaemonSkillSource`（桥客户端）；resolver 按 skill_fs 能力选。
- **builtin 只读层永远并入**。
- `resolveSkillPackage`/`getEnabledSkillPackages`/catalog 构建/`use_skill`/`read_skill_file`/`run_skill_script` 全走 active source，上层不感知磁盘还是 IDB。

**职责切分**：
- **enabled = 扩展侧 UI pref**（`enabled_skills` 仍 IDB，按 skill 名，两模式通用）；catalog 只呈现 enabled，disabled 的 LLM 看不到、调不了 + tool handler 兜一层。
- **grant = daemon 侧**（`~/.pie/grants.json`）。二者不耦合。

**authoring 两模式自然通**：`create_skill`/`update_skill`/录制→skill 经同一 `SkillSource.write()`——磁盘模式落盘、IDB 模式写 IDB。

### 4.6 迁移

首次进磁盘模式时，扩展读 IDB 里 `builtIn=false` 的用户 skill，逐个 `write_skill` 落 `~/.pie/skills/<name>/`（SKILL.md + files 铺开）。幂等：磁盘已有同名目录则跳过、不覆盖，记一条提示。迁移后磁盘为真源；IDB 那份留作 daemon-关 回退，不再于磁盘模式读。

## 安全模型

- **威胁**：Pie agent 被网页内容（untrusted）驱动，prompt injection 是一等威胁——比 Claude Code 的注入面大，故默认沙箱比「完整能力不设防」更合适（对标 Codex / 新版 Claude Code 的沙箱-默认姿态）。
- **默认收紧**：默认断网（杀 exfil 大头）+ 写限工作区（杀持久化/破坏）+ 拒敏感读。
- **升级显式**：高危能力必须 skill 声明 + 用户授权卡逐项批 + srt 强制；write 类本地动作无静默路径，卡片展示原文不经 LLM 转述。
- **daemon 侧防线**：grant 账本 daemon 独占强制；`entry` 必 ∈ scripts 集（LLM 不能注入代码）；socket 0600；native host `allowed_origins` 锁扩展 ID。
- **srt 说明**：research preview（API/配置可能变）——Apache-2.0 可 vendor 锁版本 + 用 Pie 自己的接口包一层挡变动；它是 Claude Code 生产在用的成熟机制。

## 2a / 2b 处置

- **2a（PR #262，已合并）不动**：MV3 sandbox / script-decl = daemon-关 纯计算回退，继续服务纯 BYOK 用户。
- **2b（PR #263，未合并）**：执行模型（IDB→wire→sandbox-exec）被替换 → **关闭 #263**；grant 账本 / 授权卡 / audit 脊柱捞出重构进新实现（per-skill + srt）。

## 实现期 spike（plan 第一步，非设计 TBD）

1. **srt 嵌 Bun daemon**：`import { SandboxManager }` 编进 pie 二进制 + 搞定 `ripgrep` 依赖（捆绑/探测），端到端验证「srt 跑脚本、默认断网、写限工作区、声明域名放行生效、敏感读被拒」。跟当初 spike `BUN_BE_BUN`/`sandbox-exec` 同性质。
2. srt 库 API 在 MV3 无关的 daemon 上下文的稳定性 + 配置格式锁版本。

## 测试

- unit：SkillSource 双实现 + catalog 合并（builtin+磁盘/IDB）+ 迁移幂等 + grant 信封重弹判定 + frontmatter 对齐解析。
- 真机：srt 强制层（断网/写限/升级放行/敏感读拒）——CI 用 fake 碰不到 OS 强制，必真机；两模式切换；迁移；授权卡逐项 + 撤销。

## Follow-up

- 多根（`~/.claude/skills`、项目 `.claude/skills`）+ 开关。
- per-domain 更细的网络策略 / TLS 检查取舍。
- 读-外泄细致威胁建模。
- 「信任此 skill 目录（跳过内容复核）」dev 开关（若信封级重弹仍不够顺手）。
- Windows / Linux（srt 已跨平台，跟 daemon 跨平台一起做）。
