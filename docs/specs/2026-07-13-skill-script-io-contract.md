# Skill 脚本 I/O 契约收口

> 2026-07-13 · 起于 issue #296（grill 会话产出）
> 状态：定稿，待实现（PR1 + PR2）

## 1. 起点：一个 bug，牵出三个

#296 的报告是：用户写了一个磁盘 skill 脚本，按旧的 MV3 sandbox 约定写成 `export default (input) => {...}`。Bun 直接执行它——只定义一个导出，然后退出。**4 次运行全部 exitCode 0、stdout 为空、无落盘**，LLM 收到一个空的 `<untrusted_skill_content></untrusted_skill_content>`，用户看到"没有返回任何内容"，无从分辨是脚本问题还是工具问题。

顺着这个 bug 往下查，发现它不是一个孤立的文案错误，而是三个问题叠在同一处：

### 1.1 工具描述在教一套已经不存在的约定

`skill-script.ts` 的 tool description 对 LLM 说 "Pass `input` as the JSON argument… the script's return value comes back as JSON"、`input` 字段写着 "passed to the script's **default export**"。这是 Slice 2a 的 MV3 offscreen sandbox 约定。磁盘 skill 走 daemon 是**完全相反**的 CLI 语义：`args` → `process.argv`，stdout 是唯一出口。

更糟的是，**这套旧约定服务的代码路径已经无法被抵达**：

- `builtin.ts` 生成的 frontmatter 里 `capabilities.scripts` 声明数为 **0**（历史上那 6 个已在 scratchpad 那轮当死配置清掉）。
- idb 的每一个写入口——`create_skill`、`update_skill`、panel 的 `SkillsList`——写的都只有 `SKILL.md`。**没有任何路径能往 idb skill 里塞一个 `.js` 文件。**
- `bridgeHasSkillFs()` 为假时 source 直接换成 `idbSkillSource`，磁盘 skill 整个从列表消失——不是"在但脚本跑不了"。

所以 daemon-off 时能被看见的 skill（builtin + idb）一个脚本都不可能有。**MV3 skill sandbox 不是"回退路径"，它是无法抵达的代码**，而它的约定还在 tool description 里教坏 LLM 和 skill 作者。

### 1.2 副根污染（新发现的真 bug）

`skill-exec.ts` 里：

```ts
const skillDir = join(located.root, name);
const workspace = join(skillDir, "workspace");
mkdirSync(workspace, { recursive: true });
```

`located.root` 可能是**只读副根 `~/.agents/skills`**（跨 agent 通用目录）。skill-store 那层对副根有保护（删除报 `read_only`、写走 CoW 落主根），但**这个 `mkdirSync` 绕过了那层保护**。

即：跑一个 `~/.agents/skills/foo` 的脚本，会在别的 agent（Claude Code 等）的 skill 目录里创建 `workspace/` 并往里落文件。跨 agent 污染。

### 1.3 产物的隔离维度错了

产物按 **skill** 隔离（`<skillDir>/workspace/`），不按 **session**。两个 session 同时跑同一个 skill 的脚本，写的是同一个 `workspace/out.csv`——互相覆盖。

而 session 是 Pie 里所有东西的隔离单元：per-session port、pinnedTabs、CDP `ownerToken`、R7 跨 session 锁、scratchpad。产物没有理由是例外。

### 1.4 附带发现：产物读得回来，但没人知道

`readSkillFile(name, rel)` = `readFileSync(safeRelPath(dir, rel))`——只防路径穿越，**不排除 workspace**。排除只发生在 `packageFiles()` 这个**列表**函数里（`EXCLUDED_DIRS`）。

所以 `read_skill_file(skillId, "workspace/out.csv")` **今天就能读回来**。缺的从来不是通道，是**清单**：LLM 不知道 workspace 里有什么文件，只能靠脚本自己 print 文件名，或者猜。

（这条在本 spec 的方案里会被改掉——workspace 搬出 skill 目录后，这个通道会失效，需要新开一个。见 §3.3。）

---

## 2. 设计决策

以下每条都在 grill 会话里过过，含被否掉的选项与理由。

### D1 · MV3 skill sandbox 整套删掉

删 `src/offscreen/skill-sandbox.{html,ts}`、`sandbox-host.ts` 及测试、`pdf-parser.ts` 里的 `initSandboxHost()` 调用、`loop.ts` 的 `runInSandbox` 注入、`skill-script.ts` 的 builtin/idb 分支、manifest 的 `sandbox.pages` 段与 CSP 里那条带 `'unsafe-eval'` 的 sandbox 行。

**理由：** §1.1 已证明它没有可达输入。留着它不是保留了一个能力，是保留了一个**幻觉能力**——`source.ts` 会因为读 frontmatter 而把一个 LLM 自己写进 SKILL.md 的 `capabilities.scripts` 条目播报成"可跑脚本"，然后 run 到一半发现文件不存在。附带收益：摘掉一条 `'unsafe-eval'` CSP，攻击面收缩 + 商店审核少一项要解释的东西。

**否掉的选项：** 留着它，等未来支持 daemon-off 下带脚本的 skill（比如 zip 导入 skill 包到 idb）。否掉是因为这与"磁盘是唯一真源"的既定方向相反——留着等于给一个已被取代的架构交房租。

### D2 · `capabilities` frontmatter 字段一并删掉

删 `SkillFrontmatter.capabilities` 类型、`script-decl.ts` 整个文件、`frontmatter.ts` 里的 `capabilities` 嵌套特判。

**理由：** 删掉 D1 之后，`capabilities.scripts` 的消费者归零；`tools` / `hosts` 本来就零消费者（注释里早写明"仅解析不消费"）。**更重要的是：#296 这个 bug 的成因就是"留着一个没人消费但看起来有用的旧约定"。** tool description 教错了 LLM，`capabilities.scripts` 教错了 skill 作者——同一个病。只删症状不删病灶，下一个读 `package-types.ts` 的人（或 LLM）看到 `scripts?: string[]` 加一句"脚本声明"的注释，还是会以为这是活的。

**注意：** daemon 侧的 frontmatter schema 是**另一套**（`metadata.pie.network` / `metadata.pie.write`），不受影响，也不打算对齐——daemon 是真源，扩展不需要解析磁盘 skill 的 frontmatter（`use_skill` 只 `stripFrontmatter` 取正文）。

**兼容：** 老 idb 包 SKILL.md 里残留的 `capabilities:` 会被宽容解析器当成无害的垃圾字段，不影响 `name` / `description` / 正文。这一条要有测试保证。

### D3 · workspace 迁到 session 维度，扁平共享

```
~/.pie/sessions/<sessionId>/workspace/
```

**理由：** 解 §1.2（不再往 skill 目录、尤其是只读副根里写东西）和 §1.3（隔离维度对齐 session）。

**扁平 vs 按 skill 再分一层：选扁平。** agent 最自然的工作流是管道——skill A 的脚本抽出 `raw.csv`，skill B 的脚本读它清洗成 `clean.csv`。分层的话沙箱的 `allowWrite` 只给自己那格，这道墙会变成**硬墙**，跨 skill 数据流被物理阻断。隔离边界本来就该是 session：同一 session 里的 skill 共享页面、tab、scratchpad，产物凭什么互相看不见。同名覆盖的风险存在，但那属于脚本作者自己的事，不值得用一堵挡住正当用法的墙去换。

### D4 · cwd 改成 session workspace（breaking，但现在免费）

`sandbox.run(argv, cwd, ...)` 的 cwd 从 `skillDir` 改为 `sessions/<sid>/workspace/`。同时注入两个环境变量：

- `PIE_SKILL_DIR` — skill 根目录绝对路径（脚本读自己的资源用）
- `PIE_WORKSPACE` — 等于 cwd，纯为可读性

**理由：** workspace 一旦搬出 skill 目录，相对路径 `workspace/out.csv` 就写不出去了，cwd 必须跟着动。而且现在的组合本身就是坑——**cwd = skillDir，但 skillDir 不可写**（`allowWrite` 只有 workspace），脚本写 `writeFileSync("out.csv")` 会被沙箱静默拒绝，正是 #296 那类"看起来成功、其实什么都没发生"的下一个变种。改完之后 cwd 就是可写区，坑消失。cwd 应该是"你干活的地方"，不是"你住的地方"。

**`SandboxSettings` 只有 `denyRead` 黑名单、没有 allowRead 白名单**，所以 skill 目录改 cwd 后依然可读，`PIE_SKILL_DIR` + 绝对路径即可。

**否掉的选项：** cwd 留在 skillDir，workspace 路径靠 env 注入。否掉是因为"写不进 cwd"这件反直觉的事会继续存在，作者还是会踩。

**不做兼容层。** daemon **从未随扩展发布过**（`release.yml` 不打包它，release notes 零字提及，唯一入口是 `daemon/install` 手工装，制品化 #267 还开着）。真实用户实质为零，而这是**最后一个免费改的窗口**——daemon 一旦制品化发出去，cwd 契约就冻结了。老脚本里 `writeFileSync("workspace/out.csv")` 在新 cwd 下不会挂，只是多套一层目录、产物照样能被列出读回；真正会挂的是相对路径**读** skill 内资源，那种脚本改一行 `PIE_SKILL_DIR` 就行。为零个真实用户写兼容层是纯负债。

### D5 · daemon 返回本次产物清单

`RunSkillScriptResult` 加两个 optional 字段（加法演进，`PROTOCOL_VERSION` 不动）：

```ts
outputs?: { path: string; bytes: number }[];
outputsTruncated?: boolean;
```

- **范围：本次变更，不是全量。** run 前记 `startedAt`（`skill-exec.ts` 已有这个变量），run 后递归扫 workspace，只列 `mtimeMs >= startedAt` 的文件。workspace 会累积——第 10 次运行如果返回 50 个历史文件，本次真正的产物就淹没在噪音里，LLM 反而更容易读错文件。边界情况（某历史文件 mtime 恰好等于 startedAt）概率极低且无害，最多多列一个。
- **`path` 相对 session workspace 根**（`out.csv`，不是绝对路径），LLM 能原样喂给 `read_skill_output`，少一个出错点。
- **`bytes`** 让 LLM 判断值不值得读、会不会撑爆上下文。不带 mtime（用不上），不带内容（那是读工具的活，别在这里越界读一个 200 MB 的文件）。
- **封顶 50 个文件**，超了截断并标记。脚本生成上千个分片文件不是幻想（切分、逐页导出），没有上限它能把 observation 撑爆。
- **workspace 之外的写入不列。** 脚本可以写 `metadata.pie.write` 声明的 `~/` 路径，那些 daemon **不去扫**——扫用户家目录来 diff 产物既贵又越界。文档里明说：写到 workspace 外的东西，脚本自己 print 路径。

**理由（为什么不能让脚本自己 print 清单）：** #296 的整个教训是**"约定靠作者自觉不可靠"**。如果产物清单要靠脚本 print，那它跟"脚本要记得 print 结果"是同一个会被写错的约定。daemon 扫盘得到的是**运行时事实**，不依赖任何人的自觉。它顺手把 bug 分类也变清晰了：

| stdout | 产物 | 含义 |
|--------|------|------|
| 有 | — | 正常 |
| 空 | 有 | 脚本干活了，只是没 print → 告诉 LLM 去哪读 |
| 空 | 无 | 真白跑 → 报可行动的提示 |

### D6 · 新 tool `read_skill_output` + 新 RPC

workspace 搬出 skill 目录后 `read_skill_file(skillId, "workspace/x")` 立刻失效（`safeRelPath` 把它锁死在 skillDir 内），必须新开通道。

- 扩展侧新 tool `read_skill_output({ path })`，read-class（注册进 `tool-names.ts`）。
- daemon 侧新 RPC `read_session_file({ sessionId, path })`，`safeRelPath` 锁在 `sessions/<sid>/workspace/` 内。

**附带收益：** `read_skill_file` 的语义被擦干净了——它从此只读 **skill 的内容**（指令、参考文件），产物走 `read_skill_output`。读代码和读数据是两件事，两个 tool。

**否掉的选项：**
- 复用 `output_file`（PR #145 的下载卡片）：那是 in-memory、面向**用户下载**的出口，语义完全不同，硬接会把两个出口搅在一起。
- daemon 在 run 结果里直接回带小文件内容（< 64 KB）：产物可能是二进制、可能正好 65 KB，"够不够小"不该由 daemon 猜；LLM 想看再拉是更干净的分层。

### D7 · sessionId 进 wire 和 ToolHandlerContext

daemon 现在**完全不知道 session 的存在**（`RunSkillScriptParams` 里没有 sessionId），`ToolHandlerContext` 里也没有（只有 tabId / pinMode / pinnedTabs 那几个）。D3–D6 全都依赖它，所以：

- `AgentLoopContext.sessionId`（`loop.ts` 已有）→ 透传进 `ToolHandlerContext.sessionId`
- `RunSkillScriptParams` + 新的 `ReadSessionFileParams` 都带 `sessionId`

### D8 · 产物生命周期：搭现成的车 + 时间兜底

**主路径：** `lifecycle.ts` 里 `hardDeleteSession` 和归档路径都已经在调 `deleteSessionArtifacts(id)`（清 IDB 里的 output-store 产物）。在它旁边加一个 daemon RPC `delete_session_workspace(sessionId)`，best-effort（`.catch(() => {})`，跟现有那行一样的姿态）。手动硬删和 30 天过期扫描两条路自动覆盖，零新机制。

**兜底：** 上面那条有个洞——桥没连时删 session，RPC 发不出去，目录成孤儿；用户卸载扩展，全部成孤儿。所以 **daemon 启动时扫一遍 `~/.pie/sessions/`，删掉 mtime 超过 30 天的目录。**

**否掉的选项：** 扩展把活着的 sessionId 列表同步给 daemon、让它删差集。更精确，但要新 RPC、要处理时序（扩展还没启动时 daemon 不能乱删）、还得防"扩展刚装、列表为空"把所有产物删光的事故。时间阈值笨，但它不需要 daemon 知道任何关于 session 的事，孤儿最多活 30 天，且跟扩展侧的 30 天过期天然对齐。

### D9 · observation 结构

**信任规则：产物文件名是脚本控制的，不能进 trusted 区。** 框架句（我们写的）在 wrapper 外，文件名进 wrapper。

成功且有输出：
```
<untrusted_skill_content>{stdout}</untrusted_skill_content>
Files written to the session workspace (read them with read_skill_output):
<untrusted_skill_output_list>out.csv (48 KB), raw.json (2 KB)</untrusted_skill_output_list>
```

stdout 空但有产物：
```
(script exited 0 without printing to stdout)
Files written to the session workspace (read them with read_skill_output):
<untrusted_skill_output_list>out.csv (48 KB)</untrusted_skill_output_list>
```

stdout 空且无产物（#296 踩到的那个）：
```
(script exited 0 but produced nothing: no stdout, no files written. Disk skill
scripts must print results to stdout or write files into the working directory —
a returned value is discarded.)
```

最后那句 `a returned value is discarded` 是精确打死 #296 病根的一句——作者以为 `export default` 的返回值会被拿走。

**空 outputs 时整段省略**：绝大多数脚本只 print、不写文件，那种情况下 observation 跟今天一模一样干净。这段只在真写了文件时出现，而那时它就是刚需信息，不是噪音。

**新 wrapper tag 对 LLM 零学习成本**：`prompt.ts` 里对 LLM 的说明是**通配规则**——"any tag whose name begins with `untrusted_`"，不是逐个 tag 列举。它已经天天在读现有 19 个同族 tag。

**曾经考虑、已否掉：** 把 `use_skill` 的 `refNote` / `scriptNote` 提到 untrusted wrapper 外面（理由是"它们是可信的运行时元数据"）。**这是错的**——两个 note 的内容是**文件名**，由 skill 作者（包括副根里别的 agent 装的东西）控制。提到 trusted 区等于让一个叫 `ignore-all-previous-instructions.ts` 的文件名以可信身份进 prompt。现状 `wrap(body + refNote + scriptNote)` 全量 escape，**是安全的**，`use_skill` 一行都不用改。原本要把调用约定塞进 scriptNote，是因为 tool description 分不清 origin；D1 删掉 idb/builtin 脚本路径后**只剩磁盘一种语义**，约定直接写进 tool description 即可（静态、可信、不含任何外部数据），这个问题自动消失。

### D10 · tool description 重写（单语义）

D1 之后只剩 CLI 一种语义，description 直说：`args` → `process.argv`，结果 print 到 stdout，产物写进 cwd（= session workspace），返回值会被丢弃。`input` 参数删除。

保留 `skill-script.ts` 里那段 `scripts/` 前缀剥离的容错（LLM 传 `scripts/hello.ts` 或 `hello.ts` 都能跑）——它是纯容错、无歧义（先精确后剥前缀）、成本 6 行，失败模式是"脚本跑不了 + 一次无谓往返"。删掉它省不了什么，却把一个已知的真机踩坑重新打开。

---

## 3. 目标架构

### 3.1 目录

```
~/.pie/
  skills/<name>/              # 主根：skill 内容（代码 + 指令），脚本不可写
    SKILL.md
    scripts/*.ts
  sessions/<sessionId>/
    workspace/                # 脚本 cwd + 唯一可写区（除声明过的 extraWrites）
  grants.json
  logs/audit.jsonl

~/.agents/skills/<name>/      # 只读副根：再也不会被写入（本次修复）
```

### 3.2 脚本契约（写进作者文档）

| 维度 | 约定 |
|------|------|
| 入 | `run_skill_script` 的 `args` → `process.argv` |
| 出（数据） | **stdout**，1 MB 封顶 + `truncated` 标记 |
| 出（文件） | 写进 **cwd**（= session workspace），由 daemon 列进 outputs 清单 |
| 返回值 | **丢弃**（不是 sandbox，是 CLI 进程） |
| cwd | `~/.pie/sessions/<sid>/workspace/` |
| 可写 | cwd 子树 + `metadata.pie.write` 声明的路径 |
| 可读 | 除 `denyRead` 敏感目录外皆可；skill 自身资源用 `$PIE_SKILL_DIR` |
| 网络 | 默认断；`metadata.pie.network` 声明的域名放行 |
| 超时 | 60s |
| 失败 | exitCode ≠ 0 → 错误带回 stderr 尾 2000 字 |

### 3.3 数据流

```
LLM: run_skill_script({ skillId, entry, args })
  → SW: ctx.sessionId 注入
  → daemon: run_skill_script({ name, entry, args, sessionId, grantApproved? })
      · 解析 skillDir（主根/副根都只读）
      · mkdir ~/.pie/sessions/<sid>/workspace（只在这里写）
      · grant 信封校验（不变）
      · srt: cwd = workspace, env = {PIE_SKILL_DIR, PIE_WORKSPACE}
      · run 后扫 workspace, mtime >= startedAt → outputs[]
  → SW: observation = untrusted(stdout) + 框架句 + untrusted(outputs)
LLM: read_skill_output({ path: "out.csv" })
  → daemon: read_session_file({ sessionId, path })  # safeRelPath 锁在 workspace 内
```

---

## 4. 不变量

- **I1** 脚本进程**永不写入任何 skill 目录**（主根或副根）。唯一可写区 = session workspace + 声明过的 `extraWrites`。
- **I2** `read_skill_output` 的路径解析必须经 `safeRelPath`，锁死在 `sessions/<sid>/workspace/` 内——跨 session 读、路径穿越都要 throw。
- **I3** 产物文件名与 stdout 一样是**不可信数据**，一律走 `untrusted-wrappers.ts` escape 后放进 `untrusted_*` 块。新 tag `untrusted_skill_output_list` 必须同时注册进 `UNTRUSTED_WRAPPER_TAGS`（untrusted-wrappers.ts）和 `WRAPPER_TAGS_LIST`（page-snapshot.ts）——双列表不变量。
- **I4** 每个 tool 必须在 `tool-names.ts` 声明 read/write class（build-time invariant 会 throw）。`read_skill_output` = read。
- **I5** wire 变更全部是**加法**（optional 字段 / 新 method），`PROTOCOL_VERSION` 不动。老 daemon 配新扩展：拿不到 outputs 清单，不炸。
- **I6** grant 信封语义不变——workspace 是隐含基线（不进 `extraWrites`），换了位置也仍是隐含基线，信封 hash 不受影响，已有 grant 不失效。

## 5. 已知天花板（ponytail）

- **产物无磁盘配额。** 脚本理论上能往 workspace 写 10 GB，srt 那边没有配额机制。加配额要么改 srt、要么 run 后检查（写完再删太晚），成本远超收益。靠 30 天 GC 回收。真出现失控写盘再加。
- **outputs 清单封顶 50 个文件**，超了截断并在 observation 里标记（不静默截断）。
- **产物只在 workspace 内被追踪。** 写到 `extraWrites` 声明路径的文件不在清单里，脚本自己 print。
- **mtime 判定本次产物**，不做 run 前快照 diff。边界误差最多多列一个历史文件。

## 6. 验收标准

**功能**
- 磁盘脚本 `console.log(...)` → LLM 拿到 stdout（回归）
- 磁盘脚本写文件到 cwd → observation 列出该文件 + 字节数；`read_skill_output` 能读回
- 磁盘脚本既不 print 也不写文件 → observation 给出含 "a returned value is discarded" 的可行动提示
- 跑副根（`~/.agents/skills`）的 skill 脚本 → **副根目录零写入**（本次核心修复）
- 两个 session 跑同一 skill 的同一脚本写同名文件 → 互不覆盖
- `read_skill_output` 跨 session 读 / 路径穿越 → 拒绝
- LLM 对磁盘 skill 首选 `args`，不再被 `input` / default-export 措辞误导

**清理**
- `input` 参数、`script-decl.ts`、`capabilities` frontmatter、MV3 skill sandbox、manifest `sandbox` 段与 `'unsafe-eval'` CSP 行全部消失
- 老 idb skill（SKILL.md 里带 `capabilities:`）仍能正常解析出 name/description/正文

**生命周期**
- 硬删 session → 对应 workspace 目录消失（桥连接时）
- daemon 启动 → 超 30 天的孤儿 session 目录被清理

**门禁**
- `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿
- daemon `bun test` 绿

## 7. PR 切分

**PR1 — 删死路径（纯减法，零行为变化）**
MV3 sandbox 整套、`input` 参数、`script-decl.ts`、`capabilities` frontmatter、manifest sandbox 页 + CSP。不碰任何文案（那些在 PR2 会重写）。

**PR2 — 脚本 I/O 契约（大但内聚）**
workspace 迁 session、cwd 契约、env 注入、sessionId 进 wire/ctx、`read_skill_output` tool + RPC、outputs 清单、空 stdout 提示、tool description 重写、GC、作者文档。

**不再往下拆。** 如果把 workspace 搬迁和 outputs 清单分开，中间会出现一个"产物搬走了但 LLM 读不回来"的破窗状态，比一个大 PR 更糟。PR2 虽然大，但每一块都是同一个契约的组成部分，review 时是一条线索。
